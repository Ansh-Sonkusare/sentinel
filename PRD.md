# PRD: Sentinel — Policy-Guarded Agent Payment Router for Algorand (INF-01)

**Status:** Active build — consolidated from the earlier `PRD.md` ("Sentinel"
framing) and `PRD-ORCH.md` ("policy-driven router / orchestrator" framing).
This is the single source of truth for what we are building and where we are.
**Source spec:** INF-01 — Multi-Provider Agent Payment Router & Treasury
**Agent contract:** `AGENTS.md` (non-negotiable safety rules; this doc does not
override it).
**Team size assumption:** 4 people

> **Problem statement (verbatim):** Build a **policy-driven router** that
> **decomposes an agent task** across multiple x402 providers, **selects routes**
> by price/quality/latency, **enforces budgets**, **handles fallbacks**, and
> **reconciles every payment and result** without exposing an unrestricted wallet.

> **Scope note.** The original INF-01 PRD assumed an EVM stack (Base Sepolia,
> `@x402/evm`, `viem`, LangGraph, a large mocked provider catalog, x402 Bazaar).
> This build settles on **Algorand (AVM)** via the GoPlausible `x402-avm`
> implementation and narrows the provider catalog to a small, real set anchored
> by **Zerion** (wallet data) + an **LLM** (summary / credit-score generation).
> We do not reintroduce EVM/viem code or a big mock catalog.

---

## 1. One-line pitch

A policy-guarded agent payment router on Algorand TestNet: an agent hands it a
goal ("assess this Algorand wallet"), a planner decomposes the goal into a small
dependency-aware task graph, a router picks an x402-payable provider per node, a
treasury reserves and settles payment **before** a response is trusted, a policy
guard structurally rejects any provider response that tries to touch
budget/scope/prompt state, and an append-only ledger records every step so a
judge can replay the whole run — with no unrestricted wallet ever exposed.

## 2. Why this angle

The spec's minimum viable demo (happy path, forced failure, budget breach,
reconciliation export) is what most teams will build as a CLI over a hand-rolled
fake 402. Two lines are usually treated as footnotes but are explicitly part of
the judged bar:

> "A provider or result must never be allowed to rewrite the payment policy,
> raise a budget, or gain access to unrelated wallet scopes."
> "...design for replay: a judge should be able to run the same scenario again
> and inspect the trace."

We make both the centerpiece, and go one step further: run the **actual x402
protocol** on a public testnet (Algorand TestNet via the GoPlausible
facilitator) instead of a mocked handshake — still "simulated/testnet funds
only" per the safety boundary, but real signed payment payloads and real
settlement, not an invented stand-in. The policy guard is what makes an open,
permissionless x402 marketplace safe to route budget through — that is the
demo's central claim.

---

## 3. Current progress (as of today)

The monorepo is built and test-covered end to end **except** the browser UI and
the real provider content. Status map:

| Area | Status | Where |
|---|---|---|
| pnpm monorepo, shared tsconfig, workspace scripts | ✅ built | `pnpm-workspace.yaml`, `tsconfig.base.json`, root `package.json` |
| `packages/schemas` — every zod schema, branded money, discriminated unions | ✅ built | `packages/schemas/src/*` |
| `packages/config` — zod-validated env config, testnet-only | ✅ built | `packages/config/src/index.ts` |
| `packages/treasury` — budget reserve/settle/release, scoped capabilities | ✅ built | `packages/treasury/src/index.ts` |
| `packages/policy-guard` — strict guard + terms/receipt validation | ✅ built | `packages/policy-guard/src/index.ts` |
| `packages/x402-client` — **simulated** payment client (idempotent, scoped) | ✅ built (simulated) | `packages/x402-client/src/index.ts` |
| `packages/llm-client` — Gemini / OpenAI-compatible / Ollama backends | ✅ built | `packages/llm-client/src/index.ts` |
| `packages/router` — weighted + UCB1 bandit provider selection | ✅ built | `packages/router/src/index.ts` |
| `packages/ledger` — append-only SQLite ledger + replay export | ✅ built | `packages/ledger/src/index.ts` |
| `packages/orchestrator` — XState TaskMachine + NodeMachine + TaskRunner | ✅ built | `packages/orchestrator/src/` |
| `packages/providers` — remote HTTP adapter + wire conversion | ✅ built | `packages/providers/src/` |
| `apps/gateway` — public HTTP proxy + `/ws` hub (SSE→WS bridge) | ✅ built | `apps/gateway/src/` |
| `apps/service-orchestrator` — run/approve/reject/status/events HTTP + SSE | ✅ built | `apps/service-orchestrator/src/` |
| `apps/service-providers` — in-memory registry + catalog endpoints | ✅ built | `apps/service-providers/src/` |
| `apps/service-planner` — LLM planning + fallback graph | ✅ built | `apps/service-planner/src/` |
| Tests (flow / guard / schema / treasury) | ✅ built, vitest | `tests/` |
| Zerion wallet-data adapter | 🚧 placeholder — `quote()/deliver()` return "not wired" | `apps/service-providers/src/providers/zerion.ts` |
| LLM summary / credit-score adapters | 🚧 placeholder — `quote()/deliver()` return "not wired" | `apps/service-providers/src/providers/llm.ts` |
| Real x402 payment on Algorand (facilitator, AVM signer) | 🚧 not wired — `SimulatedX402Client` used | `packages/x402-client/src/index.ts` |
| Mock / adversarial provider **servers** | ✅ in-process mocks on the service-providers boot path (`/mock/:id/*` HTTP surface), normal + adversarial modes | `apps/service-providers/src/providers/mock.ts` |
| **`apps/web` UI** | ✅ built — React Flow live trace wired to the gateway `/ws` + `/api` | `apps/web/src/` |
| Legacy React Flow UI | ❌ removed — superseded by `apps/web` | — |

> The engine **and** the demo provider content are now real and test-covered.
> In-process mock adapters (well-behaved + adversarial) are registered on the
> service-providers boot path and served over HTTP (`/mock/:id/quote`,
> `/mock/:id/deliver`, `/mock/:id/health`), so a full `run` against the live
> services settles all three nodes and the policy guard blocks the adversarial
> ones. Zerion/LLM adapters remain placeholders until real API wiring (§10.1).

---

## 4. What we are building (in scope)

Per `AGENTS.md` §11 — the PRD sections that are actually in scope for this build:

### 4.1 Dynamic task planner — in scope
An LLM produces the task graph from a high-level goal (nodes, edges, capability
per node), constrained to a **zod** schema (`PlannerGraphSchema`, `.strict()`),
swappable backend (`Gemini` / `OpenAI-compatible` / `Ollama` via
`packages/llm-client`), with a **hardcoded fallback graph** on schema
failure/timeout/outage. Budget and wallet scope are **forbidden keys** in
planner output — treasury owns those exclusively. Dedupe near-identical
sub-requests before they cost money (planned).

### 4.2 Provider catalog — narrowed
Small, real set anchored by **Zerion** (wallet data) + an **LLM**
(summary / credit-score generation), plus 1–3 mock/adversarial providers used
to demo the guard. Capabilities today: `search`, `extract`, `translate`,
`rank`, `verify` (mock), and `fetch_wallet_data`, `generate_summary`,
`score_credit` (demo provider set). Every provider implements the shared
`ProviderAdapter` interface (`quote()`, `deliver()`, health, price/latency/quality
metadata) — the router/treasury never special-case a provider by identity.

### 4.3 Adaptive route optimizer — baseline done, bandit stretch
**Baseline:** weighted score over price/latency/quality with a human-readable
"why" (`packages/router`). **Learning mode (stretch):** UCB1 multi-armed bandit
(implemented, not wired into the current orchestrator) adapting online as
quality/latency drift, with a held-out eval harness.

### 4.4 Treasury / policy layer — core, built
Per-task budget cap, spend reservation (**reserve → release on failure → settle
on success**), scoped single-use capabilities ("pay ≤ X to Y for node Z"),
pause-for-approval when a quote would breach the cap, approve/reject over the
API. The planner proposes task graphs, never budgets or wallet scopes.

### 4.5 Policy guard — core differentiator, built
Every provider response is parsed through a **strict zod schema** before it can
touch treasury/ledger state or the execution context. A `.safeParse()` failure
or a disallowed field is a **structural rejection**, not a downstream `if`.
Violation types: `budget_mutation` | `scope_expansion` | `prompt_injection` |
`receipt_forgery` | `schema_violation`. A guard failure transitions the node to
**`blocked`** (distinct from `failed`) and the violation is appended to the
ledger row. See §6 for the exact allowed-fields contract.

### 4.6 Fallback / recovery — built
Provider outage / quote-pay-deliver transport error → `treasury.release()`,
ledger row marked `declared_failure`, provider **excluded**, node re-routes to
the next-best provider. Idempotency key per (task, node, provider) minted once at
node creation — no double settlement under retry. A dependency that ends in
`failed`/`blocked` cascades to its dependents. Stale-quote re-validation before
paying (planned).

### 4.7 Reconciliation ledger + replay — built
Append-only SQLite ledger, one row per paid call: `402_terms → payment →
settlement → response → receipt`, plus `violations[]` and `outcome`. Replay =
`GET /api/ledger/task/:taskId/export` (rows in creation order, no separate
replay data model). Replay-with-changed-offer diffing is a stretch goal.

### 4.8 Live trace UI — next phase (see §9)
React + React Flow + WebSocket live graph over the gateway `/ws` hub, budget
bar, blocked-attack panel, interactive approve/deny, and a replay view.

### 4.9 x402 Bazaar / open marketplace — stretch only
Discovery support should be verified against current `@x402/*` docs before
committing to it.

### 4.10 Zerion — independent settlement verification (stretch)
Cross-verify a claimed settlement against an independent source (Algorand
indexer or Zerion's tx endpoint for the treasury account) before marking a
ledger row `settled`, plus a live "ledger vs chain" treasury view.

---

## 5. Architecture (as built)

### 5.1 Repo layout

```
/apps
  /gateway              :4000 — single public surface, /ws hub, typed hc proxy
  /service-orchestrator :4010 — XState task execution + SSE event stream
  /service-providers    :4020 — provider registry (placeholder Zerion/LLM adapters)
  /service-planner      :4040 — stateless LLM planning + hardcoded fallback
  /web                  :5173 — UI (stub; see §9 plan)
/packages
  /schemas        — ALL zod schemas, branded types, route type contracts
  /config         — validated AppConfig, single loadConfig(), testnet-only
  /x402-client    — payment layer (SimulatedX402Client today → AVM signer); only
                    package allowed to import algosdk signing primitives
  /treasury       — budget state machine, scoped capabilities
  /policy-guard   — pure guard functions (guardResponse, validateTerms, validateReceipt)
  /llm-client     — LLM backends behind one interface
  /router         — provider selection (weighted + bandit)
  /ledger         — append-only store + replay query layer (internal, no HTTP)
  /orchestrator   — XState NodeMachine + TaskMachine + TaskRunner
  /providers      — remote HTTP provider adapter + wire conversion
```

Services talk to each other **only** via Hono typed clients (`hc<T>()`);
every request/response body is validated with a strict zod schema at the
receiving boundary. `packages/schemas` is the single source of every shared
shape. Money is `MicroAlgo` (bigint-branded) in-process and a decimal **string**
on every HTTP/WS wire (`jsonStringify`). WS messages use the **same `NodeState`
discriminated union** as the XState machines — no parallel "UI event" shape.

### 5.2 End-to-end flow

```
goal: "assess wallet ALGO…"
  ─▶ service-orchestrator /run  { goal, cap?, attackNode? } → { taskId }
  ─▶ TaskMachine "planning": service-planner /planner/plan
       LLM → PlannerGraphSchema (strict) → forbidden-keys scan → validateGraph
       └─ on any failure → hardcoded fallback graph (n-wallet → n-summary → n-credit)
  ─▶ TaskMachine "executing": spawnReadyNodes
       ready node (all deps settled) → NodeMachine actor per node
       NodeMachine: pending → routing (router.select + adapter.quote + treasury.reserve)
                   → paying (treasury.issueCapability → x402.pay, idempotent)
                   → validating (adapter.deliver → policy-guard.validate + receipt check)
                   → settled | blocked | failed
       over-cap quote → waiting_approval → task pauses → approve/reject
  ─▶ treasury.settle, ledger row written per paid call
  ─▶ every transition broadcasts a WsMessage over SSE → gateway /ws hub → UI
  ─▶ replay: GET /api/ledger/task/:taskId/export
```

### 5.3 State machines

```
TaskMachine:  planning → executing ⇄ paused → completed
                  ↘ aborted
NodeMachine:  pending → routing ⇄ (routing, provider excluded on
                                quote/pay/deliver failure)
                      → quoted → paying → paid → validating
                      ↘ waiting_approval (budget — task pauses)
                      ↘ failed (no provider / transport)
                      validating → settled | blocked (policy guard)
```

Observable `NodeState` union (`packages/schemas/src/node-state.ts`):
`pending | quoted | paying | paid | validating | settled | blocked | failed`.
`blocked` carries the typed `PolicyViolation`; it is **not** `failed`.

### 5.4 HTTP + WS surface (all via gateway :4000 unless noted)

| Route | Backing | Purpose |
|---|---|---|
| `POST /api/orchestrator/run` | :4010 | start a task `{ goal, cap?, attackNode? }` → `{ taskId }` |
| `POST /api/orchestrator/approve` | :4010 | budget approve `{ taskId, delta }` |
| `POST /api/orchestrator/reject` | :4010 | abort a paused task |
| `GET /api/orchestrator/status/:taskId` | :4010 | `ExecutionStatus` (nodes, budget, pauseInfo) |
| `GET /api/orchestrator/nodes/:taskId` | :4010 | `NodeState[]` |
| `WS /ws` | gateway hub | live feed (tails :4010 SSE `/orchestrator/events`) |
| `POST /api/planner/plan`, `GET /api/planner/fallback`, `POST /api/planner/validate` | :4040 | planning |
| `GET /api/providers`, `POST /api/providers/register`, `GET /api/providers/catalog/:capability`, `GET /api/providers/:id/health`, `POST /api/providers/:id/fail`, `POST /api/providers/:id/recover` | :4020 | provider registry |
| `GET /api/ledger/rows`, `POST /api/ledger/rows`, `GET /api/ledger/row/:ledgerId`, `GET /api/ledger/task/:taskId`, `GET /api/ledger/task/:taskId/export`, `GET /api/ledger/node/:nodeId`, `POST /api/ledger/reset` | in-process | ledger + replay |

WS messages (`packages/schemas/src/ws.ts`): `task_started`, `node_state`,
`task_paused`, `task_done`, `task_aborted`.

---

## 6. Policy guard — the allowed-fields contract

The guard sits at the **VERIFY** phase, between the provider response and the
ledger/treasury/execution context. Nothing else reads a provider response.
Every schema below is `.strict()` — an undeclared field fails the parse.

- **402 terms (ASK):** `invoice_id`, `provider_id`, `capability`, `price`,
  `currency`, `schema`, `terms_expires_at`, `payment_required`.
- **Result (VERIFY), per capability:** `search` → `{ urls[], snippets[] }`;
  `extract` → `{ title, body, word_count }`; `translate` →
  `{ original, translated, language }`; `rank` → `{ ranked[], sources_considered[] }`;
  `verify` → `{ verified, confidence, checks[] }`; `fetch_wallet_data` →
  `{ wallet_address, portfolio_value_usd, fetched_at }`; `generate_summary` →
  `{ summary }`; `score_credit` → `{ score, reasons[] }`.
- **Receipt (RECONCILE):** `receipt_id`, `tx_ref` (must match the settlement
  `tx_ref` or the row is `receipt_forgery`), `provider_id`, `settled_at`,
  `already_settled`.

Classification is a lookup over the rejected (unknown) fields against known
attack key-sets (`BUDGET_MUTATION_FIELDS`, `SCOPE_EXPANSION_FIELDS`,
`PROMPT_INJECTION_KEYS`); the guard is strict about rejecting regardless of
which bucket it lands in. Attack detection never loosens the contract — it only
improves the log.

---

## 7. Non-negotiable safety invariants (how the code holds them)

1. **Testnet only** — `NetworkSchema = z.enum(["testnet"])`; a mainnet value
   fails boot (`packages/config`).
2. **No raw signer outside x402-client** — the payment layer is
   capability-scoped (`ScopedCapability` from treasury); `algosdk` signing
   primitives are only imported in `packages/x402-client`, and today the client
   is simulated.
3. **No provider response rewrites policy** — `.strict()` schemas +
   `guardResponse` before treasury/ledger; `TaskGraphSchema` and the planner
   prompt forbid budget/scope fields.
4. **Treasury owns budget/scope, unconditionally** — a fresh `Treasury` per
   task, cap from `RunRequest` only; planner/router/LLM never touch a number.
5. **No double settlement** — one idempotency key per (task, node, provider),
   generated in one place; `SimulatedX402Client.pay` returns the original
   receipt on replay.

---

## 8. Run & verify

```bash
pnpm install
pnpm -r typecheck        # strict, must be clean before merging
pnpm test                # vitest — flow (happy/guard/pause/reject), guard, schema, treasury
pnpm dev                 # providers, planner, orchestrator, gateway, web (concurrently)
```

`tests/flow.test.ts` is the highest-value read: it runs a complete
goal→plan→route→quote→reserve→pay→guard→settle→ledger task with in-process mock
providers, and covers the three headline behaviors: happy path, policy-guard
blocking (`budget_mutation`), and budget pause + approve/reject.

---

## 9. Next phase — connect the web UI (`apps/web`)

This is the current work plan. The engine is done; the browser is not.

### 9.1 Goal

Build `apps/web` (React + React Flow + WebSocket) against the gateway (:4000)
as the live trace UI, replacing the legacy `ui/` demo. A judge should be able
to: submit a goal, watch the graph light up node-by-node (real backend events),
see blocked attacks flagged red with the violation type, approve/deny a budget
pause, and replay a finished task from the ledger.

### 9.2 Backend contract is ready; two gaps to close first

Everything the UI needs already exists in the gateway surface (§5.4) except:

1. **The planned `TaskGraph` is not exposed after planning.** The UI needs
   steps + dependencies to render the React Flow graph, but `task_started`
   carries only `{ taskId, goal, at }` and `ExecutionStatus` carries `nodes`
   but not the graph. Fix (pick one, in `packages/schemas` + orchestrator):
   - **Recommended:** add `graph: TaskGraph` (and `planSource: "planner" |
     "fallback"`) to `ExecutionStatus` — zero new events, one schema change,
     and the status endpoint becomes the single source for both the graph and
     the live node states.
   - Alternative: extend `task_started` to carry the graph (timing: graph is
     known when `task_started` fires, so this works too; it just mixes the
     "started" envelope with plan data).
2. **Bigint wire format.** `BudgetStatus`/`NodeState`/`PauseInfo` money fields
   leave the boundary as decimal **strings** (`jsonStringify`). The UI must
   parse them (and display in microAlgo/ALGO) at the display boundary — no
   `number` math on the raw strings.

### 9.3 Build steps

1. **Scaffold `apps/web`.** `index.html`, `vite.config.ts` with a dev proxy
   (`/api` and `/ws` → `http://localhost:4000`, avoiding CORS and hardcoded
   origins), `src/main.tsx`, `App.tsx`. Deps already declared: `react`,
   `react-dom`, `reactflow`, `@sentinel/schemas`.
2. **Typed API client.** `hc<GatewayRoutes>("http://localhost:4000")` from
   `@sentinel/schemas` for run/status/nodes/approve/reject/planner/providers/
   ledger. Add a thin `formatMicroAlgo(string)` helper for display.
3. **`useWs` hook (ported, re-contracted).** Connect to `ws://localhost:4000/ws`
   (or the proxied `/ws`), `WsMessageSchema.safeParse` every frame, filter by the
   current `taskId`, and fold events into: `Record<nodeId, NodeState>`, budget,
   pauseInfo, violations list, event log. Reconnect with backoff. The legacy
   `ui/src/hooks/useWs.ts` logic is the starting point but must map the **new**
   `NodeState` discriminated union — no legacy event shapes.
4. **Graph view.** Port the React Flow layout from `ui/src/components/TaskGraph.tsx`
   (topological layering), driven by the **actual planned graph** (gap 9.2.1)
   instead of a static fallback skeleton. Map `NodeState.kind` → node color/label:
   `settled` green, `paying/validating` amber, `blocked` red + violation badge,
   `failed` dark red, `quoted` showing provider + price (microAlgo).
5. **Demo controls.** Goal text input, optional cap (microAlgo string), optional
   `attackNode` (pick node → pick evil provider to force the guard to block),
   Run button; provider fail/recover buttons from `GET /api/providers`.
6. **Pause/approve panel.** When `task_paused` arrives, render pauseInfo
   (projected vs cap, overspend) with Approve (delta input) and Deny —
   `POST /api/orchestrator/approve` / `reject`.
7. **Budget bar + blocked-attacks + event log** side panels (from the folded WS
   state).
8. **Replay view.** `GET /api/ledger/task/:taskId/export` rendered as a
   timeline/table (stages per row, violations, outcome); a task picker lists
   recent rows from `GET /api/ledger/rows`.
9. **Retire legacy.** `ui/`, `src/`, and the legacy `scripts/*` demo providers
   are removed — `apps/web` and the in-process mock providers cover them.

### 9.4 Definition of done for the UI phase

- [x] Graph renders the real planned graph from `ExecutionStatus` (not a hardcoded skeleton)
- [x] Live node states come from `/ws` frames parsed with `WsMessageSchema`
- [x] Budget pause shows interactive approve/deny wired to the orchestrator API
- [x] Blocked attacks render with violation type + rejected fields
- [x] Ledger replay view renders a finished task's export
- [x] Money displayed in microAlgo from wire strings — no `number` for amounts
- [x] `pnpm -r typecheck` clean; `pnpm --filter web build` clean
- [x] `ui/`, `src/`, legacy `scripts/` removed once superseded

---

## 10. Roadmap (after the UI phase)

1. **Real provider content:** wire Zerion wallet-data and the LLM
   summary/credit-score providers behind the x402 resource-server contract
   (`quote`/`deliver`/`health`) so `adapter.quote()` stops erroring.
2. **Real x402 on Algorand:** replace `SimulatedX402Client` with the actual
   `@x402/core`/`@x402/avm` client (facilitator `facilitator.goplausible.xyz`,
   TestNet) — the seam is already `X402Client` + `ScopedCapability`.
3. **Stale-quote + multi-scheme:** re-validate quotes between ASK and PAY,
   re-route on mismatch; `exact`/`upto` schemes.
4. **Independent settlement verification:** receipt cross-check against an
   external source (Algorand indexer / Zerion tx endpoint) before marking
   `settled`.
5. **Bandit routing wired into the orchestrator** + held-out eval harness
   (stretch).
6. **Replay-with-changed-offer** diffing (stretch).
7. **Full demo rehearsal** including a deliberate planner failure and a
   deliberate attack that gets caught live.

---

## 11. Demo script

1. **Happy path (dynamic):** give the planner a goal, watch it produce the task
   graph, the router explain each pick, and the UI light up node-by-node —
   simulated payments, ledger rows appearing live.
2. **Forced failure:** fail a provider mid-flow (`POST /api/providers/:id/fail`
   or a transport failure) — ledger marks `declared_failure`, no duplicate
   payment, node re-routes to the next-best provider.
3. **Budget breach:** tight cap — task pauses, UI shows a live, clickable
   approve/deny prompt.
4. **The attacks:** run 2–3 adversarial providers back to back (`attackNode`
   knob) — each caught structurally, each red on the live graph with the
   violation type and rejected fields.
5. **(If planner degrades):** break the LLM planner call and show the
   hardcoded-graph fallback keeps the task running.
6. **Reconciliation + replay:** export the ledger, reload it in replay mode.

---

## 12. Success criteria for judging

- Zero unauthorized budget overspends, across every scenario including
  adversarial ones.
- Zero duplicate settlements under forced failure or retries, verified against
  real testnet transaction hashes (once the real AVM client lands).
- Zero successful policy/scope violations — every attack caught structurally.
- Every route decision, every payment, and every blocked attack maps to a
  ledger row — visible live and replayable afterward.
- The router provably *orchestrates*: it changes what it buys based on guarded
  results that came back — not just which provider it pays — while staying
  inside the treasury budget the whole time.

---

## 13. Stretch goals (only after §9 + §10.1–10.3 are solid)

1. Receipt forgery detection vs an independent source (Algorand indexer / Zerion).
2. Multi-network settlement mismatch handling (simulated).
3. Composite workflows with conditional/skippable branches (INF-03 borrowing).
4. Role-based access on the approval UI (analyst vs approver).
5. Replay-with-changed-offer diffing.
6. x402 Bazaar-equivalent discovery, verified against current `@x402/*` docs.
