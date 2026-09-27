/**
 * @sentinel/orchestrator
 *
 * XState v5 task + node machines for the Sentinel orchestrator (Phase 9).
 *
 * - NodeMachine (src/nodeMachine.ts): one actor per paid node —
 *   pending → routing → quoted → paying → paid → validating →
 *   settled | blocked | failed | waiting_approval.
 * - TaskMachine (src/taskMachine.ts): one actor per run —
 *   planning → executing ⇄ paused → executing → completed | aborted.
 * - createTaskRunner (src/taskRunner.ts): the driver that spawns node actors,
 *   forwards their signals back into the TaskMachine, and exposes the
 *   run/approve/reject/status/nodes API the service layer binds to HTTP.
 *
 * Trust boundaries are unchanged: treasury owns budget/scope, x402-client owns
 * the signer, policy-guard parses every provider response before it touches
 * treasury/ledger state, and the ledger is append-only.
 */

export { nodeMachine, type NodeInput, type NodeOutput, type NodeSignal } from "./nodeMachine.js";
export { taskMachine, type TaskInput, type TaskEvent, type TaskOutput } from "./taskMachine.js";
export {
  createTaskRunner,
  DEFAULT_RUN_CAP,
  type TaskRunner,
  type TaskRunnerOptions,
} from "./taskRunner.js";
export type { OrchestratorDeps } from "./types.js";
