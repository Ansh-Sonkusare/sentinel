# Sentinel

**A policy-guarded agent payment router.** An agent receives a goal ("assess this
Algorand wallet"), an LLM planner decomposes it into a small dependency graph,
a router picks which x402-payable provider serves each step, and every step is
**paid for before its response is trusted** — and no provider response can ever
touch the budget, the scope, or the prompt state.

Originally built at the **CodeRush 2.0** hackathon by team **CyberKnights**. TypeScript everywhere, Algorand
(AVM) settlement model, LLM + real-world API providers, and a policy guard that
is the actual differentiator.

```
goal: "assess this Algorand wallet"
   │
   ▼
planner (LLM, schema-constrained + hardcoded fallback)
   │  produces a task graph
   ▼
[ fetch-wallet-data ] → [ generate-summary ] → [ score-credit ]     (each paid)
   │                        │                       │
   └── routed to provider → treasury reserves → x402 pays → policy guard
                              validates a response → treasury settles → ledger row
```

---

## Table of contents

1. [Why this is hard](#why-this-is-hard-and-interesting)
2. [The safety contract](#the-safety-contract-non-negotiable)
3. [Architecture](#architecture)
4. [The end-to-end flow](#the-end-to-end-flow-per-task-node)
5. [The policy guard](#the-policy-guard-the-differentiator)
6. [Repository layout](#repository-layout)
7. [Tech stack](#tech-stack)
8. [Running it](#running)
9. [Live demo script](#live-demo-script-for-judges)
10. [API reference](#api-reference-all-strict-zod-validated)
11. [Tests](#testing)
12. [What's real vs. what's simulated](#whats-real-vs-whats-simulated-a-hackathon-note)

---

## Why this is hard (and interesting)

Agents that pay for services get abused in five predictable ways, all of which
are about **where the trust boundary lives**. This project draws the boundary
hard:

| Attack | How we stop it |
|---|---|
| Provider response raises the budget | `.strict()` zod schemas — the field isn't even representable |
| Provider response expands wallet scope / grabs a key | Guard checks attack-surface keys *before* schema parse |
| Provider sneaks in an LLM instruction to tip policy | `__instruction` / `system` style keys are structural rejects |
| Provider forges a payment receipt | Receipt `tx_ref` must match the payment we signed |
| A retry double-pays | Idempotency keys per (task, node, provider); retries reuse the key |

No `if` check downstream of a trusted response. The trust boundary is the
**schema itself**: `.strict()` zod objects mean a provider field we didn't
declare is a `PolicyViolation` at parse time, full stop.

---

## The safety contract (non-negotiable)

1. **Testnet only.** `NETWORK=testnet` is the only representable value — a
   MainNet value fails the config schema at boot and the process refuses to start.
2. **No raw secret keys in agent/LLM context.** The planner, router, and every
   LLM call only ever see a *scoped capability* ("pay up to X µA to provider Y for
   node Z"). The signer lives behind one module (`packages/x402-client`).
3. **No provider response can rewrite policy.** Every field crossing from a
   provider is parsed with a `.strict()` zod schema via `.safeParse()` *before*
   it reaches treasury or ledger state.
4. **Treasury owns budget and scope, unconditionally.** The planner proposes a
   task graph. It can never propose a budget, a network, or a wallet scope.
5. **No double settlement.** Payment attempts carry an idempotency key
   (`packages/router` generates it once); a retried or fallback payment reuses
   the same key path and the client detects `already_settled` before signing again.

---

## Architecture

```
                    ┌───────────────┐        ┌───────────────┐
                    │ providers     │        │ planner       │
                    │ (:4020)       │        │ (:4040)       │
                    │ registry,     │        │ LLM plan or   │
                    │ catalog, /mock│        │ fallback      │
                    └───────┬───────┘        └───────┬───────┘
                            │                       │
                            │   real providers      │
                            │   (Zerion + LLM)      │
  ┌───────────┐  /api        ▼                       ▼
  │ UI        │ ─────▶  ┌───────────────────────────────────────┐
  │ ReactFlow │         │  gateway (:4000)                      │
  │ + WS /ws  │         │  typed hc() proxy for every service   │
  └─────▲─────┘         └───────────────┬───────────────────────┘
        │                               │
        │  state frames (WS /ws)        ▼
        │                     ┌───────────────────────────────┐
        │                     │ orchestrator (:4010)          │
        │                     │ TaskMachine → NodeMachine     │
        │                     │ treasury → x402 → policy-guard│
        │                     └───────────────┬───────────────┘
        │                                     │
        └─────────────────────────────────────┴────► ledger (SQLite,
                                                     append-only, replayable)
```

One **gateway** exposes every API under `/api/*` and a single WebSocket `/ws` to
the UI. It is a thin, *typed* proxy: each microservice is called through Hono's
`hc<AppType>()` typed RPC client — a change in a service's route contract is a
compile error in the gateway, not a runtime surprise.

Inter-service event transport is intentionally simple and symmetric: the
orchestrator streams **Server-Sent Events** (`GET /orchestrator/events`) and the
gateway's WS hub tails that stream and re-broadcasts frames to the UI. There is
exactly **one** event type end-to-end — the `WsMessage` discriminated union —
serialized straight out of the XState machines. No parallel "UI event" shape.

### Process boundary

Both the gateway and the orchestrator open the **same SQLite ledger file**
(`LEDGER_PATH`), so the replay `/api/ledger/*` routes and the running machines
always see one consistent, append-only record.

---

## The end-to-end flow, per task node

Every node in a task goes through **exactly the same path**:

```
route → quote → reserve → pay → validate → settle → ledger
 │        │        │        │       │         │        │
 │        │        │        │       │         │        └─ append row (idempotency key)
 │        │        │        │       │         └── reserved → spent
 │        │        │        │       └── strict zod guard + receipt tx_ref check
 │        │        │        └── scoped capability issued by treasury, paid via x402-client
 │        │        └── reserve-on-select; pause + ask the operator if it would go over the cap
 │        └── 402-style invoice (price in microAlgo, never a floating-point number)
 └── weighted score (price/latency/quality), quality threshold, fallback
```

Concretely in `packages/orchestrator/src/nodeMachine.ts`, each node is its own
**XState actor**:

```
pending → routing → quoted → paying → paid → validating → settled
   │         │                           │          │
   │         └→ waiting_approval (budget, task pauses) └→ blocked (guard violation)
   └→ failed                                              (not "failed" — different state!)

fallback: on quote/pay/deliver transport errors, the provider is excluded and
the router picks the next candidate; idempotency keys guarantee that a re-route
never double-pays the original invoice.
```

A `blocked` node is not `failed`: the ledger and UI distinguish them, and a
blocked node cascades its downstream dependents to failed rather than leaving
them pending forever.

**Money rule:** ALGO amounts are never floats/`number` in business logic. They
are `MicroAlgo` — `bigint` and branded — inside the packages, and become decimal
strings only at HTTP/WS boundaries.

---

## The policy guard (the differentiator)

`packages/policy-guard` is a **pure function** of `(schema, rawResponse)`:

1. Collect **every key recursively** from the provider response.
2. Check known attack surfaces **before** schema parse, so the violation type
   is accurate:
   - `budget_mutation` — `budget_cap`, `raise_cap`, `approve_overspend`, …
   - `scope_expansion` — `wallet_key`, `private_key`, `signing_key`, `scope_token`, …
   - `prompt_injection` — `__instruction`, `system_message`, `agent_instruction`, …
3. Parse the object with the capability's `.strict()` zod schema. An extra field
   the schema doesn't declare = rejected (`schema_violation`).
4. Check the payment receipt: `tx_ref` must match the payment this node actually
   settled (`receipt_forgery` otherwise).

Failures return a typed `PolicyViolation` and the node transitions to **`blocked`**.
The guard never calls treasury or ledger itself — the orchestrator calls the
guard, gets a result, and decides. That makes the guard trivially unit-testable
with adversarial fixtures (see `tests/guard.test.ts`).

---

## Repository layout

```
/apps
  /gateway              :4000  — public door: typed proxy for every service + WS hub
  /service-orchestrator :4010  — runs the task (TaskMachine + NodeMachine)
  /service-planner      :4040  — stateless LLM planning, zod-constrained, hard fallback
  /service-providers    :4020  — provider registry (Zerion, LLM, mock / adversarial)
  /web                        — React + React Flow live trace + ledger replay UI
/packages
  /schemas                   — ALL zod schemas, branded types, route type contracts
  /config                    — single validated AppConfig via loadConfig()
  /treasury                  — budget/scope state machine
  /router                    — weighted router (price+latency+quality) + UCB1 bandit
  /policy-guard              — pure guard functions
  /x402-client              — payment layer (idempotent, capability-scoped)
  /ledger                    — append-only SQLite store + replay query layer
  /llm-client                — Gemini / OpenAI-compatible / Ollama behind one interface
  /orchestrator              — XState machines + TaskRunner
  /providers                 — remote HTTP proxy adapter + wire conversions
/tests/flow.test.ts, guard.test.ts, schema.test.ts, treasury.test.ts
```

**Layout rules that are enforced by review, not by hope:**
- `algosdk` signing primitives may only be imported into `packages/x402-client`.
- Zod schemas only exist in `packages/schemas` — no other package redefines a shared shape.
- `Result<T, E>` is returned across every package boundary — no exceptions.

---

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Monorepo | pnpm workspaces, one lockfile, shared `tsconfig.base.json` |
| Payment protocol | `@x402/*` on **Algorand (AVM)** — settlement simulated by a scoped, idempotency-keyed client |
| Orchestration | **XState v5** — one actor per node, one actor per task, exact state union |
| Schema / trust boundary | **zod** `.strict()` + `.safeParse()` on every external input |
| Backend framework | **Hono** on all services, `@hono/zod-validator` at every route |
| Ledger | SQLite via libSQL (`@libsql/client`) |
| Frontend | React + React Flow, WebSocket via `ws` (hub in gateway) |
| Real data providers | **Zerion** portfolio/transaction API; **LLM** via Groq / OpenAI-compatible / Gemini / Ollama |
| Tests | Vitest (schema round-trips, guard fixtures, treasury lifecycle, full end-to-end flow) |

---

## Running

Requires **Node 20+** and **pnpm**.

```bash
# 1. dependencies (repo root)
pnpm install

# 2. environment — every service validates config at boot, fails fast.
cp .env.example .env
#    fill in optional keys (LLM + Zerion) and optionally LLM_MODEL/LLM_BASE_URL

# 3. typecheck everything (must be clean before any commit)
pnpm -r typecheck

# 4. run all services + UI (providers, planner, orchestrator, gateway, web)
pnpm dev

# 5. open the UI
#    http://localhost:5173
```

The option is also a **PM2 ecosystem file** (`ecosystem.config.cjs`) that
launches the five processes under PM2.

**Experiment knob — adversarial providers** are registered by default
(`mock-wallet-data-adversarial`, `mock-summary-adversarial`) and can be selected
from the UI's *Attack scenario* dropdown to trigger the guard Live.

**Provider failure knobs** — the UI lets you mark a mock provider "failed" and
"recover" it mid-demo. Routing keeps the providers visible; the failed one fails
at the quote/deliver HTTP surface (503), and the node's fallback path comps in
the next routed provider.

---

## Live demo script (for judges)

> Suggested order below. Between runs, hit **recover** on any red providers in
> the Providers panel so the next run starts clean.

**1. Baseline — everything goes green.**
   - `Attack scenario: none`, goal = default (wallet assessment).
   - Hit **Run task**. Watch the React Flow graph light tier by tier as each node
     transits `pending → quoted → paying → paid → validating → settled`.
   - The budget bar on the left moves as each invoice is reserved and settled.
   - Sidebar's **Events** pane shows the same lifecycle; the **Ledger** tab shows
     one row per paid call, each with its idempotency key and outcome `success`.

**2. The guard actually blocks.**
   - Set `Attack scenario: budget mutation (n-wallet)`. Run again.
   - The `n-wallet` node turns **red (blocked)** with the violation card
     *"Provider response contains budget-mutating field(s) budget_cap"*. Its
     dependents cascade to `failed` — nothing hangs.
   - Switch to `scope expansion (n-summary)` for a second live demonstration.
   - Check the **Ledger** tab: the blocked row has `outcome: declared_failure`
     with a violation recorded; the honest rows stay `success`.

**3. Budget gates at the cap.**
   - Run the same task with a deliberately low cap (e.g. `100` µA).
   - The task **pauses** at `n-summary` and asks for approval, showing `projected`,
     `cap` and `overspend`.
   - Approve by typing a delta (µA) → the run resumes and settles. Reject → the
     task aborts cleanly. No silent overspend ever happened.

**4. Provider failure & fallback.**
   - In the **Providers** panel, hit **fail** on `mock-wallet-data`.
   - Run. The provider stays in the catalog, its quote route returns HTTP 503,
     and the node machine falls back to the next candidate — the task still
     settles.
   - **Recover** it and the same run succeeds against the primary again.

**5. Replay.**
   - Take the `taskId` (e.g. `t-abc12345`) from any run.
   - On the **Ledger** tab, paste it into the *task id* box and hit **Load task**.
     The export re-queries the ledger and re-renders the full row set.

---

## API reference (all strict zod-validated)

`GET  /api/orchestrator/status/:taskId` — execution snapshot (`ExecutionStatus`)
`POST /api/orchestrator/run`                      — start a task `{ goal, cap?, attackNode? }`
`POST /api/orchestrator/approve`              — `{ taskId, delta }` (raise cap after a pause)
`POST /api/orchestrator/reject`               — `{ taskId }`
`GET  /api/orchestrator/nodes/:taskId`        — node states
`POST /api/planner/plan`                      — explicit goal → plan (LLM + fallback)
`GET  /api/planner/fallback`                   — the hardcoded demo graph
`POST /api/planner/validate`                   — validate/topology-check a Plan graph
`GET  /api/providers`                          — registered catalog (incl. failed)
`POST /api/providers/register`                — attach an external provider server
`GET/POST /api/providers/:id/health|fail|recover`   — liveness + fail/recover knobs
`GET  /api/ledger/rows`                        — all ledger rows
`GET  /api/ledger/row/:ledgerId` / `node/:nodeId` / `task/:taskId` / `task/:taskId/export`
`POST /api/ledger/reset`                      — wipe for a demo
`WS   /ws`                                     — live event stream (same type as backend)

Every HTTP response is `.strict()`-safe-Parsed on the client too — the UI treats
the API it owns as untrusted input, just like the backend treats providers.

---

## Testing

```bash
pnpm test                # vitest, from repo root
pnpm -r typecheck        # every package typechecks before any PR
```

`tests/` cover the invariants that actually guarantee the build works:

- **`flow.test.ts`** — full `goal → plan → route → quote → reserve → pay → guard →
  settle → ledger` runs against the real engines: happy path budgeting, an
  adversarial `budget_cap` response (node blocks + dependents cascade), budget
  pause + operator approve/reject, no double settlement on a retried payment, and
  ledger replay.
- **`guard.test.ts`** — pure guard fixtures for every violation kind
  (`budget_mutation`, `scope_expansion`, `prompt_injection`, `schema_violation`,
  `receipt_forgery`).
- **`treasury.test.ts`** — reserve/release/settle lifecycle, overspend gating.
- **`schema.test.ts`** — strict round trips for every shared schema + wire forms.

---

## What's real vs. what's simulated (a hackathon note)

| Piece | Status |
|---|---|
| Planner (LLM) | **Real** — Groq / OpenAI-compatible / Gemini / Ollama via `packages/llm-client` |
| Provider catalog | **Real registry** with typed wire contract |
| Zerion wallet-data provider | **Real HTTP** to `api.zerion.io` (EVM/Solana). Algorand addresses aren't supported upstream, so for the default Algorand goal the mock adapter serves — and both paths exercise the identical guard surface |
| LLM summary + credit adapters | **Real LLM** calls, constrained to a strict zod schema |
| Payment/settlement | **Simulated** — `SimulatedX402Client` implements the ordered, capability-scoped, idempotency-key API that the real AVM signer will slot into `packages/x402-client`. The interface keeps the rest of the system unchanged. |
| Ledger, replay, WS, UI, safeguards | **Real and tested** |

The interesting engineering is deliberately not in "call the LLM" — it's in the
**trust boundary**: every byte that arrives from a generator goes through a
`.strict()` schema before it can do anything, and the orchestrator's every
decision is an explicit XState transition with the same type the UI renders.