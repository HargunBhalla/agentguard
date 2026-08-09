import { createWorld } from './world.js';
import { makeTools } from './tools.js';
import { checkInvariants } from './invariants.js';
import { CASES } from './cases.js';
import { v14, v15 } from './planners.js';

export { CASES, v14, v15 };
export { INVARIANTS } from './invariants.js';

/** Cost of the compensating saga that runs when a case leaves the world dirty. */
const ROLLBACK_MS = 260;

/**
 * Replay one case against one planner.
 *
 * The planner runs against a fresh shadow world, every tool call is recorded,
 * and the world it leaves behind is checked against the invariants. A run that
 * violates one also pays for the rollback that a real deployment would trigger,
 * which is why failing cases come out slower as well as wrong.
 */
export function runCase(testCase, planner) {
  const world = createWorld(testCase.seed);
  const trace = [];
  const tools = makeTools(world, trace);

  let error = null;
  try {
    planner.run(testCase.goal, tools);
  } catch (e) {
    error = e.message;
  }

  const violations = error ? [{ id: 'planner_error', expr: 'run completes', detail: error }] : checkInvariants(world);
  const ms = trace.reduce((sum, s) => sum + s.ms, 0) + (violations.length ? ROLLBACK_MS : 0);

  return {
    case: testCase.name,
    planner: planner.id,
    pass: violations.length === 0,
    violations,
    trace,
    ms,
    world,
  };
}

/** Replay every case against one planner. */
export function runSuite(planner, cases = CASES) {
  return cases.map((c) => runCase(c, planner));
}

/**
 * Find the first step where two runs stop agreeing. Steps are compared on the
 * tool called and the metadata it reported, so a differing argument counts as
 * divergence even when the same tool was used.
 */
function divergenceIndex(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.tool !== y.tool || x.meta !== y.meta) return i;
  }
  return -1;
}

/**
 * Replay the suite against both planners and pair the results up — this is what
 * the Replay tab renders, and what the deployment gate is a decision about.
 */
export function compareSuites(baseline = v14, candidate = v15, cases = CASES) {
  const results = cases.map((testCase) => {
    const base = runCase(testCase, baseline);
    const cand = runCase(testCase, candidate);
    const at = divergenceIndex(base.trace, cand.trace);
    const delta = cand.ms - base.ms;

    return {
      name: testCase.name,
      actions: testCase.actions,
      baseline: base,
      candidate: cand,
      divergesAt: at,
      delta,
      deltaLabel: `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)}ms`,
      regressed: base.pass && !cand.pass,
    };
  });

  const regressions = results.filter((r) => r.regressed).length;
  const sum = (rs, k) => rs.reduce((n, r) => n + r[k].ms, 0);

  return {
    baseline,
    candidate,
    results,
    regressions,
    metrics: {
      cases: results.length,
      baselinePassed: results.filter((r) => r.baseline.pass).length,
      candidatePassed: results.filter((r) => r.candidate.pass).length,
      baselineCalls: results.reduce((n, r) => n + r.baseline.trace.length, 0),
      candidateCalls: results.reduce((n, r) => n + r.candidate.trace.length, 0),
      baselineMs: sum(results, 'baseline'),
      candidateMs: sum(results, 'candidate'),
      violations: results.reduce((n, r) => n + r.candidate.violations.length, 0),
    },
  };
}

/** Prose explanation of one case's outcome, for the comparison panel. */
export function verdictFor(row) {
  if (row.regressed) {
    const v = row.candidate.violations[0];
    return (
      `${row.candidate.planner} diverges at step ${row.divergesAt + 1} and leaves the world in a state ` +
      `the invariants reject — ${v.expr} failed: ${v.detail}. The run was rolled back, ` +
      `which is where the ${row.deltaLabel} went.`
    );
  }
  if (!row.baseline.pass && !row.candidate.pass) {
    return 'Both planners fail this case, so it is not a regression — the case itself needs attention.';
  }
  if (row.divergesAt === -1) {
    return `Both planners produce the same calls and the same final state. Latency moved ${row.deltaLabel}.`;
  }
  return (
    `The planners diverge at step ${row.divergesAt + 1} but reach the same final state, and every ` +
    `invariant holds. Latency moved ${row.deltaLabel}.`
  );
}
