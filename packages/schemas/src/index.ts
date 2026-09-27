/**
 * @sentinel/schemas
 *
 * Single source of truth for every shared type, zod schema, and branded
 * primitive in the Sentinel system.
 *
 * Rules:
 *  - No zod schema is defined outside this package.
 *  - Every trust boundary uses a .strict() schema + .safeParse().
 *  - All money values are MicroAlgo (bigint branded) — never plain number.
 *  - Discriminated unions, not status strings.
 *  - Result<T,E> returned across package boundaries — no throws.
 */

import { z } from "zod";

// ─── Re-exports ───────────────────────────────────────────────────────────────

export * from "./branded.js";
export * from "./result.js";
export * from "./capability.js";
export * from "./provider.js";
export * from "./llm.js";
export * from "./ledger.js";
export * from "./planner.js";
export * from "./orchestrator.js";
export * from "./guard.js";
export * from "./node-state.js";
export * from "./ws.js";
export * from "./json.js";
export * from "./routes/index.js";
export { z };
