# Campus Hiring Evaluation — Backend Track

## Structure

```
├── logging_middleware/            # Shared logger (retry + circuit-breaker + auto-refresh)
├── vehicle_maintenance_scheduler/ # Knapsack scheduler (all depots, rate-limited)
├── notification_app_be/           # Notifications REST + WebSocket + DLQ + MinHeap
├── notification_system_design.md  # Stages 1–6 design document
└── .gitignore
```

## Quick Start

### 1. Register (once) and get `clientID` + `clientSecret`

### 2. Get Bearer token via POST `/evaluation-service/auth`

### 3. Fill credentials in each service's `start()` function (or use `.env`)

```env
EMAIL=you@college.edu
NAME=Your Name
ROLL_NO=yourroll
ACCESS_CODE=xgAsNC
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
```

### 4. Install + run

```bash
# Terminal 1
cd logging_middleware && npm install

# Terminal 2
cd vehicle_maintenance_scheduler && npm install && npm start

# Terminal 3
cd notification_app_be && npm install && npm start
```

## Key Features

| Feature | Where |
|---------|-------|
| Auto-auth + token refresh | `logging_middleware/index.js` |
| Retry (3× exponential back-off) | `logging_middleware/_sendLog()` |
| Circuit breaker (5 failures → OPEN → cooldown) | `logging_middleware/CB` |
| Log queue (failed logs persisted, flushed on recovery) | `logging_middleware/_retryQueue` |
| Request logger middleware (every HTTP in/out) | `logger.requestLogger` |
| Rate limiting (60 req/min scheduler, 100 req/min notifications) | `express-rate-limit` |
| 0/1 Knapsack DP (no external libraries) | `vehicle_maintenance_scheduler/knapsack()` |
| All 5 depots handled, parallel fetch | `GET /schedule` |
| MinHeap top-N O(log N) | `notification_app_be/MinHeap` |
| TTL cache (30s) with invalidation | `notification_app_be/cacheGet/Set/Invalidate` |
| Async broadcast + retry + DLQ | `POST /notifications/broadcast` |
| DLQ inspection + retry endpoint | `GET /notifications/dlq`, `POST /notifications/dlq/retry` |
| WebSocket real-time push | `ws://localhost:3002` |