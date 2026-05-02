/**
 * Logging Middleware
 * Production-grade: validates fields, retries on failure, circuit-breaker,
 * in-memory queue to prevent log loss on transient errors.
 */

"use strict";

const axios = require("axios");

// ─── Constants ───────────────────────────────────────────────────────────────
const BASE_URL = "http://20.207.122.201/evaluation-service";
const LOG_URL  = `${BASE_URL}/logs`;
const AUTH_URL = `${BASE_URL}/auth`;

const VALID_STACKS   = ["backend", "frontend"];
const VALID_LEVELS   = ["debug", "info", "warn", "error", "fatal"];
const VALID_PACKAGES = {
  backend:  ["cache", "controller", "cron_job", "db", "domain", "handler",
             "repository", "route", "service", "auth", "config", "middleware", "utils"],
  frontend: ["api", "component", "hook", "page", "state", "style",
             "auth", "config", "middleware", "utils"],
};

const MAX_QUEUE_SIZE = 1000;

// ─── State ───────────────────────────────────────────────────────────────────
let _token          = null;
let _tokenExpiresAt = 0;
let _credentials    = null;

const CB = {
  failures:      0,
  lastFailureAt: 0,
  state:         "CLOSED",
  threshold:     5,
  cooldownMs:    30_000,
};

const _retryQueue = [];
let   _flushTimer = null;

// ─── Internal console helper ──────────────────────────────────────────────────
const _IS_DEV = (process.env.NODE_ENV || "development") !== "production";

function _console(level, ...args) {
  switch (level) {
    case "debug": if (_IS_DEV) console.debug("[logger]",       ...args); break;
    case "info":  if (_IS_DEV) console.info ("[logger]",       ...args); break;
    case "warn":               console.warn ("[logger]",       ...args); break;
    case "error":              console.error("[logger]",       ...args); break;
    case "fatal":              console.error("[logger] FATAL", ...args); break;
  }
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
function cbOnSuccess() {
  CB.failures = 0;
  CB.state    = "CLOSED";
}

function cbOnFailure() {
  CB.failures++;
  CB.lastFailureAt = Date.now();
  if (CB.failures >= CB.threshold) {
    CB.state = "OPEN";
    _console("warn", `Circuit OPEN after ${CB.failures} failures. Cooldown ${CB.cooldownMs}ms`);
  }
}

function cbIsAllowed() {
  if (CB.state === "CLOSED")    return true;
  if (CB.state === "HALF_OPEN") return true;
  if (Date.now() - CB.lastFailureAt >= CB.cooldownMs) {
    CB.state = "HALF_OPEN";
    _console("info", "Circuit HALF_OPEN — attempting probe request");
    return true;
  }
  return false;
}

// ─── Token management ─────────────────────────────────────────────────────────
function getToken() {
  return _token;
}

function setAuthToken(token, expiresIn) {
  _token          = token;
  _tokenExpiresAt = expiresIn ? expiresIn * 1000 : Date.now() + 3_600_000;
}

async function authenticate(creds) {
  _credentials = creds;
  _console("info", "Authenticating with evaluation service...");
  try {
    const res = await axios.post(AUTH_URL, creds, { timeout: 10_000 });
    const { access_token, expires_in } = res.data;
    setAuthToken(access_token, expires_in);
    _console("info", "Authentication successful. Token valid until",
      new Date(_tokenExpiresAt).toISOString());
    return access_token;
  } catch (err) {
    const msg = err.response?.data || err.message;
    _console("error", "Authentication failed:", msg);
    throw new Error(`Logger authentication failed: ${JSON.stringify(msg)}`);
  }
}

async function _ensureToken() {
  if (_token && Date.now() < _tokenExpiresAt - 60_000) return true;
  if (!_credentials) {
    _console("warn", "_ensureToken: no credentials stored — call authenticate() first");
    return false;
  }
  try {
    await authenticate(_credentials);
    return true;
  } catch (err) {
    _console("error", "_ensureToken: re-authentication failed:", err.message);
    return false;
  }
}

// ─── Queue helpers ────────────────────────────────────────────────────────────
function _enqueue(payload) {
  if (_retryQueue.length >= MAX_QUEUE_SIZE) {
    _console("warn", `Retry queue full (${MAX_QUEUE_SIZE}). Dropping oldest log entry.`);
    _retryQueue.shift();
  }
  _retryQueue.push(payload);
  _scheduleFlush();
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(async () => {
    _flushTimer = null;
    await _flushQueue();
  }, CB.cooldownMs + 1_000);
}

async function _flushQueue() {
  if (_retryQueue.length === 0) return;
  _console("info", `Flushing ${_retryQueue.length} queued log(s)...`);
  const items = _retryQueue.splice(0);
  for (const item of items) {
    await _sendLog(item, 2).catch(() => {});
  }
}

// ─── Core send ────────────────────────────────────────────────────────────────
async function _sendLog(payload, maxRetries = 3) {
  if (!cbIsAllowed()) {
    _enqueue(payload);
    _console("warn", "Circuit OPEN — log queued:", payload.level, payload.package);
    return null;
  }

  if (!_token) {
    _console("warn", "No auth token available — log queued until token is set");
    _enqueue(payload);
    return null;
  }

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tokenReady = await _ensureToken();
      if (!tokenReady) {
        _console("warn", "Token unavailable — log queued");
        _enqueue(payload);
        return null;
      }

      const res = await axios.post(LOG_URL, payload, {
        timeout: 8_000,
        headers: {
          Authorization:  `Bearer ${_token}`,
          "Content-Type": "application/json",
          "X-Request-ID": `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        },
      });
      cbOnSuccess();
      return res.data;
    } catch (err) {
      lastErr = err;
      cbOnFailure();

      // ── KEY FIX: log the actual API response body, not just err.message ──
      // This exposes exactly what field the evaluation API is rejecting,
      // instead of just showing "Request failed with status code 400" forever.
      const apiDetail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;

      const delay = Math.min(200 * 2 ** (attempt - 1), 4_000);
      _console("warn",
        `Log attempt ${attempt}/${maxRetries} failed [${err.response?.status ?? "ERR"}]: ` +
        `${apiDetail}. Payload: ${JSON.stringify(payload)}. Retry in ${delay}ms`);

      if (attempt < maxRetries) await _sleep(delay);
    }
  }

  _enqueue(payload);
  _console("error", "All retries exhausted. Log queued. Last error:",
    lastErr?.response?.data ?? lastErr?.message);
  return null;
}

// ─── Validation ───────────────────────────────────────────────────────────────
function _validate(stack, level, pkg) {
  const s = (stack || "").toLowerCase();
  const l = (level || "").toLowerCase();
  const p = (pkg   || "").toLowerCase();

  if (!VALID_STACKS.includes(s))
    throw new Error(`Invalid stack "${s}". Allowed: ${VALID_STACKS.join(", ")}`);
  if (!VALID_LEVELS.includes(l))
    throw new Error(`Invalid level "${l}". Allowed: ${VALID_LEVELS.join(", ")}`);
  if (!VALID_PACKAGES[s].includes(p))
    throw new Error(`Invalid package "${p}" for stack "${s}". Allowed: ${VALID_PACKAGES[s].join(", ")}`);

  return { s, l, p };
}

// ─── Public API ───────────────────────────────────────────────────────────────
async function Log(stack, level, pkg, message) {
  let validated;
  try {
    validated = _validate(stack, level, pkg);
  } catch (validationErr) {
    _console("error", "Validation error:", validationErr.message);
    return null;
  }

  const payload = {
    stack:   validated.s,
    level:   validated.l,
    package: validated.p,
    message: String(message),
  };

  return _sendLog(payload);
}

const debug = (pkg, msg) => Log("backend", "debug", pkg, msg);
const info  = (pkg, msg) => Log("backend", "info",  pkg, msg);
const warn  = (pkg, msg) => Log("backend", "warn",  pkg, msg);
const error = (pkg, msg) => Log("backend", "error", pkg, msg);
const fatal = (pkg, msg) => Log("backend", "fatal", pkg, msg);

function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, originalUrl, ip } = req;

  Log("backend", "info", "middleware",
    `Incoming ${method} ${originalUrl} from ${ip}`).catch(() => {});

  res.on("finish", () => {
    const ms    = Date.now() - start;
    const level = res.statusCode >= 500 ? "error"
                : res.statusCode >= 400 ? "warn"
                : "info";
    Log("backend", level, "middleware",
      `${method} ${originalUrl} ${res.statusCode} — ${ms}ms`).catch(() => {});
  });

  next();
}

module.exports = {
  Log,
  authenticate,
  setAuthToken,
  getToken,
  requestLogger,
  debug, info, warn, error, fatal,
  _flushQueue,
  CB,
};