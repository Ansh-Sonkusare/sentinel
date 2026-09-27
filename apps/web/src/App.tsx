import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LedgerExport,
  LedgerRow,
  ProviderCatalogEntryWire,
  RunRequest,
  TaskGraph,
} from "@sentinel/schemas";
import TaskGraphView from "./components/TaskGraph";
import { useWs } from "./hooks/useWs";
import {
  approveTask,
  getFallbackGraph,
  getLedgerExport,
  getLedgerRows,
  getProviders,
  getStatus,
  rejectTask,
  runTask,
  setProviderFailed,
} from "./api";
import { budgetFraction, formatMicroAlgo, parseMicroAlgo } from "./format";

const DEFAULT_GOAL =
  "Assess this Algorand wallet: fetch its on-chain data, summarize the activity, and produce a credit score.";

const ATTACK_SCENARIOS = [
  { value: "none", label: "none", nodeId: undefined, providerId: undefined },
  { value: "budget_mutation", label: "budget mutation (n-wallet)", nodeId: "n-wallet", providerId: "mock-wallet-data-adversarial" },
  { value: "scope_expansion", label: "scope expansion (n-summary)", nodeId: "n-summary", providerId: "mock-summary-adversarial" },
] as const;

type AttackValue = (typeof ATTACK_SCENARIOS)[number]["value"];

/**
 * One-click demo flows. Each flow pre-configures the run inputs and the
 * provider fail/recover state so a presenter can drive a specific behavior of
 * the pipeline without touching the manual controls. All flows reset the
 * registry first (recover every provider), then apply their own failures.
 */
interface DemoFlow {
  id: string;
  label: string;
  description: string;
  /** What to watch for during/after the run. */
  watch: string;
  goal?: string;
  cap?: string;
  attackNode?: RunRequest["attackNode"];
  /** Provider ids to mark failed before the run (others are recovered). */
  failProviders?: string[];
}

const DEMO_FLOWS: DemoFlow[] = [
  {
    id: "happy",
    label: "Happy path",
    description: "All providers healthy — the planner, router, treasury, and guard complete the full graph.",
    watch: "n-wallet, n-summary, n-credit → settled",
  },
  {
    id: "guard-block",
    label: "Guard blocks an attack",
    description: "An adversarial provider is forced onto n-wallet and tries to smuggle a budget field back.",
    watch: "n-wallet → blocked · budget_mutation violation",
    attackNode: { nodeId: "n-wallet", providerId: "mock-wallet-data-adversarial" },
  },
  {
    id: "budget-pause",
    label: "Treasury pause",
    description: "A tight cap means the last reservation would overspend — the task pauses for approval.",
    watch: "task → paused · Approve or Reject the overspend",
    cap: "8",
  },
  {
    id: "outage",
    label: "Provider outage",
    description: "Every fetch_wallet_data provider is down — that node fails while the rest of the graph settles.",
    watch: "n-wallet → failed · fallback exhausts",
    failProviders: ["mock-wallet-data", "mock-wallet-data-adversarial"],
  },
];

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export default function App() {
  const { state, watch, clear, hydrate } = useWs();

  // ─── Run controls ───────────────────────────────────────────────────────────
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [cap, setCap] = useState("");
  const [attack, setAttack] = useState<AttackValue>("none");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [delta, setDelta] = useState("");

  // ─── Data ───────────────────────────────────────────────────────────────────
  const [providers, setProviders] = useState<ProviderCatalogEntryWire[]>([]);
  const [fallbackGraph, setFallbackGraph] = useState<TaskGraph | null>(null);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [replayTaskId, setReplayTaskId] = useState("");
  const [replayExport, setReplayExport] = useState<LedgerExport | null>(null);
  const [tab, setTab] = useState<"events" | "replay">("events");

  const eventsRef = useRef<HTMLDivElement | null>(null);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await getProviders());
    } catch {
      setProviders([]);
    }
  }, []);

  const refreshLedger = useCallback(async () => {
    try {
      setLedgerRows(await getLedgerRows());
    } catch {
      setLedgerRows([]);
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
    getFallbackGraph().then(setFallbackGraph).catch(() => undefined);
  }, [refreshProviders]);

  // Reload the ledger when the watched task reaches a terminal state or blocks
  // a node — so the ledger pane shows the settled/blocked rows for the run.
  useEffect(() => {
    if (state.status === "completed" || state.status === "aborted") {
      void refreshLedger();
    }
  }, [state.status, refreshLedger]);

  // Keep the events log pinned to the newest entry.
  useEffect(() => {
    const el = eventsRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [state.events.length]);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleRun = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    const body: RunRequest = { goal };
    if (/^\d+$/.test(cap)) body.cap = cap;
    const scenario = ATTACK_SCENARIOS.find((s) => s.value === attack);
    if (scenario !== undefined && scenario.nodeId !== undefined && scenario.providerId !== undefined) {
      body.attackNode = { nodeId: scenario.nodeId, providerId: scenario.providerId };
    }
    try {
      const { taskId } = await runTask(body);
      watch(taskId);
      try {
        hydrate(await getStatus(taskId));
      } catch {
        // planning not finished yet — WS frames will fill the graph
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [goal, cap, attack, running, watch, hydrate]);

  const handleApprove = useCallback(async () => {
    if (state.taskId === null || !/^\d+$/.test(delta)) return;
    setRunError(null);
    try {
      hydrate(await approveTask(state.taskId, delta));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, [state.taskId, delta, hydrate]);

  const handleReject = useCallback(async () => {
    if (state.taskId === null) return;
    setRunError(null);
    try {
      await rejectTask(state.taskId);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, [state.taskId]);

  const handleReplay = useCallback(async () => {
    const id = replayTaskId.trim();
    if (id === "") return;
    setRunError(null);
    try {
      watch(id);
      try {
        hydrate(await getStatus(id));
      } catch {
        // task may no longer be in memory — ledger export still works
      }
      const exp = await getLedgerExport(id);
      setReplayExport(exp);
      setLedgerRows(exp.rows);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, [replayTaskId, watch, hydrate]);

  const toggleProvider = useCallback(
    async (id: string, failed: boolean) => {
      try {
        await setProviderFailed(id, failed);
      } catch {
        // keep going — refresh reflects the actual state
      }
      await refreshProviders();
    },
    [refreshProviders],
  );

  // ─── Derived ────────────────────────────────────────────────────────────────

  const graph = state.graph ?? fallbackGraph;
  const budget = state.budget;
  const pause = state.pauseInfo;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Sentinel</div>
        <div className="topbar-spacer" />
        <span className={`dot ${state.connected ? "dot-ok" : "dot-bad"}`} />
        <span className="muted">{state.connected ? "ws connected" : "ws reconnecting…"}</span>
        {state.taskId !== null && <span className="chip chip-task">{state.taskId}</span>}
        <span className={`chip chip-status status-${state.status}`}>{state.status}</span>
        {state.planSource !== null && <span className="chip">{state.planSource}</span>}
        <button
          className="btn ghost"
          onClick={clear}
          disabled={state.taskId === null}
        >
          clear
        </button>
      </header>

      <div className="body">
        <aside className="sidebar">
          <section className="panel">
            <h3>Run</h3>
            <label htmlFor="goal">Goal</label>
            <input id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <label htmlFor="cap">Cap (µA, optional)</label>
            <input
              id="cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="default 1000"
              inputMode="numeric"
            />
            <label htmlFor="attack">Attack scenario</label>
            <select
              id="attack"
              value={attack}
              onChange={(e) => setAttack(e.target.value as AttackValue)}
            >
              {ATTACK_SCENARIOS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              className="btn primary"
              onClick={handleRun}
              disabled={running || !state.connected || goal.trim() === ""}
            >
              {running ? "starting…" : "Run task"}
            </button>
            {runError !== null && <div className="error-banner">{runError}</div>}
          </section>

          {state.status === "paused" && pause !== null && (
            <section className="panel panel-paused">
              <h3>Approval required</h3>
              <div className="pause-line">
                projected {formatMicroAlgo(pause.projected)} · cap {formatMicroAlgo(pause.cap)}
              </div>
              <div className="pause-line overspend">
                overspend {formatMicroAlgo(pause.overspend)}
              </div>
              <label htmlFor="delta">Approve delta (µA)</label>
              <input
                id="delta"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder={pause.overspend}
                inputMode="numeric"
              />
              <div className="btn-row">
                <button
                  className="btn primary"
                  onClick={handleApprove}
                  disabled={!/^\d+$/.test(delta)}
                >
                  Approve
                </button>
                <button className="btn danger" onClick={handleReject}>
                  Reject
                </button>
              </div>
            </section>
          )}

          <section className="panel">
            <h3>Blocked by guard</h3>
            {state.violations.length === 0 ? (
              <p className="muted">nothing blocked</p>
            ) : (
              state.violations.map((v) => (
                <div className="violation-card" key={`${v.nodeId}-${v.violation.id}`}>
                  <div className="violation-title">
                    ⛔ {v.nodeId} · {v.violation.type}
                  </div>
                  <div className="violation-msg">{v.violation.message}</div>
                  <div className="violation-fields">
                    rejected: {v.violation.rejected_fields.join(", ") || "—"}
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="panel">
            <h3>
              Providers{" "}
              <button className="btn ghost sm" onClick={() => void refreshProviders()}>
                refresh
              </button>
            </h3>
            {providers.length === 0 && <p className="muted">no providers listed</p>}
            {providers.map((p) => (
              <div
                className={`provider-row ${p.failed === true ? "provider-failed" : ""}`}
                key={p.provider_id}
              >
                <div className="provider-main">
                  <span className="provider-id">{p.provider_id}</span>
                  <span className="provider-cap">{p.capability}</span>
                  {p.integration === "x402" && (
                    <span className="x402-tag" title="Real x402 resource server — settlement is a real TestNet transaction">
                      x402
                    </span>
                  )}
                </div>
                <div className="provider-sub">
                  {formatMicroAlgo(p.price_micro_algo)} · q{p.quality_score.toFixed(2)} · {p.role}
                  {p.failed === true && <span className="failed-tag"> failed</span>}
                </div>
                <div className="provider-actions">
                  {p.failed === true ? (
                    <button
                      className="btn sm"
                      onClick={() => void toggleProvider(p.provider_id, false)}
                    >
                      recover
                    </button>
                  ) : (
                    <button
                      className="btn sm danger"
                      onClick={() => void toggleProvider(p.provider_id, true)}
                    >
                      fail
                    </button>
                  )}
                </div>
              </div>
            ))}
          </section>
        </aside>

        <main className="stage">
          <div className="budget-bar-wrap">
            {budget === null ? (
              <span className="muted">no budget reserved yet</span>
            ) : (
              <BudgetBar
                spent={parseMicroAlgo(budget.spent)}
                reserved={parseMicroAlgo(budget.reserved)}
                available={parseMicroAlgo(budget.available)}
                cap={parseMicroAlgo(budget.cap)}
              />
            )}
          </div>
          {state.goal !== null && <div className="goal-line">{state.goal}</div>}
          <div className="graph-wrap">
            {graph === null ? (
              <div className="empty-state">
                <p>No task graph yet.</p>
                <p className="muted">Run a task to see the plan and live node states.</p>
              </div>
            ) : (
              <TaskGraphView graph={graph} nodeStates={state.nodes} />
            )}
          </div>
        </main>

        <aside className="inspector">
          <div className="tabs">
            <button
              className={`tab ${tab === "events" ? "active" : ""}`}
              onClick={() => setTab("events")}
            >
              Events
            </button>
            <button
              className={`tab ${tab === "replay" ? "active" : ""}`}
              onClick={() => setTab("replay")}
            >
              Ledger
            </button>
          </div>

          {tab === "events" ? (
            <div className="events" ref={eventsRef}>
              {state.events.length === 0 && <p className="muted">waiting for events…</p>}
              {state.events.map((e, i) => (
                <div className="event" key={i}>
                  <span className="event-time">{timeOf(e.at)}</span>
                  <span className="event-text">{e.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="replay">
              <div className="replay-actions">
                <input
                  value={replayTaskId}
                  onChange={(e) => setReplayTaskId(e.target.value)}
                  placeholder="task id (t-…)"
                />
                <button
                  className="btn sm"
                  onClick={() => void handleReplay()}
                  disabled={replayTaskId.trim() === ""}
                >
                  Load task
                </button>
                <button className="btn sm" onClick={() => void refreshLedger()}>
                  All rows
                </button>
              </div>
              {replayExport !== null && (
                <div className="export-info">
                  task {replayExport.task_id}: {replayExport.row_count} rows · replayed at{" "}
                  {timeOf(replayExport.exported_at)}
                </div>
              )}
              {ledgerRows.length === 0 ? (
                <p className="muted">no ledger rows yet</p>
              ) : (
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>node</th>
                      <th>provider</th>
                      <th>outcome</th>
                      <th>viol</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRows.map((r) => (
                      <tr key={r.ledger_id}>
                        <td title={r.ledger_id}>{r.node_id}</td>
                        <td title={r.idempotency_key}>{r.provider_id}</td>
                        <td className={`outcome-${r.outcome}`}>{r.outcome}</td>
                        <td>{r.violations?.length ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function BudgetBar({
  spent,
  reserved,
  available,
  cap,
}: {
  spent: bigint;
  reserved: bigint;
  available: bigint;
  cap: bigint;
}) {
  const frac = budgetFraction(spent, reserved, cap);
  return (
    <div className="budget-bar">
      <div className="budget-track">
        <div className="budget-fill" style={{ width: `${(frac * 100).toFixed(1)}%` }} />
      </div>
      <div className="budget-labels">
        <span>cap {formatMicroAlgo(cap)}</span>
        <span>spent {formatMicroAlgo(spent)}</span>
        <span>reserved {formatMicroAlgo(reserved)}</span>
        <span>available {formatMicroAlgo(available)}</span>
      </div>
    </div>
  );
}
