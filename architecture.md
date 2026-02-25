# 🏛️ System Architecture

> **Bank Account Management System — Event Sourcing & CQRS**  
> Deep architectural reference for engineers and reviewers.

---

## Table of Contents

1. [Architectural Overview](#1-architectural-overview)
2. [Pattern: Event Sourcing](#2-pattern-event-sourcing)
3. [Pattern: CQRS](#3-pattern-cqrs)
4. [System Component Diagram](#4-system-component-diagram)
5. [Database Architecture](#5-database-architecture)
6. [Write Model: Command Pipeline](#6-write-model-command-pipeline)
7. [Read Model: Query Pipeline](#7-read-model-query-pipeline)
8. [Projection Engine](#8-projection-engine)
9. [Snapshotting Strategy](#9-snapshotting-strategy)
10. [Concurrency Model](#10-concurrency-model)
11. [Error Taxonomy](#11-error-taxonomy)
12. [Docker / Infrastructure](#12-docker--infrastructure)
13. [Design Trade-offs](#13-design-trade-offs)

---

## 1. Architectural Overview

This system implements the **ES/CQRS** architectural pair, a powerful combination used by leading financial platforms.

```mermaid
C4Context
    title Bank Account Management System — Context Diagram

    Person(client, "API Consumer", "Any HTTP client: mobile app, web frontend, test harness")
    System(bams, "Bank Account System", "Provides REST endpoints for account management via ES+CQRS")
    SystemDb(pg, "PostgreSQL 15", "Stores event stream, snapshots, and read-model projections")

    Rel(client, bams, "HTTP/REST")
    Rel(bams, pg, "TCP / SQL queries")
```

### Key Principles

| Principle | How It's Applied |
|---|---|
| **Single Source of Truth** | The `events` table is the authoritative state; projections are derived |
| **Immutability** | Events are never updated or deleted — append-only |
| **Separation of Concerns** | Commands (write) and Queries (read) are completely separate code paths |
| **Eventual Consistency** | Read models are updated synchronously post-commit (lag ≈ 0 ms) |
| **Resilience** | Projections can always be rebuilt from the event log |

---

## 2. Pattern: Event Sourcing

Instead of storing current state (`UPDATE accounts SET balance = 300`), every change is recorded as an immutable event:

```
AccountCreated   { accountId, ownerName, currency, initialBalance }
MoneyDeposited   { accountId, amount, transactionId, description }
MoneyWithdrawn   { accountId, amount, transactionId, description }
AccountClosed    { accountId, reason }
```

**State reconstruction** replays these events in order to derive current state:

```mermaid
flowchart LR
    E1["[1] AccountCreated\nbalance=0"] -->
    E2["[2] MoneyDeposited +100\nbalance=100"] -->
    E3["[3] MoneyDeposited +50\nbalance=150"] -->
    E4["[4] MoneyWithdrawn -30\nbalance=120"] -->
    STATE(["💰 Current State\nbalance=120"])
```

### Benefits of Event Sourcing

- ✅ **Complete Audit Trail** — every cent movement is permanently recorded
- ✅ **Time-Travel** — reconstruct any past state by replaying up to a timestamp
- ✅ **Debugging** — replay events in dev to reproduce exact production bugs
- ✅ **Multiple Projections** — same events feed different read models simultaneously
- ✅ **Event-Driven Extensions** — new consumers (email alerts, analytics) can read the same stream

---

## 3. Pattern: CQRS

```mermaid
graph LR
    subgraph W ["⚡ WRITE SIDE"]
        direction TB
        C1[POST /accounts] --> CH[Command\nHandlers]
        C2[POST /deposit]  --> CH
        C3[POST /withdraw] --> CH
        C4[POST /close]    --> CH
        CH --> ES[(Event\nStore)]
    end

    subgraph R ["📖 READ SIDE"]
        direction TB
        Q1[GET /accounts/:id]        --> QH[Query\nHandlers]
        Q2[GET /transactions]        --> QH
        Q3[GET /balance-at/:ts]      --> QH
        Q4[GET /events]              --> QH
        QH --> PM[(Projections\nRead Model)]
    end

    ES -.->|"Projector processes\nevery committed event"| PM
```

**Command handlers** never read from projections.  
**Query handlers** never write to the event store (exception: audit/time-travel reads raw events).

---

## 4. System Component Diagram

```mermaid
graph TB
    subgraph INFRA ["🐳 Docker Network"]
        subgraph APP ["app container (Node.js 20 Alpine)"]
            IDX["src/index.js\n(startup + retry)"]
            APJS["src/app.js\n(Express + middleware)"]
            DB["src/db.js\n(pg Pool)"]

            subgraph CORE ["Core Modules"]
                ES2["eventStore.js\nappend | load | snapshot\ntime-travel | count"]
                BA["domain/BankAccount.js\nfromEvents() | fromSnapshot()\nassertOpen() | assertFunds()"]
            end

            subgraph WRITE ["Write Side"]
                CMD["commands/index.js\ncreateAccount\ndepositMoney\nwithdrawMoney\ncloseAccount"]
            end

            subgraph READ ["Read Side"]
                QRY["queries/index.js\ngetAccount\ngetEvents\ngetBalanceAt\ngetTransactions"]
            end

            subgraph PROJ ["Projection Engine"]
                PRJ2["projectors/index.js\nproject()\nrebuildAll()\ngetStatus()"]
            end

            subgraph ROUTES ["Express Routes"]
                RA["routes/accounts.js"]
                RP["routes/projections.js"]
            end
        end

        subgraph DB2 ["db container (PostgreSQL 15)"]
            EV[("events")]
            SN[("snapshots")]
            AS[("account_summaries")]
            TH[("transaction_history")]
            PC[("projection_checkpoints")]
        end
    end

    CLIENT(["HTTP Client"]) --> RA & RP
    RA --> CMD & QRY
    RP --> PRJ2
    CMD --> ES2 & PRJ2
    CMD --> BA
    QRY --> AS & TH & ES2
    ES2 --> EV & SN
    PRJ2 --> AS & TH & PC
```

---

## 5. Database Architecture

### Events Table (Append-Only Write Model)

```sql
CREATE TABLE events (
    event_id        UUID                     PRIMARY KEY,
    aggregate_id    VARCHAR(255)             NOT NULL,  -- e.g., "acc-001"
    aggregate_type  VARCHAR(255)             NOT NULL,  -- "BankAccount"
    event_type      VARCHAR(255)             NOT NULL,  -- "MoneyDeposited"
    event_data      JSONB                    NOT NULL,  -- payload
    event_number    INTEGER                  NOT NULL,  -- per-aggregate sequence
    timestamp       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    version         INTEGER                  NOT NULL DEFAULT 1,
    CONSTRAINT uq_events_aggregate_event UNIQUE (aggregate_id, event_number)
);
```

> `UNIQUE(aggregate_id, event_number)` is the **optimistic concurrency guard** — two concurrent writes for the same aggregate produce a `23505` violation, safely rejected as a 409.

### Snapshots Table

```sql
CREATE TABLE snapshots (
    snapshot_id       UUID         PRIMARY KEY,
    aggregate_id      VARCHAR(255) NOT NULL UNIQUE,  -- one per account
    snapshot_data     JSONB        NOT NULL,           -- full state
    last_event_number INTEGER      NOT NULL,           -- replay from here
    created_at        TIMESTAMP    NOT NULL DEFAULT NOW()
);
```

### Read Model Tables

```sql
-- Fast account state lookup
CREATE TABLE account_summaries (
    account_id VARCHAR(255)   PRIMARY KEY,
    owner_name VARCHAR(255)   NOT NULL,
    balance    DECIMAL(19,4)  NOT NULL,
    currency   VARCHAR(3)     NOT NULL,
    status     VARCHAR(50)    NOT NULL,   -- OPEN | CLOSED
    version    BIGINT         NOT NULL    -- optimistic version tracking
);

-- Paginated transaction feed
CREATE TABLE transaction_history (
    transaction_id VARCHAR(255)              PRIMARY KEY,
    account_id     VARCHAR(255)              NOT NULL,
    type           VARCHAR(50)               NOT NULL,   -- DEPOSIT | WITHDRAWAL
    amount         DECIMAL(19,4)             NOT NULL,
    description    TEXT,
    timestamp      TIMESTAMP WITH TIME ZONE  NOT NULL
);
```

### Entity Relationship Diagram

```mermaid
erDiagram
    events {
        uuid event_id PK
        varchar aggregate_id
        varchar aggregate_type
        varchar event_type
        jsonb event_data
        int event_number
        timestamptz timestamp
        int version
    }
    snapshots {
        uuid snapshot_id PK
        varchar aggregate_id UK
        jsonb snapshot_data
        int last_event_number
        timestamp created_at
    }
    account_summaries {
        varchar account_id PK
        varchar owner_name
        decimal balance
        varchar currency
        varchar status
        bigint version
    }
    transaction_history {
        varchar transaction_id PK
        varchar account_id FK
        varchar type
        decimal amount
        text description
        timestamptz timestamp
    }
    projection_checkpoints {
        varchar projection_name PK
        bigint last_processed_event_number
    }

    events ||--o{ snapshots : "generates"
    events ||--o{ account_summaries : "projects into"
    events ||--o{ transaction_history : "projects into"
    account_summaries ||--o{ transaction_history : "has"
```

---

## 6. Write Model: Command Pipeline

Every command follows an identical pipeline:

```mermaid
flowchart TD
    A([Incoming Command]) --> B[Input Validation\n400 if invalid]
    B --> C{Account\nexists?}
    C -->|No| D([404 Not Found])
    C -->|Yes| E[Load Snapshot\nif available]
    E --> F[Load Events\nafter snapshot version]
    F --> G[Replay Events onto\nBankAccount Aggregate]
    G --> H{Business Rule\nValidation}
    H -->|Fails| I([409 Conflict])
    H -->|Passes| J[Create Domain Event]
    J --> K[Append to events table\nwith version check]
    K -->|23505 violated| L([409 Concurrency Conflict])
    K -->|Success| M[Update Read-Model Projections\nsynchronously]
    M --> N{event_number\n% 50 == 0?}
    N -->|Yes| O[Save Snapshot]
    N -->|No| P
    O --> P([Return 202 Accepted])
```

### Command Handlers

| Command | Preconditions | Event Emitted |
|---|---|---|
| `CreateAccount` | Account must NOT exist | `AccountCreated` |
| `DepositMoney` | Account OPEN; amount > 0; unique `transactionId` | `MoneyDeposited` |
| `WithdrawMoney` | Account OPEN; balance ≥ amount; unique `transactionId` | `MoneyWithdrawn` |
| `CloseAccount` | Account OPEN; balance = 0 | `AccountClosed` |

---

## 7. Read Model: Query Pipeline

```mermaid
sequenceDiagram
    participant C as Client
    participant QH as Query Handler
    participant AS as account_summaries
    participant TH as transaction_history
    participant EV as events

    Note over C,EV: Standard Account Query
    C->>QH: GET /api/accounts/:id
    QH->>AS: SELECT WHERE account_id = ?
    AS-->>QH: row
    QH-->>C: 200 { accountId, balance, ... }

    Note over C,EV: Paginated Transactions
    C->>QH: GET /api/accounts/:id/transactions?page=2&pageSize=10
    QH->>TH: SELECT ... LIMIT 10 OFFSET 10
    TH-->>QH: rows
    QH-->>C: 200 { currentPage, totalCount, items[] }

    Note over C,EV: Time-Travel (Direct Event Store)
    C->>QH: GET /api/accounts/:id/balance-at/:timestamp
    QH->>EV: SELECT WHERE timestamp <= T ORDER BY event_number
    EV-->>QH: event rows
    QH->>QH: Replay events → compute balance
    QH-->>C: 200 { balanceAt: 100.00 }
```

---

## 8. Projection Engine

The projector is the bridge between write and read models.

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Processing: New event committed
    Processing --> UpdateAccountSummary: AccountCreated / MoneyDeposited\nMoneyWithdrawn / AccountClosed
    Processing --> AppendTransaction: MoneyDeposited / MoneyWithdrawn
    UpdateAccountSummary --> UpdateCheckpoint
    AppendTransaction --> UpdateCheckpoint
    UpdateCheckpoint --> Idle: COMMIT
    Idle --> Rebuilding: POST /api/projections/rebuild
    Rebuilding --> Truncate: Clear account_summaries\n+ transaction_history
    Truncate --> ReplayAll: Load ALL events ordered by timestamp
    ReplayAll --> Idle: All events projected
```

**Idempotency**: All projection INSERTs use `ON CONFLICT DO NOTHING`, making replays safe.

---

## 9. Snapshotting Strategy

```mermaid
xychart-beta
    title "Events Loaded Per Request (With vs Without Snapshotting)"
    x-axis ["10 events", "50 events", "100 events", "200 events", "500 events"]
    y-axis "Events Loaded" 0 --> 500
    bar [10, 50, 10, 10, 10]
    line [10, 50, 100, 200, 500]
```

*Bar = with snapshotting (max 50 events loaded). Line = without snapshotting (all events).*

**Trigger**: After persisting an event where `event_number % 50 === 0`:

```js
// commands/index.js
const latestVersion = persistedEvents[persistedEvents.length - 1].event_number;
if (latestVersion % SNAPSHOT_THRESHOLD === 0) {
    const freshAccount = BankAccount.fromEvents(allEvents);
    await eventStore.saveSnapshot(aggregateId, freshAccount.toSnapshot(), latestVersion);
}
```

**Snapshot Data** (JSONB stored):
```json
{
  "accountId": "acc-001",
  "ownerName": "Alice",
  "balance": 1250.00,
  "currency": "USD",
  "status": "OPEN",
  "processedTransactionIds": ["txn-1", "txn-2", "..."]
}
```

---

## 10. Concurrency Model

```mermaid
sequenceDiagram
    participant R1 as Request A
    participant R2 as Request B (concurrent)
    participant DB as PostgreSQL

    par Concurrent Requests
        R1->>DB: Load events (version=5)
        R2->>DB: Load events (version=5)
    end
    par Both try to write event_number=6
        R1->>DB: INSERT event_number=6
        R2->>DB: INSERT event_number=6
    end
    DB-->>R1: ✅ OK (committed first)
    DB-->>R2: ❌ 23505 UNIQUE violation
    R2-->>R2: Catch → throw 409 CONCURRENCY_CONFLICT
```

This is **Optimistic Concurrency Control** — no database-level locks are held, making the system highly concurrent while preventing data corruption.

---

## 11. Error Taxonomy

| HTTP Code | Error Code | Scenario |
|---|---|---|
| `400` | — | Missing/invalid fields; negative amounts |
| `404` | — | Account not found in event store or projection |
| `409` | `ACCOUNT_EXISTS` | Duplicate `accountId` on create |
| `409` | `INSUFFICIENT_FUNDS` | Withdrawal > balance |
| `409` | `ACCOUNT_CLOSED` | Operation on a closed account |
| `409` | `NON_ZERO_BALANCE` | Close attempted with non-zero balance |
| `409` | `CONCURRENCY_CONFLICT` | Concurrent write collision |
| `500` | — | Unhandled internal server error |

---

## 12. Docker / Infrastructure

```mermaid
graph LR
    subgraph HOST ["Host Machine"]
        PORT["Port 8080"]
        PORT5432["Port 5432"]
    end

    subgraph NETWORK ["Docker Network: week-13mandatory_default"]
        subgraph APP_C ["app container"]
            NODE["Node.js 20 Alpine"]
            CURL["curl (health check)"]
        end
        subgraph DB_C ["db container"]
            PG["PostgreSQL 15"]
            SEEDS["seeds/01_schema.sql\n(auto-loaded)"]
        end
        VOLUME["pgdata volume\n(persistent)"]
    end

    PORT -->|":8080"| APP_C
    PORT5432 -->|":5432"| DB_C
    APP_C -->|"DATABASE_URL"| DB_C
    DB_C --- VOLUME
```

**Startup order**:
1. `db` starts → PostgreSQL loads → health check `pg_isready` passes
2. Seeds directory (`seeds/`) is automatically executed by the `postgres:15` image on first start
3. `app` starts (only after `db` is healthy) → Node.js retries DB connection → server binds to `API_PORT`

---

## 13. Design Trade-offs

| Decision | Chosen Approach | Alternative | Reason |
|---|---|---|---|
| Projection timing | **Synchronous** (in-request) | Async via message queue | Simplicity; near-zero lag without extra infra |
| Snapshot store | **UPSERT** (1 per aggregate) | Versioned snapshots | Simpler; storage-efficient for finance use case |
| Global event ordering | **timestamp + event_id** | Global sequence (serial) | Avoids global lock contention |
| Concurrency | **Optimistic** (DB constraint) | Pessimistic (SELECT FOR UPDATE) | Higher throughput; no deadlocks |
| Balance arithmetic | **Server-side float** | Database-side DECIMAL | Full precision maintained via DECIMAL(19,4) in DB |
| Idempotency scope | **transactionId in aggregate** | Dedupe table | Natural fit for ES; no extra table |
