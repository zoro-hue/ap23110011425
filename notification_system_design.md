# Notification System Design

## Stage 1 — REST API Design

### Endpoints

#### 1. Get All Notifications
```
GET /notifications
```
**Query Params:** `type` (Placement|Event|Result), `isRead` (true|false), `studentID`

**Response 200:**
```json
{
  "success": true,
  "count": 3,
  "notifications": [
    {
      "id": "d146095a-0d86-4a34-9e69-3900a14576bc",
      "type": "Placement",
      "message": "CSX Corporation hiring",
      "timestamp": "2026-04-22 17:51:30",
      "isRead": false,
      "studentID": null
    }
  ]
}
```

#### 2. Get Single Notification
```
GET /notifications/:id
```
**Response 200:** notification object  
**Response 404:** `{ "success": false, "error": "Notification not found" }`

#### 3. Create Notification
```
POST /notifications
Content-Type: application/json
```
**Request:**
```json
{
  "type": "Placement",
  "message": "Google is hiring",
  "studentID": "1042"
}
```
**Response 201:**
```json
{
  "success": true,
  "notification": { "id": "...", "type": "Placement", ... }
}
```

#### 4. Mark as Read
```
PATCH /notifications/:id/read
```
**Response 200:** updated notification object

#### 5. Delete Notification
```
DELETE /notifications/:id
```
**Response 200:** `{ "success": true, "message": "Notification deleted" }`

#### 6. Top-N Unread (Priority)
```
GET /notifications/top?n=5&studentID=1042
```
**Response 200:**
```json
{
  "success": true,
  "topN": [
    { "id": "...", "type": "Placement", "priorityScore": "3.0991", ... }
  ]
}
```

#### 7. Recent Placement Notifications (Last 7 Days)
```
GET /notifications/placement/recent
```
**Response 200:** filtered notifications array

#### 8. Broadcast to Students
```
POST /notifications/broadcast
```
**Request:**
```json
{
  "type": "Event",
  "message": "Annual Tech Fest tomorrow",
  "studentIDs": ["1001", "1002", "1003"]
}
```
**Response 202:** Accepted — processing happens asynchronously

---

### Naming Conventions
- **URI:** kebab-case, plural nouns, no verbs in paths
- **JSON fields:** camelCase for request/response
- **HTTP verbs:** GET (read), POST (create), PATCH (partial update), DELETE
- **Status codes:** 200 OK, 201 Created, 202 Accepted, 400 Bad Request, 404 Not Found, 500 Server Error

### Headers
```
Content-Type: application/json
Authorization: Bearer <token>  (for protected routes)
X-Request-ID: <uuid>           (for tracing)
```

---

### Real-Time Notification Mechanism

**Technology:** WebSocket (via `ws` library over HTTP server)

**Flow:**
```
Client connects to ws://host:port
Server sends: { "event": "connected", "message": "Real-time notifications active" }

When POST /notifications is called:
  → Server stores notification
  → Server broadcasts to all connected WS clients:
    { "event": "new_notification", "notification": { ... } }
```

**Why WebSocket over SSE or polling:**
- Bi-directional (client can ack/send read events)
- Lower overhead than repeated HTTP polling
- Near-zero latency vs polling intervals
- Better suited for multi-tab dashboard use

---

## Stage 2 — Database Design

### Choice: PostgreSQL (SQL)

**Reasoning:**
- Notifications have a **fixed, predictable schema** — structured data fits relational model
- Strong ACID guarantees (critical for delivery tracking)
- Mature tooling for indexing, query optimisation, partitioning
- `studentID` foreign key relationships are natural in SQL

### Schema

```sql
CREATE TABLE students (
  id          BIGSERIAL PRIMARY KEY,
  college_id  VARCHAR(50) UNIQUE NOT NULL,
  name        VARCHAR(200) NOT NULL,
  email       VARCHAR(200) UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        VARCHAR(20) NOT NULL CHECK (type IN ('Placement', 'Event', 'Result')),
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  created_by  VARCHAR(100)
);

CREATE TABLE student_notifications (
  id              BIGSERIAL PRIMARY KEY,
  student_id      BIGINT REFERENCES students(id) ON DELETE CASCADE,
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  is_read         BOOLEAN DEFAULT FALSE,
  read_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, notification_id)
);

-- Indexes (Stage 3 informs these)
CREATE INDEX idx_sn_student_unread ON student_notifications(student_id, is_read, delivered_at DESC)
  WHERE is_read = FALSE;

CREATE INDEX idx_notifications_type_created ON notifications(type, created_at DESC);
```

### Scaling Considerations
- **Partitioning:** Partition `student_notifications` by `delivered_at` range (monthly partitions) — millions of rows become manageable per partition
- **Read replicas:** Route `SELECT` queries to read replicas; writes go to primary
- **Connection pooling:** PgBouncer in front of Postgres
- **Archival:** Move `is_read = TRUE` records older than 30 days to a cold archive table

---

## Stage 3 — Query Analysis

### Original Query
```sql
SELECT * FROM notifications
WHERE studentID = 1042 AND isRead = false
ORDER BY createdAt DESC;
```

#### Is it accurate?
Functionally yes — it retrieves unread notifications for a student ordered newest-first. However:
- `SELECT *` fetches unnecessary columns (wastes I/O and network bandwidth)
- In the relational schema, `studentID` and `isRead` live in `student_notifications`, not `notifications` — so the join is missing

#### Why is it slow?
1. **No composite index** on `(studentID, isRead, createdAt)` — full table scan
2. **`SELECT *`** fetches all columns including large `message` TEXT when you may only need `id, type, message, createdAt`
3. **`isRead = false`** is low-selectivity if most notifications are unread (many rows pass the filter)
4. **`ORDER BY createdAt DESC`** requires a sort unless the index supports it

#### Cost
Without indexes: `O(n)` full sequential scan, then sort `O(n log n)`.  
With partial index on `(studentID, is_read) WHERE is_read = FALSE`: near `O(log n)` seek + small range scan.

#### Should all columns be indexed?
**No.** Over-indexing causes:
- **Write overhead:** Every `INSERT`/`UPDATE` must update all indexes
- **Storage bloat:** Indexes consume disk space proportional to data
- **Planner confusion:** Too many indexes can cause the query planner to make suboptimal choices
- **Maintenance cost:** `VACUUM`, `ANALYZE`, and index rebuilds are slower

Only index columns that appear in `WHERE`, `JOIN ON`, or `ORDER BY` clauses of frequent queries.

#### Optimised Query
```sql
-- Students who received placement notifications in the last 7 days
SELECT DISTINCT s.id, s.college_id, s.name, s.email
FROM students s
JOIN student_notifications sn ON sn.student_id = s.id
JOIN notifications n ON n.id = sn.notification_id
WHERE n.type = 'Placement'
  AND sn.delivered_at >= NOW() - INTERVAL '7 days'
ORDER BY s.id;
```

---

## Stage 4 — Caching & Optimisation

### Problem
- Notifications fetched on every page load → DB overloaded

### Strategies

#### 1. Redis Cache with TTL
- Cache `GET /notifications?studentID=X` responses in Redis with a 60-second TTL
- On `POST /notifications` or `PATCH /read`, **invalidate** the affected student's cache key
- **Trade-off:** Slight staleness (up to TTL); massive reduction in DB reads

#### 2. HTTP Cache Headers
- Return `Cache-Control: max-age=30` and `ETag` headers
- Clients and CDN edge nodes cache responses
- **Trade-off:** Less control over invalidation; works best for public/shared data

#### 3. Pagination (Cursor-based)
- Never load all notifications; use `?cursor=<last_id>&limit=20`
- Reduces payload size and DB work per request
- **Trade-off:** Client complexity; no random-page access

#### 4. Read-Through Cache
- App checks Redis first; on miss, queries DB and populates cache
- **Trade-off:** Cold-start latency; memory management

#### 5. WebSocket Push (Eliminate Polling)
- Clients subscribe once; server pushes new notifications in real-time
- **Eliminates** page-load fetches entirely for new notifications
- **Trade-off:** Persistent connections consume server resources; requires reconnect logic

#### 6. Database Query Optimisation (Stage 3 indexes)
- Composite partial index on `(student_id, is_read, delivered_at DESC) WHERE is_read = FALSE`
- Dramatically reduces query cost without cache

### Recommended Combination
```
WebSocket push (new events) + Redis TTL cache (initial load) + cursor pagination + partial indexes
```

---

## Stage 5 — Reliable Bulk Notification Redesign

### Original Pseudocode Problems
```python
function notify_all(student_ids, message):
    for student_id in student_ids:
        send_email(student_id, message)     # synchronous, blocking
        save_to_db(student_id, message)     # coupled to email success
        push_to_app(student_id, message)    # sequential, slow
```

**Issues:**
1. **Sequential loop** — for 10,000 students this takes 10,000× email latency
2. **No error isolation** — one failure stops the rest
3. **Email and DB are synchronous** — a slow email server blocks DB writes
4. **No retry mechanism** — 200 failed emails are silently lost
5. **Single point of failure** — no dead-letter queue

### Should DB write and email be synchronous?
**No.** DB write should be immediate and durable. Email is a side-effect that may fail, retry, or be rate-limited. Coupling them means a transient SMTP error prevents the notification from ever being persisted.

### Redesigned Architecture

```
API receives broadcast request
  → Writes notification records to DB (synchronous, fast)
  → Enqueues one job per student into a message queue (e.g. BullMQ/RabbitMQ)
  → Returns HTTP 202 Accepted immediately

Queue Workers (N parallel workers):
  → Dequeue job
  → push_to_app(studentID)       ← in-process, fast
  → send_email(studentID)        ← async, retryable
  → If email fails → retry with exponential backoff (max 3 attempts)
  → If still fails → move to Dead Letter Queue (DLQ)

DLQ monitor:
  → Alert ops team
  → Allow manual re-trigger
```

**Pseudocode:**
```python
function notify_all(student_ids, message, type):
    notification = save_to_db(message, type)   # single record
    for student_id in student_ids:
        save_student_notification(student_id, notification.id)  # batch insert
    enqueue_jobs(student_ids, notification.id)  # non-blocking
    return 202 Accepted

async function worker(job):
    { student_id, notification_id } = job
    push_to_app(student_id, notification_id)   # WebSocket/FCM
    try:
        send_email(student_id, notification_id)
    except EmailError:
        if job.attempts < 3:
            requeue(job, delay=exponential_backoff(job.attempts))
        else:
            move_to_dlq(job)
```

**Benefits:**
- DB write is immediately consistent
- Email failures don't affect other students
- System handles 200 failures gracefully via DLQ
- Horizontal scaling: add more workers under load

---

## Stage 6 — Top-N Priority Notifications

### Priority Formula
```
priority_score = type_weight + recency_score

type_weight:  Placement=3, Result=2, Event=1
recency_score = 1 / (1 + age_in_minutes)
```

### Algorithm

**For initial load / REST API:**
- Sort all unread notifications by `priority_score` descending — `O(n log n)`
- Return top N — `O(1)` slice

**For continuous incoming notifications:**
- Maintain a **min-heap of size N** in memory
- When new notification arrives:
  - Compute its `priority_score`
  - If heap size < N → push
  - Else if score > heap minimum → pop minimum, push new
  - Heap operations: `O(log N)` per incoming notification
- This is optimal: `O(n log N)` total vs `O(n log n)` for full sort

**Redis Sorted Set (production):**
```
ZADD notifications:<studentID>:unread <priority_score> <notification_id>
ZREVRANGE notifications:<studentID>:unread 0 N-1 WITHSCORES
```
- Score is updated atomically on each new notification
- `ZREVRANGE` is `O(log n + N)` — extremely fast

### Handling Score Decay
Since `recency_score` decays over time, re-rank lazily:
- When client requests top-N, recompute scores for candidates in the sorted set
- Avoid background cron jobs for score updates (unnecessary overhead)

---

## Architecture Overview

```
                    ┌─────────────┐
                    │   Clients   │
                    └──────┬──────┘
                           │ HTTP / WebSocket
                    ┌──────▼──────────────┐
                    │  Express API Server  │
                    │  + WebSocket (ws)    │
                    └──────┬──────────────┘
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──┐  ┌──────▼──┐  ┌─────▼──────┐
       │ Redis   │  │ Postgres │  │ BullMQ     │
       │ Cache   │  │ (Primary)│  │ Job Queue  │
       └─────────┘  └─────────┘  └─────┬──────┘
                                        │
                                  ┌─────▼──────┐
                                  │  Workers   │
                                  │ (Email/FCM)│
                                  └────────────┘
```
