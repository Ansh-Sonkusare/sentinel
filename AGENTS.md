# AGENTS.md — Sentinel

This file is the contract for any AI coding agent (Claude Code, Cursor, Copilot, etc.)
working in this repo. It exists so that four people plus several LLM sessions don't
converge on four different type systems and three different ideas of what "settled"
means. Read this fully before generating code. If a request conflicts with this file,
this file wins — flag the conflict instead of silently picking one.

> **Scope note on the source PRD.** The original INF-01 PRD assumes an EVM stack
> (Base Sepolia, `@x402/evm`, `viem`, a hand-built adversarial provider catalog, a
> bandit route optimizer, Bazaar discovery). This build swaps the settlement layer to
> **Algorand (AVM)** via the GoPlausible `x402-avm` implementation, and narrows the
> provider catalog to a small, real set anchored by **Zerion** (wallet data) + an
> **LLM** (summary / credit-score generation), instead of a large mocked catalog.
> Section 11 maps PRD sections to what's actually in scope. Don't silently
> re-introduce EVM/viem code from PRD muscle memory — this project is AVM-only.

---

## 1. What this project is

An agent receives a goal ("assess this Algorand wallet"), a planner decomposes it into
a small task graph, a router picks which x402-payable provider serves each node,
a treasury layer reserves and settles payment for each call **before** the response
is trusted, a policy guard structurally rejects any provider response that tries to
touch budget/scope/prompt state, and a ledger records every step so it can be
replayed for a judge.

The concrete demo path:

```
goal: "assess wallet 0x... / ALGO address ABC..."
  -> planner produces graph: [fetch-wallet-data] -> [generate-summary] -> [score-credit]
  -> router selects provider for each node (Zerion for data, LLM provider for the rest)
  -> treasury reserves budget, x402 client pays the 402 challenge on Algorand
  -> policy guard validates the response schema before it touches state
  -> ledger appends one row per paid call
  -> UI shows the graph live, then supports replay
```

## 2. Non-negotiable safety boundary

These are correctness requirements, not style preferences. Any generated code that
violates one of these is a bug, full stop:

1. **Testnet funds only.** Algorand TestNet, faucet-funded accounts. Never wire a
   MainNet endpoint or a real funded account into any default config.
2. **No raw secret key in agent/LLM context.** The planner, router, and any LLM call
   never see a mnemonic, private key, or raw signer. They only ever see a scoped
   capability ("pay up to X ALGO/ASA to provider Y for node Z") issued by the
   treasury layer. The signer lives behind one module (`packages/x402-client`) and
   nothing else imports `algosdk`'s account/signing primitives directly.
3. **No provider response can rewrite policy.** Every field coming back from a
   provider — including the payment/settlement response itself — is parsed through
   a `zod` schema with `.safeParse()` **before** it reaches treasury or ledger state.
   A schema that doesn't declare a field can't smuggle it in; this is enforced by
   using `.strict()` schemas, not by an `if` check downstream.
4. **Treasury owns budget and scope, unconditionally.** The planner can propose a
   task graph. It cannot propose a budget, a network, or a wallet scope. Those three
   things are only ever set by `packages/treasury` and are read-only to every other
   package.
5. **No double settlement.** Every payment attempt carries an idempotency key
   (task node id + attempt number). A retried or fallback-triggered payment reuses
   the same key path so the client wrapper can detect "already paid" before signing
   again.

If you (the agent) are about to write code that routes around one of these five
points to "make the demo work faster," stop and say so instead of writing it.

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript everywhere | `strict: true`, no `any` without a `// TODO(reason)` comment, no `ts-ignore` |
| x402 protocol (Algorand/AVM) | `@x402/core`, `@x402/avm`, `@x402/hono` (server), `@x402/fetch` or `@x402/axios` (client) | GoPlausible's Algorand implementation of x402 v2. Facilitator: point at `facilitator.goplausible.xyz` for the hackathon, don't stand up your own unless there's spare time. **Verify current package APIs against the linked docs before writing signer/middleware code — this SDK is actively evolving.** |
| Algorand SDK | `algosdk` | Only imported inside `packages/x402-client`; everything else calls that package's typed interface |
| Schema / validation | `zod` | Single source of truth for: planner output shape, provider response shape, ledger row shape, API request/response shape. `.strict()` on every object schema that guards a trust boundary |
| Wallet-data provider | Zerion API | Wraps the wallet/portfolio/transaction fetch behind an x402-payable resource server. Treat its response shape as untrusted input — validate with zod like any other provider |
| LLM (summary / credit score) | Provider-agnostic behind one interface (`packages/llm-client`) | Structured output constrained to a zod schema, same pattern as the planner. Don't hardcode a single vendor's SDK outside this package |
| Planner | LLM-backed, zod-schema-constrained output, hardcoded fallback graph on schema failure or timeout | Never trust planner output for budget/scope (see §2.4) |
| Orchestration | XState v5 (or a minimal hand-rolled state machine if time-constrained) | Task graph node states map to explicit transitions: `pending -> quoted -> paying -> paid -> validating -> settled \| blocked \| failed` |
| Ledger | Postgres (or SQLite/libSQL if you want zero-ops for the demo) | Append-only. One row per paid call. Replay = re-query ordered by timestamp, no separate replay data model |
| Backend framework | **Hono** (matches `@x402/hono` middleware) | Chosen over Express (more per-route boilerplate for zod validation) and Elysia (no official `@x402` middleware — you'd hand-roll the 402-challenge flow). Use `@hono/zod-validator` at every route boundary. One framework for every service in `/apps/api`; don't mix per-service. |
| Frontend | React + React Flow + WebSocket (`ws` or Socket.io) | Live task graph; reused for replay |
| Package manager / monorepo | pnpm workspaces | One lockfile, shared `tsconfig.base.json`, shared `zod` schema package |

## 4. Repository layout

Restructure toward this shape. Move code incrementally — don't do one giant
rename commit; migrate package by package so the repo builds at every step.

```
/apps
  /api            — Hono server: planner, router, treasury, guard, ledger endpoints, WS
  /web            — React + React Flow live trace UI + replay view
/packages
  /schemas        — ALL zod schemas live here, and ONLY here. Every other package
                    imports types from this package; nothing redefines a shape locally.
  /x402-client    — Wraps @x402/core, @x402/avm, @x402/fetch/axios. Only place
                    algosdk signing primitives are imported. Exposes a capability-scoped
                    API: payForResource(capability, providerUrl) -> PaymentResult.
                    Never exports a raw signer.
  /treasury       — Budget/risk/allowlist state machine. Issues scoped capabilities.
                    Reserve -> release-on-failure -> settle-on-success lifecycle.
  /policy-guard   — Strict zod validation layer for every provider response.
                    Pure functions: (schema, rawResponse) -> Result<Validated, PolicyViolation>.
  /providers      — One module per provider: Zerion wallet-data provider, LLM
                    summary/credit-score provider, plus any mock/adversarial providers
                    used for demoing the guard. Each implements the same ProviderAdapter
                    interface from /schemas.
  /llm-client     — LLM calls behind one interface, structured-output schema-constrained.
  /planner        — Task-graph generation, hardcoded fallback, dedupe logic.
  /router         — Provider selection (baseline weighted score; bandit optimizer if time allows).
  /ledger         — Append-only store + replay query layer. No business logic here.
/tsconfig.base.json
/package.json     — workspaces root
```

**Rule:** if you find yourself importing `algosdk` outside `packages/x402-client`,
or defining a `zod` schema outside `packages/schemas`, stop — that's the layout
telling you the code is in the wrong package.

## 5. Type safety rules (non-negotiable for this codebase)

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
  in `tsconfig.base.json`. Every package extends it, none loosen it.
- **Every trust boundary is a zod schema, not a TypeScript type assertion.**
  TypeScript types are erased at runtime; a provider response, an LLM output, and
  an incoming HTTP request body are all untrusted until `.safeParse()` succeeds.
  `as Foo` on external input is a bug.
- **Branded types for anything that looks like a primitive but isn't interchangeable
  with one:** wallet address, task node id, idempotency key, ALGO/ASA amount (in
  microAlgo, as a bigint or branded integer — never a floating-point currency
  value). Example pattern:
  ```ts
  type MicroAlgo = number & { readonly __brand: "MicroAlgo" };
  ```
  This stops "budget in dollars" and "budget in microAlgo" from being silently
  swapped at a function boundary — a real failure mode in a payment router.
- **Discriminated unions for node/task state**, not a `status: string` field with
  string comparisons scattered around. `type NodeState = { kind: "quoted"; ... } |
  { kind: "paid"; ... } | { kind: "blocked"; violation: PolicyViolation } | ...`.
  This makes an invalid state (e.g. "settled but no payment receipt") unrepresentable
  instead of just "shouldn't happen."
- **`Result<T, E>` instead of throwing across package boundaries.** Guard
  validation, payment attempts, and provider calls all return a typed result
  (`{ ok: true; value: T } | { ok: false; error: E }`) so a caller in another
  package is forced by the type checker to handle the failure path, not just the
  happy path. Reserve real `throw` for genuinely unrecoverable programmer errors.
- **No `any`, no untyped `JSON.parse`.** `JSON.parse(x) as Foo` is banned; pipe it
  through `FooSchema.safeParse(JSON.parse(x))`.
- One schema per shape, always imported from `packages/schemas` — never redefine
  "what a task node looks like" or "what a ledger row looks like" a second time in
  `apps/api` or `apps/web`. If the UI needs a slightly different shape, derive it
  with `.pick()`/`.extend()` from the canonical schema, don't hand-write a parallel one.

## 6. Service consistency rules

- **One interface per provider type.** Zerion, the LLM provider, and any
  mock/adversarial provider used to demo the guard all implement the same
  `ProviderAdapter` shape from `packages/schemas` (`quote()`, `deliver()`,
  metadata for price/latency/quality). The router and treasury never special-case
  "this is Zerion" vs "this is the LLM" — if they need to, the adapter interface is
  incomplete and should be fixed there, not worked around at the call site.
- **Every paid call goes through the same path**, regardless of provider:
  `router.select() -> treasury.reserve() -> x402-client.pay() -> policy-guard.validate()
  -> treasury.settle() -> ledger.append()`. No provider gets a shortcut around
  the guard because "it's just Zerion, it's trusted" — the guard's whole point is
  that trust is established by validated schema, not by provider identity.
- **Idempotency keys are generated once, at task-node creation, in one place**
  (`packages/planner` or `packages/router` — pick one and be consistent), not
  re-derived ad hoc wherever a retry happens.
- **Money is never a `number` in dollars/ALGO anywhere in business logic.** Convert
  at the UI boundary only (display formatting), store and compute in microAlgo as
  a branded bigint/integer.
- **Environment config (facilitator URL, network, API keys) is loaded and
  validated once**, via a zod-validated env schema in `packages/schemas` (or a
  dedicated `packages/config`), not read from `process.env` scattered across files.
  Fail fast at boot if a required var is missing — not at first use mid-demo.
- **WebSocket messages to the UI use the same discriminated-union node-state types
  as the backend state machine** — don't invent a second "UI event" shape that the
  backend has to translate into. Serialize the real state.

## 7. Policy guard — implementation contract

Because this is the project's actual differentiator, be precise about it:

- Guard schemas are `.strict()` zod objects. A provider response with an extra
  field the schema doesn't declare fails validation — this is the mechanism that
  makes "budget mutation attempt" and "scope expansion attempt" structurally
  impossible to smuggle through, not just something a human reviewer would notice.
- A guard failure produces a typed `PolicyViolation` (`kind: "budget_mutation" |
  "scope_expansion" | "prompt_injection" | "receipt_forgery" | "schema_violation"`)
  and the task node transitions to `blocked`, not `failed` — these are different
  states in the ledger and the UI (§5's discriminated union).
- The guard is a pure function of `(schema, rawResponse)`. It never calls
  treasury, never calls the ledger directly — the orchestrator calls the guard,
  gets a `Result`, and decides what to do next. Keeping the guard side-effect-free
  makes it trivially unit-testable with adversarial fixtures.
- Receipt forgery check (if in scope): cross-verify a claimed settlement against
  an independent source — either the Algorand indexer directly, or Zerion's own
  transaction/portfolio endpoint for the treasury account — before marking a
  ledger row `settled`. Don't trust your own x402 client's self-reported success
  as the only signal for the stretch version of this check.

## 8. Commands

Adjust once the monorepo is actually wired up; keep this section current as you go.

```bash
pnpm install                     # from repo root, once
pnpm -r typecheck                # every package, strict mode, must be clean before merging
pnpm test                        # vitest run — tests/ covering schema round-trips, guard
                                 # fixtures, treasury lifecycle, and end-to-end flow
pnpm --filter api dev            # run the API locally against TestNet facilitator
pnpm --filter web dev            # run the UI
pnpm -r lint                     # eslint, shared config at root
```

A PR/commit that doesn't pass `pnpm -r typecheck` is not done, regardless of demo
time pressure — a type error in the treasury or guard path is exactly the class of
bug this architecture exists to prevent.

## 9. What agents should NOT do

- Don't import `algosdk` account/signing functions outside `packages/x402-client`.
- Don't write a new `zod` schema for a shape that already has one in
  `packages/schemas` — search first.
- Don't let the planner or router touch a budget number directly — always through
  `packages/treasury`'s exposed methods.
- Don't use `number` for on-chain amounts in business logic — microAlgo as a
  branded integer/bigint only.
- Don't special-case a specific provider's response inside the router/treasury —
  fix the shared `ProviderAdapter` interface instead.
- Don't invent EVM/`viem`/Base-Sepolia code from PRD familiarity — this build is
  AVM-only; if EVM code shows up in a diff, that's a scope regression.
- Don't mark a ledger row `settled` from a provider's self-reported status alone
  if the receipt-forgery check is in scope — cross-verify first.
- Don't skip `.safeParse()` on any provider or LLM response "just for this one
  quick test" — that's exactly the shortcut the guard exists to prevent, and it's
  easy to forget to remove before the demo.

## 10. Definition of done, per task-node feature

Before calling a slice of this done, confirm:

- [ ] Request/response/state shapes added to `packages/schemas`, `.strict()` where they guard a trust boundary
- [ ] No new `any`, no new bare `as` casts on external input
- [ ] Money values are branded microAlgo, not raw `number`
- [ ] Provider implements the shared `ProviderAdapter` interface, no special-casing upstream
- [ ] Payment path goes through treasury reserve → settle, not a direct pay call
- [ ] Guard validates the response before treasury/ledger touch it
- [ ] Ledger row written with idempotency key
- [ ] `pnpm -r typecheck` and relevant unit tests pass
- [ ] UI reflects the new state via the same discriminated union, not a parallel shape

## 11. PRD section mapping (what's actually in scope)

| PRD section | Status for this build |
|---|---|
| §3.1 Dynamic planner | In scope, as described |
| §3.2 Provider catalog | Narrowed: Zerion (wallet data) + LLM (summary/credit score) as the real providers; add 1–3 mock/adversarial providers only to demo the guard (§3.5) |
| §3.3 Adaptive route optimizer | Baseline weighted score is the target; bandit optimizer is stretch, only after §3.1/3.2/3.4/3.5 are solid |
| §3.4 Treasury/policy layer | In scope, as described — this is core |
| §3.5 Policy guard | In scope, core differentiator — keep it |
| §3.6 Fallback/recovery | In scope, scoped to the actual providers in use |
| §3.7 Reconciliation ledger + replay | In scope |
| §3.8 Live trace UI | In scope |
| §3.9 x402 Bazaar / open marketplace | Stretch only — the Algorand facilitator's Bazaar-equivalent discovery support should be verified against current docs before committing to it |
| §3.10 Zerion cross-check + treasury view | In scope — Zerion is already the primary data provider here, so the "independent settlement verification" idea doubles down on a dependency you already have, not a new one |
| Tech stack table (EVM/viem/Base Sepolia) | **Superseded** — see §3 of this file for the Algorand equivalents |
