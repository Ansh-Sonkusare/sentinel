# MIGRATION.md — Sentinel

Migrating from flat `src/` monolith to pnpm monorepo with a unified Hono gateway
and independent microservices. Each phase leaves `pnpm -r typecheck` clean.
**Do not skip phases.** Each one is a prerequisite for the next.

---

## Architecture target

```
apps/gateway              :4000  — public surface, WS hub, typed hc proxy
apps/service-orchestrator :4010  — XState task execution
apps/service-providers    :4020  — provider registry (placeholder Zerion/AI adapters)
apps/service-planner      :4040  — stateless LLM planning

packages/schemas          — ALL zod schemas, branded types, route type defs
packages/config           — validated AppConfig, single loadConfig()
packages/x402-client      — payment layer (SimulatedWallet → AVM signer)
packages/treasury         — budget state machine
packages/policy-guard     — pure guard functions
packages/llm-client       — LLM backends behind one interface
packages/router           — provider selection, bandit optimizer
packages/ledger           — append-only store + replay query layer (internal, no HTTP)
packages/orchestrator     — XState NodeMachine + TaskMachine
```

Inter-service calls use Hono's `hc<AppType>()` typed RPC client.
WS messages use the same `NodeState` discriminated union as the XState machines.
`packages/schemas` is the single import source for every shared type.

---

## Phase 1 — Monorepo skeleton

**Goal:** wire pnpm workspaces, shared tsconfig, root scripts. No code moved yet.

Files created:
- `tsconfig.base.json`
- `pnpm-workspace.yaml` (updated)
- `package.json` (updated — workspace scripts)
- `packages/` and `apps/` directory stubs

Verify: `pnpm install` succeeds from root.

---

## Phase 2 — `packages/schemas`

**Goal:** single canonical source for every shared type. Old `src/types.ts`,
`src/guard/responseSchema.ts`, `src/planner/plannerSchema.ts`, and `src/ledger/schema.ts`
collapse here. `ui/src/types.ts` is deleted after this phase.

What this package exports:
- Branded primitives: `MicroAlgo`, `TaskNodeId`, `IdempotencyKey`, `WalletAddress`
- `Result<T, E>` type
- `NodeState` discriminated union (used by XState machines AND WS wire format)
- `PolicyViolation` schema (strict)
- All capability response schemas (strict zod objects)
- `ProviderAdapter` interface
- `LedgerRow`, `LedgerStage` zod schemas
- `TaskGraph`, `TaskStep`, `TaskGraph` zod schemas
- `PlannerGraph`, `PlannerStep` zod schemas
- Route type contracts: `ProviderRoutes` (Phase 7), `PlannerRoutes` (Phase 8),
  `GatewayRoutes` (Phase 10); `OrchestratorRoutes` stub remains until Phase 9

All `src/` imports updated to `@sentinel/schemas`. Typecheck must pass.

---

## Phase 3 — `packages/config`

**Goal:** one validated `AppConfig`. No package reads `process.env` directly.

- Zod schema for all env vars
- `loadConfig()` — throws on missing/invalid, lists every bad var
- `network: z.enum(["testnet"])` — mainnet not in enum, boot fails structurally
- Port defaults: gateway=4000, orchestrator=4010, providers=4020, planner=4040
- All existing `process.env` reads in `planner.ts` and `providers.ts` replaced with injected config

---

## Phase 4 — Pure packages: `treasury`, `policy-guard`, `x402-client`

**Goal:** extract the three core pure packages. No HTTP, no ports.

### `packages/treasury`
- Move `src/treasury/treasury.ts`
- `number` amounts → `MicroAlgo` (bigint branded)
- Add `issueCapability(nodeId, providerId, max): ScopedCapability`

### `packages/policy-guard`
- Move `src/guard/guard.ts`
- Remove `capability` arg from `guardResponse` — caller passes schema directly
- Export pure functions only: `guardResponse`, `validateTerms`, `validateReceipt`
- No imports of ledger, treasury, or any service

### `packages/x402-client`
- Move `src/wallet/wallet.ts` → `SimulatedX402Client implements X402Client`
- Interface: `issueCapability()`, `pay(capability, invoice) → Result<PaymentReceipt, PaymentError>`
- `algosdk` will only ever be imported here — boundary is enforced at this phase

---

## Phase 5 — `packages/llm-client`, `packages/router`

**Goal:** extract LLM backends and route optimizer as injectable pure packages.

### `packages/llm-client`
- Extract `GeminiPlanner`, `OpenAICompatiblePlanner`, `OllamaPlanner` from `src/planner/planner.ts`
- Interface: `LLMClient.generate<T>(prompt, schema) → Result<T, LLMError>`
- Factory: `createLLMClient(config: LLMConfig): LLMClient`

### `packages/router`
- Move `src/engine/routeOptimizer.ts` + `src/engine/banditOptimizer.ts`
- Takes `ProviderAdapter[]` (not hardcoded catalog array)
- Idempotency key generation lives here — canonical single place
- Interface: `Router.select(capability, excludeIds?) → Result<RouteDecision, RouterError>`

---

## Phase 6 — `packages/ledger` (internal, no HTTP service)

**Goal:** ledger as an internal append-only package — NOT a standalone service.
No port, no HTTP surface. Consumed in-process by `packages/orchestrator`;
the gateway serves the replay view from this package later (Phase 10).

- SQLite/libSQL backing (replaces `src/ledger/ledger.ts` JSON file)
- One row per paid call, written with the node's idempotency key
- API: `createLedgerStore(dbPath) → LedgerStore`
  ```
  insert(input)          → LedgerRow            (assigns ledger_id, stamps stages/outcome)
  get(ledgerId)          → LedgerRow | undefined
  updateStage(ledgerId, stage) / setOutcome(ledgerId, outcome)
  appendViolation(ledgerId, violation)
  findByTaskId(taskId) / findByNodeId(nodeId) / all()
  exportTask(taskId)     → LedgerExport         (replay: rows in creation order)
  reset()
  ```
- Every read/write round-trips `LedgerRowSchema` (`.strict()`)
- Replay = `findByTaskId(taskId)` ordered by `seq` — no separate replay data model

---

## Phase 7 — `apps/service-providers` (:4020)

**Goal:** provider registry as an independent Hono service. No hardcoded catalog array.

- `ProviderRegistry` — register/lookup adapters (in-memory). Registered at boot
  (placeholder adapters) or at runtime via `POST /providers/register`.
- Placeholder adapters implement `ProviderAdapter` from `packages/schemas`
  (real Zerion API + AI summary/credit-score integrations land in a later phase):
  - `zerion-wallet-data` (`fetch_wallet_data`) — Zerion wallet/portfolio data
  - `llm-summary` (`generate_summary`) and `llm-credit-score` (`score_credit`)
  - Placeholder `quote()`/`deliver()` fail cleanly (provider not implemented yet);
    `health()` reports ok so the registry/catalog/UI skeleton stays live.
- External servers can be attached over HTTP with zero code changes: register
  attaches a `RemoteProviderAdapter` that proxies quote/deliver/health to the
  entry's `base_url` (quote → `POST {base}/quote`, deliver → `POST {base}/deliver`,
  health → `GET {base}/health`). Good for mock/adversarial guard-demo servers later.
- Wire format: `ProviderCatalogEntryWireSchema` (`price_micro_algo` as a decimal
  string — bigint is not JSON-safe; in-process entries keep `MicroAlgo` bigint).
- Routes:
  ```
  POST  /providers/register
  GET   /providers
  GET   /providers/:id/health
  POST  /providers/:id/fail        (demo knob — hides provider from catalog)
  POST  /providers/:id/recover
  GET   /providers/catalog/:capability
  ```
- Exports `ProviderSchema` typed route contract for the gateway (`hc<ProviderSchema>`)

---

## Phase 8 — `apps/service-planner` (:4040)

**Goal:** stateless planning service. LLM call isolated here.

- Implements `apps/service-planner/src/` (`app.ts`, `planner.ts`, `fallback.ts`,
  `index.ts`); legacy `src/planner/` stays intact for now.
- Uses `packages/llm-client` (`createLLMClient(config.llm)`) — the LLM call is a
  single `client.generate<PlannerGraph>(...)` with `PlannerGraphSchema` for
  structured output; the client's own 45s timeout + `Result` handling means the
  service never wraps the call in its own timeout/throw logic.
- `planWithFallback` (in `planner.ts`) returns a `PlanOutcome` discriminated
  union:
  - `{ source: "planner", graph }` — LLM output passed `PlannerGraphSchema`
    (strict) → `containsForbiddenKeys` (budget/scope/credential keys are
    treasury-owned) → `validateGraph` (dup ids, unknown/self deps, cycles) →
    `plannerGraphToTaskGraph` (task_id override applied here).
  - `{ source: "fallback", graph, reason }` — on any failure of the above, returns
    the wallet-assessment demo graph from `fallback.ts`.
- Validation lives in `packages/schemas/src/planner.ts`: `PlanOutcomeSchema`,
  `PlanRequestSchema`, `ValidateRequestSchema`, `ValidateResponseSchema`,
  `validateGraph`, `plannerGraphToTaskGraph`; `PLANNER_GRAPH_JSON_SCHEMA` now
  derives its capability enum from `CAPABILITIES`.
- Routes:
  ```
  POST  /planner/plan       { goal, task_id? } → PlanOutcome
  GET   /planner/fallback                     → TaskGraph
  POST  /planner/validate   { graph }         → { ok } | { ok:false, errors }
  ```
- Exports `PlannerSchema` / `PlannerRoutes` typed route contract for the gateway
  (`hc<PlannerRoutes>`). `PlannerEnv` has no variables — the client is injected
  via the `createPlannerApp(client)` closure, not read from request env.
- Shared endpoint type helpers extracted to `packages/schemas/src/routes/common.ts`
  (`JsonGet`/`JsonPost`/`ParamGet`/`ParamPost`) and re-used by both provider and
  planner route contracts.

---

## Phase 9 — `packages/orchestrator` + `apps/service-orchestrator` (:4010)

**Goal:** XState-driven execution. Replaces `executor.ts` + `paidCall.ts`.

### `packages/orchestrator` — XState machines

**`NodeMachine`** — one actor per task node:
```
pending → quoted → paying → paid → validating → settled
                                             ↘ blocked
                  ↘ failed
```
Each transition invokes treasury/x402-client/guard as promises.
Context holds: `nodeId`, `capability`, `txRef`, `ledgerId`, `violation`, `idempotencyKey`.

**`TaskMachine`** — one actor per task run:
```
planning → executing → paused ↔ executing → completed | aborted
```
Spawns child `NodeMachine` actors for each ready node.
`APPROVE`/`REJECT` events drive the `paused` ↔ `executing` transition.

### `apps/service-orchestrator`
- Mounts `TaskMachine`, subscribes to actor snapshots
- Forwards `NodeState` snapshots to gateway over SSE
- Routes:
  ```
  POST  /orchestrator/run     { goal, cap?, attackNode? } → { taskId }
  POST  /orchestrator/approve { taskId, delta }           → BudgetStatus
  POST  /orchestrator/reject  { taskId }                  → { ok }
  GET   /orchestrator/status/:taskId                      → ExecutionStatus
  GET   /orchestrator/nodes/:taskId                       → NodeState[]
  ```
- Calls service-planner + service-providers via typed `hc` clients; ledger is used in-process via `packages/ledger`
- Exports `OrchestratorApp` type for gateway

---

## Phase 10 — `apps/gateway` (:4000)

**Goal:** single public entry point. Replaces `scripts/trace-server.ts`.

- Implements `apps/gateway/src/app.ts` + `index.ts`. All routes delegate to
  microservices via `hc<ServiceApp>(serviceUrl)` (service URLs derived from
  `config.ports.*` — no new env vars); upstream-down surfaces as `502`.
- Route groups (implemented):
  ```
  /api/planner/*     → :4040 via hc<PlannerRoutes>
  /api/providers/*   → :4020 via hc<ProviderRoutes>
  /api/ledger/*      → served in-process from packages/ledger
  ```
  Ledger routes: `GET /rows`, `POST /rows` (insert), `GET /row/:ledgerId`,
  `GET /task/:taskId`, `GET /task/:taskId/export`, `GET /node/:nodeId`,
  `POST /reset`. Ledger file path from `config.ledgerPath` (new `LEDGER_PATH`
  env, default `.data/ledger.db`).
- CORS middleware on `/api/*`.
- **Deferred to Phase 9+:** `/api/orchestrator/*` proxy and `WS /ws` hub — their
  upstream (service-orchestrator) does not exist yet. `scripts/trace-server.ts`
  still deleted once the WS hub lands.
- Exports `GatewaySchema` / `GatewayRoutes` typed route contract for the UI
  (`hc<GatewayRoutes>` — note hono nests client keys under the first path
  segment, e.g. `client.api.planner.plan`).

---

## Invariants — enforced at every phase

| Rule | Enforced by |
|---|---|
| No `algosdk` outside `packages/x402-client` | Import lint / grep in CI |
| No zod schema outside `packages/schemas` | Same |
| No `process.env` outside `packages/config` | Same |
| No raw `number` for amounts in business logic | `MicroAlgo` branded type — TS compile error |
| Every trust boundary uses `.strict()` zod + `.safeParse()` | Code review |
| `pnpm -r typecheck` clean before next phase | Gate for each phase |

---

## Dev commands (post-migration)

```bash
pnpm install
pnpm dev          # starts all services + gateway + web concurrently
pnpm -r typecheck # must be clean before any merge
pnpm -r test      # unit tests for guard, treasury, schema round-trips
pnpm -r lint
```

## Port map

| Service | Port | Env var |
|---|---|---|
| Gateway | 4000 | `GATEWAY_PORT` |
| service-orchestrator | 4010 | `ORCHESTRATOR_PORT` |
| service-providers | 4020 | `PROVIDERS_PORT` |
| service-planner | 4040 | `PLANNER_PORT` |
| apps/web (Vite) | 5173 | — |

(packages/ledger is internal — no port, no env var.)
