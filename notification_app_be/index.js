/**
 * Campus Notifications Microservice — Backend
 * ─────────────────────────────────────────────────────────────────────────────
 * Stages covered:
 *   1  REST API design + WebSocket real-time push
 *   2  In-memory store (swap Map → Postgres in production)
 *   3  Optimised queries + placement/recent endpoint
 *   4  Caching layer (in-memory TTL cache, rate limiting)
 *   5  Async broadcast with retry queue + dead-letter queue (DLQ)
 *   6  Top-N unread via Min-Heap — O(log N) per insert
 *
 * Bonus:
 *   • Rate limiting (express-rate-limit)
 *   • Circuit breaker (in shared logger)
 *   • Retry mechanism with exponential back-off
 *   • Structured JSON errors on every route
 *   • requestLogger middleware on every request
 */

"use strict";

const express    = require("express");
const http       = require("http");
const { WebSocketServer, OPEN } = require("ws");
const axios      = require("axios");
const { v4: uuid } = require("uuid");
const rateLimit  = require("express-rate-limit");
const logger     = require("../logging_middleware/index");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3002;

const NOTIFICATION_API = "http://20.207.122.201/evaluation-service/notifications";

// ─── Type priority weights (Stage 6) ─────────────────────────────────────────
const TYPE_WEIGHT = { Placement: 3, Result: 2, Event: 1 };

// ─── In-memory store ─────────────────────────────────────────────────────────
// Production: replace with Postgres + Redis
const store = new Map(); // id → notification

// ─── TTL Cache (Stage 4) ─────────────────────────────────────────────────────
const _cache     = new Map(); // key → { value, expiresAt }
const CACHE_TTL  = 30_000;   // 30 seconds

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
}
function cacheInvalidate(pattern) {
  for (const k of _cache.keys()) {
    if (k.startsWith(pattern)) _cache.delete(k);
  }
}

// ─── Min-Heap for Top-N (Stage 6) ────────────────────────────────────────────
/**
 * A min-heap keyed on priority score.
 * Insert: O(log n), extractMin: O(log n), peek: O(1)
 * Used to maintain the top-N highest-priority notifications in O(n log N) time.
 */
class MinHeap {
  constructor(maxSize) {
    this._heap    = [];
    this._maxSize = maxSize;
  }

  _parent(i)  { return Math.floor((i - 1) / 2); }
  _left(i)    { return 2 * i + 1; }
  _right(i)   { return 2 * i + 2; }
  _score(i)   { return this._heap[i]._score; }

  _swap(i, j) {
    [this._heap[i], this._heap[j]] = [this._heap[j], this._heap[i]];
  }

  _bubbleUp(i) {
    while (i > 0 && this._score(i) < this._score(this._parent(i))) {
      this._swap(i, this._parent(i));
      i = this._parent(i);
    }
  }

  _sinkDown(i) {
    const n = this._heap.length;
    let smallest = i;
    const l = this._left(i), r = this._right(i);
    if (l < n && this._score(l) < this._score(smallest)) smallest = l;
    if (r < n && this._score(r) < this._score(smallest)) smallest = r;
    if (smallest !== i) { this._swap(i, smallest); this._sinkDown(smallest); }
  }

  push(item) {
    if (this._heap.length < this._maxSize) {
      this._heap.push(item);
      this._bubbleUp(this._heap.length - 1);
    } else if (item._score > this._score(0)) {
      // Replace the lowest-priority item
      this._heap[0] = item;
      this._sinkDown(0);
    }
    // else: item is lower priority than all in heap — discard
  }

  /** Return all items sorted highest-score first */
  toSortedArray() {
    return [...this._heap].sort((a, b) => b._score - a._score);
  }

  get size() { return this._heap.length; }
}

function priorityScore(notification) {
  const typeWeight = TYPE_WEIGHT[notification.type] || 0;
  const ageMs      = Date.now() - new Date(notification.timestamp).getTime();
  const recency    = 1 / (1 + ageMs / 60_000); // decays over minutes
  return typeWeight + recency;
}

// ─── Dead-Letter Queue (Stage 5) ─────────────────────────────────────────────
const DLQ = []; // Failed broadcast jobs after max retries

// ─── WebSocket helpers ───────────────────────────────────────────────────────
function broadcast(data) {
  const payload = JSON.stringify(data);
  let count = 0;
  wss.clients.forEach((ws) => {
    if (ws.readyState === OPEN) { ws.send(payload); count++; }
  });
  return count;
}

wss.on("connection", async (ws, req) => {
  await logger.info("middleware", `WebSocket client connected from ${req.socket.remoteAddress}`);
  ws.send(JSON.stringify({ event: "connected", message: "Real-time notifications active" }));

  ws.on("message", async (raw) => {
    await logger.debug("middleware", `WebSocket message received: ${raw}`);
  });
  ws.on("close", async () => {
    await logger.info("middleware", "WebSocket client disconnected");
  });
  ws.on("error", async (err) => {
    await logger.error("middleware", `WebSocket error: ${err.message}`);
  });
});

// ─── Global middleware ────────────────────────────────────────────────────────
app.use(express.json());
app.use(logger.requestLogger); // Logs every HTTP request/response

// Rate limiter: 100 req/min per IP
app.use(rateLimit({
  windowMs: 60_000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: async (req, res) => {
    await logger.warn("middleware", `Rate limit exceeded: ${req.ip} → ${req.originalUrl}`);
    res.status(429).json({ success: false, error: "Rate limit exceeded. Try again in a minute." });
  },
}));

// ─── Seed from API on startup ────────────────────────────────────────────────
async function seedFromAPI() {
  await logger.info("service", "Seeding notifications from evaluation API...");
  try {
    const res  = await axios.get(NOTIFICATION_API, { timeout: 10_000 });
    const list = res.data.notifications;
    for (const n of list) {
      store.set(n.ID, {
        id:        n.ID,
        type:      n.Type,
        message:   n.Message,
        timestamp: n.Timestamp,
        isRead:    false,
        studentID: null,
      });
    }
    await logger.info("service", `Seeded ${list.length} notifications successfully`);
  } catch (err) {
    await logger.error("service", `Seed failed: ${err.message}`);
    console.warn("[notifications] Could not seed from API:", err.message);
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** GET /health */
app.get("/health", async (req, res) => {
  await logger.info("handler", "GET /health");
  res.json({
    success:        true,
    status:         "ok",
    service:        "notification-backend",
    notificationCount: store.size,
    wsClients:      wss.clients.size,
    dlqSize:        DLQ.length,
    timestamp:      new Date().toISOString(),
  });
});

/**
 * GET /notifications
 * Stage 1 — list all with optional filters
 * Stage 4 — TTL-cached response
 */
app.get("/notifications", async (req, res) => {
  const { type, isRead, studentID, limit = 50, offset = 0 } = req.query;
  await logger.info("handler",
    `GET /notifications type=${type||"*"} isRead=${isRead||"*"} studentID=${studentID||"*"}`);

  const cacheKey = `notifications:${type}:${isRead}:${studentID}:${limit}:${offset}`;
  const cached   = cacheGet(cacheKey);
  if (cached) {
    await logger.debug("cache", `Cache HIT for key: ${cacheKey}`);
    return res.json({ ...cached, cached: true });
  }
  await logger.debug("cache", `Cache MISS for key: ${cacheKey}`);

  let list = [...store.values()];

  if (type)              list = list.filter((n) => n.type === type);
  if (isRead !== undefined) list = list.filter((n) => String(n.isRead) === isRead);
  if (studentID)         list = list.filter((n) => n.studentID === studentID || n.studentID === null);

  list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const total      = list.length;
  const paginated  = list.slice(Number(offset), Number(offset) + Number(limit));

  const payload = { success: true, total, count: paginated.length, notifications: paginated };
  cacheSet(cacheKey, payload);

  await logger.debug("handler", `Returning ${paginated.length}/${total} notifications`);
  return res.json(payload);
});

/**
 * GET /notifications/top
 * Stage 6 — top-N unread by priority using MinHeap
 */
app.get("/notifications/top", async (req, res) => {
  const N         = Math.min(parseInt(req.query.n) || 5, 100);
  const studentID = req.query.studentID;
  await logger.info("handler", `GET /notifications/top n=${N} studentID=${studentID||"*"}`);

  try {
    let candidates = [...store.values()].filter((n) => !n.isRead);
    if (studentID) candidates = candidates.filter((n) => n.studentID === studentID || n.studentID === null);

    await logger.debug("service", `Top-N: evaluating ${candidates.length} unread candidates`);

    // Build min-heap of size N — O(m log N) where m = candidate count
    const heap = new MinHeap(N);
    for (const n of candidates) {
      heap.push({ ...n, _score: priorityScore(n) });
    }

    const topN = heap.toSortedArray().map(({ _score, ...n }) => ({
      ...n,
      priorityScore: _score.toFixed(4),
      typeWeight:    TYPE_WEIGHT[n.type] || 0,
    }));

    await logger.info("handler", `Returning top ${topN.length} unread notifications`);
    return res.json({ success: true, n: N, count: topN.length, topN });

  } catch (err) {
    await logger.error("handler", `GET /notifications/top failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /notifications/placement/recent
 * Stage 3 — placements in last 7 days
 */
app.get("/notifications/placement/recent", async (req, res) => {
  await logger.info("handler", "GET /notifications/placement/recent");

  // SQL equivalent (Stage 3):
  // SELECT DISTINCT s.id, s.name, s.email
  // FROM students s
  // JOIN student_notifications sn ON sn.student_id = s.id
  // JOIN notifications n ON n.id = sn.notification_id
  // WHERE n.type = 'Placement' AND sn.delivered_at >= NOW() - INTERVAL '7 days'
  // ORDER BY s.id;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await logger.debug("service", `Filtering placements since ${sevenDaysAgo.toISOString()}`);

  const recent = [...store.values()].filter((n) =>
    n.type === "Placement" && new Date(n.timestamp) >= sevenDaysAgo
  );

  await logger.info("handler",
    `Found ${recent.length} placement notifications in the last 7 days`);

  return res.json({ success: true, count: recent.length, since: sevenDaysAgo.toISOString(), notifications: recent });
});

/**
 * GET /notifications/dlq
 * Inspect failed broadcast jobs
 */
app.get("/notifications/dlq", async (req, res) => {
  await logger.info("handler", `GET /notifications/dlq — ${DLQ.length} items`);
  res.json({ success: true, count: DLQ.length, dlq: DLQ });
});

/**
 * GET /notifications/:id
 */
app.get("/notifications/:id", async (req, res) => {
  const { id } = req.params;
  await logger.info("handler", `GET /notifications/${id}`);

  const n = store.get(id);
  if (!n) {
    await logger.warn("handler", `Notification not found: ${id}`);
    return res.status(404).json({ success: false, error: "Notification not found" });
  }
  await logger.debug("handler", `Returning notification ${id} type=${n.type}`);
  return res.json({ success: true, notification: n });
});

/**
 * POST /notifications
 * Stage 1 — create + real-time WebSocket broadcast
 */
app.post("/notifications", async (req, res) => {
  await logger.info("handler", "POST /notifications — create notification");
  const { type, message, studentID } = req.body;

  if (!type || !message) {
    await logger.warn("handler", "POST /notifications — validation failed: missing type or message");
    return res.status(400).json({ success: false, error: "type and message are required" });
  }
  if (!TYPE_WEIGHT[type]) {
    await logger.warn("handler", `POST /notifications — invalid type: "${type}"`);
    return res.status(400).json({
      success: false,
      error:   `type must be one of: ${Object.keys(TYPE_WEIGHT).join(", ")}`,
    });
  }

  const notification = {
    id:        uuid(),
    type,
    message,
    timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    isRead:    false,
    studentID: studentID || null,
  };

  store.set(notification.id, notification);
  cacheInvalidate("notifications:");
  await logger.info("service",
    `Notification created: id=${notification.id} type=${type} studentID=${studentID||"global"}`);

  const wsCount = broadcast({ event: "new_notification", notification });
  await logger.debug("service", `WebSocket broadcast sent to ${wsCount} client(s)`);

  return res.status(201).json({ success: true, notification });
});

/**
 * PATCH /notifications/:id/read
 */
app.patch("/notifications/:id/read", async (req, res) => {
  const { id } = req.params;
  await logger.info("handler", `PATCH /notifications/${id}/read`);

  const n = store.get(id);
  if (!n) {
    await logger.warn("handler", `PATCH read — notification not found: ${id}`);
    return res.status(404).json({ success: false, error: "Notification not found" });
  }

  n.isRead  = true;
  n.readAt  = new Date().toISOString();
  store.set(id, n);
  cacheInvalidate("notifications:");

  await logger.info("service", `Notification ${id} marked as read at ${n.readAt}`);
  return res.json({ success: true, notification: n });
});

/**
 * DELETE /notifications/:id
 */
app.delete("/notifications/:id", async (req, res) => {
  const { id } = req.params;
  await logger.info("handler", `DELETE /notifications/${id}`);

  if (!store.has(id)) {
    await logger.warn("handler", `DELETE — notification not found: ${id}`);
    return res.status(404).json({ success: false, error: "Notification not found" });
  }

  store.delete(id);
  cacheInvalidate("notifications:");
  await logger.info("service", `Notification ${id} deleted`);
  return res.json({ success: true, message: "Notification deleted" });
});

/**
 * POST /notifications/broadcast
 * Stage 5 — Reliable async bulk notify
 *
 * Problems with naive sequential approach:
 *   1. Sequential loop — 10k students × email latency = minutes of blocking
 *   2. No error isolation — one failure stops the rest
 *   3. Email + DB tightly coupled — SMTP failure prevents DB write
 *   4. No retry — 200 failures silently lost
 *
 * This implementation:
 *   ✓ Returns 202 immediately (non-blocking)
 *   ✓ Processes in parallel batches of 50
 *   ✓ DB write happens BEFORE email (durable first)
 *   ✓ Email failure retries with exponential back-off (3 attempts)
 *   ✓ Still-failed items go to DLQ for ops review
 *   ✓ WebSocket push is fire-and-forget (doesn't block DB)
 */
app.post("/notifications/broadcast", async (req, res) => {
  await logger.info("handler", "POST /notifications/broadcast");
  const { type, message, studentIDs } = req.body;

  if (!type || !message || !Array.isArray(studentIDs) || studentIDs.length === 0) {
    await logger.warn("handler", "POST /broadcast — validation failed");
    return res.status(400).json({
      success: false,
      error:   "type, message, and a non-empty studentIDs[] are required",
    });
  }
  if (!TYPE_WEIGHT[type]) {
    return res.status(400).json({ success: false, error: `Invalid type: "${type}"` });
  }

  const jobId     = uuid();
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  await logger.info("service",
    `Broadcast job ${jobId}: type=${type}, recipients=${studentIDs.length}`);

  // ── Respond immediately ────────────────────────────────────────────────────
  res.status(202).json({
    success:    true,
    jobId,
    message:    `Broadcast accepted. Processing ${studentIDs.length} recipients asynchronously.`,
    trackAt:    `/notifications/dlq`,
  });

  // ── Async processing (after response sent) ─────────────────────────────────
  setImmediate(async () => {
    const BATCH_SIZE   = 50;
    const MAX_RETRIES  = 3;
    const stats        = { sent: 0, failed: 0 };

    await logger.debug("service", `Job ${jobId}: starting async processing in batches of ${BATCH_SIZE}`);

    for (let i = 0; i < studentIDs.length; i += BATCH_SIZE) {
      const batch = studentIDs.slice(i, i + BATCH_SIZE);
      await logger.debug("service",
        `Job ${jobId}: processing batch ${Math.floor(i / BATCH_SIZE) + 1}, students ${i + 1}–${i + batch.length}`);

      await Promise.allSettled(batch.map(async (studentID) => {
        // STEP 1: Write to DB first (durable, synchronous within this task)
        const n = {
          id: uuid(), type, message, timestamp,
          isRead: false, studentID,
        };
        store.set(n.id, n);
        await logger.debug("db", `Saved notification ${n.id} for student ${studentID}`);

        // STEP 2: WebSocket push (fire-and-forget, doesn't block)
        broadcast({ event: "new_notification", notification: n });

        // STEP 3: Simulate email with retry + exponential back-off
        // In production: call your SMTP/SES client here
        let emailSent = false;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            // Simulate email send (replace with real call)
            await simulateEmail(studentID, type, message);
            emailSent = true;
            await logger.info("service",
              `Email sent to student ${studentID} (attempt ${attempt})`);
            break;
          } catch (err) {
            const delay = 200 * 2 ** (attempt - 1);
            await logger.warn("service",
              `Email attempt ${attempt}/${MAX_RETRIES} failed for student ${studentID}: ${err.message}. Retry in ${delay}ms`);
            if (attempt < MAX_RETRIES) await sleep(delay);
          }
        }

        if (!emailSent) {
          stats.failed++;
          DLQ.push({ jobId, studentID, type, message, failedAt: new Date().toISOString() });
          await logger.error("service",
            `All ${MAX_RETRIES} email attempts failed for student ${studentID}. Moved to DLQ.`);
        } else {
          stats.sent++;
        }
      }));

      cacheInvalidate("notifications:");
    }

    await logger.info("service",
      `Job ${jobId} complete: sent=${stats.sent}, failed=${stats.failed}, dlqSize=${DLQ.length}`);

    if (stats.failed > 0) {
      await logger.warn("service",
        `Job ${jobId}: ${stats.failed} students in DLQ. Review GET /notifications/dlq`);
    }
  });
});

// ─── POST /notifications/dlq/retry ───────────────────────────────────────────
// Retry all failed DLQ items
app.post("/notifications/dlq/retry", async (req, res) => {
  await logger.info("handler", `POST /notifications/dlq/retry — ${DLQ.length} items in DLQ`);

  if (DLQ.length === 0) {
    return res.json({ success: true, message: "DLQ is empty" });
  }

  const items = DLQ.splice(0);
  res.status(202).json({ success: true, message: `Retrying ${items.length} DLQ items` });

  setImmediate(async () => {
    for (const item of items) {
      try {
        await simulateEmail(item.studentID, item.type, item.message);
        await logger.info("service", `DLQ retry successful for student ${item.studentID}`);
      } catch (err) {
        DLQ.push({ ...item, retryFailedAt: new Date().toISOString() });
        await logger.error("service", `DLQ retry failed again for student ${item.studentID}: ${err.message}`);
      }
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Simulated email sender — replace with real SMTP/SES call in production */
async function simulateEmail(studentID, type, message) {
  // Simulate 5% failure rate for realism
  if (Math.random() < 0.05) throw new Error("SMTP connection timeout");
  // Simulate network latency
  await sleep(10);
}

// ─── 404 catch-all ───────────────────────────────────────────────────────────
app.use(async (req, res) => {
  await logger.warn("handler", `404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use(async (err, req, res, _next) => {
  await logger.fatal("handler", `Unhandled: ${req.method} ${req.originalUrl} — ${err.message}`);
  res.status(500).json({ success: false, error: "Internal server error", detail: err.message });
});

// ─── Startup ─────────────────────────────────────────────────────────────────
async function start() {
  console.log("[notifications] Starting Campus Notifications Backend...");

  // ── AUTH FLOW ──────────────────────────────────────────────────────────────
  // Replace with your actual credentials from registration
const credentials = {
    email:        "jayanth_jagu@srmap.edu.in",
    name:         "jayanth jagu",
    rollNo:       "ap23110011425",
    accessCode:   "QkbpxH",
    clientID:     "0f0cf1cd-e5ee-4fec-a2f5-926dfa2dff79",
    clientSecret: "JkkwhBuCzgEBbetc",
};
  try {
    await logger.authenticate(credentials);
    console.log("[notifications] Authentication successful");
  } catch (err) {
    console.error("[notifications] Auth failed — logs will queue:", err.message);
  }

  await seedFromAPI();

  server.listen(PORT, () => {
    console.log(`[notifications] HTTP  → http://localhost:${PORT}`);
    console.log(`[notifications] WS    → ws://localhost:${PORT}`);
    console.log("[notifications] Endpoints:");
    console.log(`  GET  /health`);
    console.log(`  GET  /notifications`);
    console.log(`  GET  /notifications/top?n=5`);
    console.log(`  GET  /notifications/placement/recent`);
    console.log(`  GET  /notifications/dlq`);
    console.log(`  GET  /notifications/:id`);
    console.log(`  POST /notifications`);
    console.log(`  POST /notifications/broadcast`);
    console.log(`  POST /notifications/dlq/retry`);
    console.log(`  PATCH /notifications/:id/read`);
    console.log(`  DELETE /notifications/:id`);
  });
}

start();

module.exports = { app, server };
