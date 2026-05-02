/**
 * Vehicle Maintenance Scheduler Microservice
 * ─────────────────────────────────────────────────────────────────────────────
 * Solves a 0/1 Knapsack problem per depot to maximise maintenance impact
 * within daily mechanic-hour budgets.
 *
 * Features
 *  • Authenticates on startup via shared logger — single token source of truth
 *  • Fetches depots + vehicles from evaluation API on every request (no stale data)
 *  • Pure bottom-up DP knapsack — no external algorithm libraries
 *  • Extensive logging at every step (debug / info / warn / error / fatal)
 *  • Rate limiting (express-rate-limit)
 *  • Circuit-breaker via shared logging middleware
 *  • Structured JSON error responses
 */

"use strict";

require("dotenv").config();

const express   = require("express");
const axios     = require("axios");
const rateLimit = require("express-rate-limit");
const logger    = require("../logging_middleware/index");

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Evaluation API URLs ──────────────────────────────────────────────────────
const BASE_URL     = "http://20.207.122.201/evaluation-service";
const DEPOTS_URL   = `${BASE_URL}/depots`;
const VEHICLES_URL = `${BASE_URL}/vehicles`;

// ─── Auth token resolver ──────────────────────────────────────────────────────
// logger.authenticate() is called at startup and holds the only valid token.
// logger.getToken() is the safe public getter — never access logger._token directly.
function getAuthToken() {
  return logger.getToken() || null;
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60_000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: async (req, res) => {
    await logger.warn("middleware", `Rate limit: ${req.ip}`);
    res.status(429).json({ success: false, error: "Too many requests. Please wait." });
  },
});

// ─── Global middleware ────────────────────────────────────────────────────────
app.use(express.json());
app.use(limiter);
app.use(logger.requestLogger);

// ─── 0/1 Knapsack — pure DP, no external libraries ───────────────────────────
/**
 * Bottom-up 0/1 Knapsack.
 * Time:  O(n × W)
 * Space: O(n × W) for the keep table (backtracking)
 *
 * @param {Array<{TaskID: string, Duration: number, Impact: number}>} items
 * @param {number} capacity  mechanic-hours budget
 * @returns {{ selectedTasks, totalImpact, totalDuration }}
 */
function knapsack(items, capacity) {
  const n = items.length;

  const dp   = new Array(capacity + 1).fill(0);
  const keep = new Array(n);
  for (let i = 0; i < n; i++) keep[i] = new Uint8Array(capacity + 1);

  for (let i = 0; i < n; i++) {
    const wt  = items[i].Duration;
    const val = items[i].Impact;

    // Right-to-left traversal enforces 0/1 (no item reuse)
    for (let w = capacity; w >= wt; w--) {
      if (dp[w - wt] + val > dp[w]) {
        dp[w]      = dp[w - wt] + val;
        keep[i][w] = 1;
      }
    }
  }

  // Backtrack to recover selected items
  const selected = [];
  let w = capacity;
  for (let i = n - 1; i >= 0; i--) {
    if (keep[i][w]) {
      selected.push(items[i]);
      w -= items[i].Duration;
    }
  }

  return {
    selectedTasks: selected,
    totalImpact:   dp[capacity],
    totalDuration: selected.reduce((s, t) => s + t.Duration, 0),
  };
}

// ─── Data fetching helpers ────────────────────────────────────────────────────
async function fetchDepots() {
  await logger.debug("service", "Fetching depots...");
  try {
    const res = await axios.get(DEPOTS_URL, {
      timeout: 10_000,
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });

    const depots = res.data.depots;
    await logger.info("service", `Fetched ${depots.length} depots`);
    return depots;
  } catch (err) {
    await logger.error("service", `Depots fetch failed: ${err.message}`);
    throw err;
  }
}

async function fetchVehicles() {
  await logger.debug("service", "Fetching vehicles...");
  try {
    const res = await axios.get(VEHICLES_URL, {
      timeout: 10_000,
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });

    const vehicles = res.data.vehicles;
    await logger.info("service", `Fetched ${vehicles.length} vehicles`);
    return vehicles;
  } catch (err) {
    await logger.error("service", `Vehicles fetch failed: ${err.message}`);
    throw err;
  }
}

// ─── Schedule computation ─────────────────────────────────────────────────────
function computeDepotSchedule(depot, vehicles) {
  const result = knapsack(vehicles, depot.MechanicHours);
  return {
    depotID:        depot.ID,
    mechanicHours:  depot.MechanicHours,
    totalImpact:    result.totalImpact,
    totalDuration:  result.totalDuration,
    remainingHours: depot.MechanicHours - result.totalDuration,
    efficiency:     depot.MechanicHours > 0
                      ? ((result.totalDuration / depot.MechanicHours) * 100).toFixed(1) + "%"
                      : "0%",
    taskCount:      result.selectedTasks.length,
    selectedTasks:  result.selectedTasks,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** GET /health */
app.get("/health", async (req, res) => {
  await logger.info("handler", "GET /health");
  res.json({
    success:   true,
    status:    "ok",
    service:   "vehicle-maintenance-scheduler",
    timestamp: new Date().toISOString(),
  });
});

/** GET /schedule — optimal schedule for ALL depots */
app.get("/schedule", async (req, res) => {
  await logger.info("handler", "GET /schedule all depots");
  try {
    await logger.debug("handler", "Fetching depots+vehicles");
    const [depots, vehicles] = await Promise.all([fetchDepots(), fetchVehicles()]);

    await logger.info("service",
      `Knapsack: ${depots.length} depots x ${vehicles.length} vehicles`);

    const schedule = [];
    for (const depot of depots) {
      await logger.debug("service", `Scheduling depot ${depot.ID}`);

      const result = computeDepotSchedule(depot, vehicles);
      schedule.push(result);

      await logger.info("service",
        `Depot ${depot.ID}: ${result.taskCount} tasks ${result.efficiency}`);
    }

    const grandTotalImpact   = schedule.reduce((s, d) => s + d.totalImpact, 0);
    const grandTotalDuration = schedule.reduce((s, d) => s + d.totalDuration, 0);

    await logger.info("handler",
      `Schedule done. impact=${grandTotalImpact}`);

    return res.json({
      success: true,
      depotCount: depots.length,
      vehicleCount: vehicles.length,
      grandTotalImpact,
      grandTotalDuration,
      schedule,
    });
  } catch (err) {
    await logger.error("handler", `Schedule failed: ${err.message}`);
    return res.status(502).json({
      success: false,
      error:   "Failed to fetch data from evaluation API",
      detail:  err.message,
    });
  }
});

/** GET /schedule/:depotId — optimal schedule for a single depot */
app.get("/schedule/:depotId", async (req, res) => {
  const raw     = req.params.depotId;
  const depotId = parseInt(raw, 10);

  if (isNaN(depotId) || depotId <= 0) {
    await logger.warn("handler", `Invalid depot ID: ${raw}`);
    return res.status(400).json({ success: false, error: `Invalid depot ID: "${raw}"` });
  }

  await logger.info("handler", `GET /schedule/${depotId}`);
  try {
    const [depots, vehicles] = await Promise.all([fetchDepots(), fetchVehicles()]);
    const depot = depots.find((d) => d.ID === depotId);

    if (!depot) {
      await logger.warn("handler", `Depot ${depotId} not found`);
      return res.status(404).json({
        success:         false,
        error:           `Depot ${depotId} not found`,
        availableDepots: depots.map((d) => d.ID),
      });
    }

    await logger.debug("service",
      `Depot ${depotId}: budget=${depot.MechanicHours}h`);

    const result = computeDepotSchedule(depot, vehicles);

    await logger.info("service",
      `Depot ${depotId}: ${result.taskCount} tasks impact=${result.totalImpact}`);

    return res.json({ success: true, ...result });
  } catch (err) {
    await logger.error("handler", `Schedule/${depotId} failed: ${err.message}`);
    return res.status(502).json({
      success: false,
      error:   "Failed to fetch data from evaluation API",
      detail:  err.message,
    });
  }
});

/** GET /depots */
app.get("/depots", async (req, res) => {
  await logger.info("handler", "GET /depots");
  try {
    const depots = await fetchDepots();
    return res.json({ success: true, count: depots.length, depots });
  } catch (err) {
    await logger.error("handler", `GET /depots failed: ${err.message}`);
    return res.status(502).json({ success: false, error: err.message });
  }
});

/** GET /vehicles */
app.get("/vehicles", async (req, res) => {
  await logger.info("handler", "GET /vehicles");
  try {
    const vehicles = await fetchVehicles();
    return res.json({ success: true, count: vehicles.length, vehicles });
  } catch (err) {
    await logger.error("handler", `GET /vehicles failed: ${err.message}`);
    return res.status(502).json({ success: false, error: err.message });
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use(async (req, res) => {
  await logger.warn("handler", `404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    error:   `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use(async (err, req, res, _next) => {
  await logger.fatal("handler", `Unhandled: ${req.method} ${req.originalUrl}`);
  res.status(500).json({ success: false, error: "Internal server error", detail: err.message });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  console.log("[scheduler] Starting Vehicle Maintenance Scheduler...");

  // All sensitive values from .env — never hardcoded in source
  const credentials = {
    email:        process.env.EMAIL,
    name:         process.env.NAME,
    rollNo:       process.env.ROLL_NO,
    accessCode:   process.env.ACCESS_CODE,
    clientID:     process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  };

  try {
    // authenticate() stores the token inside the logger.
    // getAuthToken() → logger.getToken() is the single source of truth
    // for all subsequent axios calls — no separate ACCESS_TOKEN needed.
    await logger.authenticate(credentials);
    console.log("[scheduler] Authentication successful");
  } catch (err) {
    console.error("[scheduler] Auth failed — logs queue until token set:", err.message);
  }

  app.listen(PORT, () => {
    console.log(`[scheduler] Running on http://localhost:${PORT}`);
    console.log("[scheduler] Endpoints:");
    console.log(`  GET http://localhost:${PORT}/health`);
    console.log(`  GET http://localhost:${PORT}/depots`);
    console.log(`  GET http://localhost:${PORT}/vehicles`);
    console.log(`  GET http://localhost:${PORT}/schedule`);
    console.log(`  GET http://localhost:${PORT}/schedule/:depotId`);
  });
}

start();

module.exports = app;