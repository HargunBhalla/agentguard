import { project, fieldsTouched } from './world.js';

/**
 * Agent evaluation metrics.
 *
 * The metric that matters most here is the one that is easiest to get wrong:
 * an agent is not correct because its calls returned 200, it is correct because
 * the CRM ended up in the right state. So every score below is computed against
 * the case's `expect` — the state a correct run leaves behind — rather than
 * against the agent's own account of what it did.
 *
 * Completion and correctness are deliberately separate. A build that stops at
 * the first hard failure completes fewer runs and makes fewer wrong writes; a
 * build that pushes through completes more and breaks more. Collapsing those
 * into one number is how a regression ships.
 */

const INTERNAL = new Set(['concurrent_write', 'compensate']);

/** Writes the agent itself made. */
export function mutations(world) {
  return (world.audit || []).filter((e) => !INTERNAL.has(e.op));
}

/**
 * Duplicate work: records this run created that duplicate something already
 * there. Writes the world deduplicated by idempotency key do not count — those
 * are retries that were caught, which is the system working.
 */
export function duplicateActions(world) {
  const groups = new Map();
  for (const e of mutations(world)) {
    if (e.before !== null) continue;
    const r = e.after;
    const signature =
      e.type === 'task' ? `task:${r.about}:${r.subject}`
      : e.type === 'note' ? `note:${r.about}:${r.body}`
      : e.type === 'contact' ? `contact:${String(r.email).toLowerCase()}`
      : `${e.type}:${e.id}`;
    groups.set(signature, (groups.get(signature) || 0) + 1);
  }
  let extras = 0;
  for (const n of groups.values()) extras += Math.max(0, n - 1);
  return extras;
}

/**
 * Score one run against what the case expected.
 *
 * A mutation is judged incorrect by consequence, not by intent: if any field it
 * touched ends the run disagreeing with the expected state, that is the write
 * that put it there.
 */
export function scoreRun({ world, trace, report, violations, policyHits, ms }, testCase) {
  const final = project(world);
  const expected = testCase.expect || {};

  const misses = Object.entries(expected)
    .filter(([field, want]) => (final[field] ?? '—') !== want)
    .map(([field, want]) => ({ field, want, got: final[field] ?? '—' }));

  const wrongFields = new Set(misses.map((m) => m.field));
  const writes = mutations(world);
  const incorrect = writes.filter((e) => fieldsTouched(e).some((f) => wrongFields.has(f)));

  const total = Object.keys(expected).length;
  const stateAccuracy = total === 0 ? 1 : (total - misses.length) / total;

  return {
    completed: !report.halted,
    halted: report.halted,
    reason: report.reason,
    mutations: writes.length,
    correctMutations: writes.length - incorrect.length,
    incorrectMutations: incorrect.length,
    duplicates: duplicateActions(world),
    violations: violations.length,
    policyViolations: policyHits.length,
    toolCalls: trace.length,
    retries: report.retries,
    errors: report.errors.length,
    skipped: report.skipped.length,
    ms,
    stateAccuracy,
    misses,
    // Only meaningful where something went wrong. Recovery is not "did it keep
    // going" — it is "did it end up where it should have anyway".
    recovered: testCase.fault ? misses.length === 0 : null,
  };
}

/** Suite-level rates, in the vocabulary the dashboard reports. */
export function aggregate(scores) {
  const n = scores.length || 1;
  const sum = (k) => scores.reduce((t, s) => t + (s[k] || 0), 0);
  const faulted = scores.filter((s) => s.recovered !== null);
  const totalMutations = sum('mutations');

  return {
    cases: scores.length,
    taskCompletionRate: sum('completed') / n,
    correctMutationRate: totalMutations ? sum('correctMutations') / totalMutations : 1,
    incorrectMutationRate: totalMutations ? sum('incorrectMutations') / totalMutations : 0,
    recoverySuccessRate: faulted.length ? faulted.filter((s) => s.recovered).length / faulted.length : null,
    policyViolationRate: sum('policyViolations') / n,
    duplicateActionRate: totalMutations ? sum('duplicates') / totalMutations : 0,
    avgToolCalls: sum('toolCalls') / n,
    avgRetries: sum('retries') / n,
    latencyMs: sum('ms') / n,
    stateAccuracy: sum('stateAccuracy') / n,
    invariantViolations: sum('violations'),
    passed: scores.filter((s) => s.violations === 0 && s.misses.length === 0).length,
  };
}

/**
 * The metrics table the build comparison renders. `better` says which direction
 * is an improvement, so a change can be read as progress or regression without
 * the reader holding the polarity of ten different rates in their head.
 */
export const METRIC_ROWS = [
  { key: 'taskCompletionRate', label: 'Task completion', format: 'pct', better: 'up' },
  { key: 'correctMutationRate', label: 'Correct mutations', format: 'pct', better: 'up' },
  { key: 'incorrectMutationRate', label: 'Incorrect mutations', format: 'pct', better: 'down' },
  { key: 'recoverySuccessRate', label: 'Recovery success', format: 'pct', better: 'up' },
  { key: 'stateAccuracy', label: 'CRM state accuracy', format: 'pct', better: 'up' },
  { key: 'policyViolationRate', label: 'Policy violations / run', format: 'num2', better: 'down' },
  { key: 'duplicateActionRate', label: 'Duplicate actions', format: 'pct', better: 'down' },
  { key: 'avgToolCalls', label: 'Tool calls / run', format: 'num1', better: 'down' },
  { key: 'avgRetries', label: 'Retries / run', format: 'num1', better: 'down' },
  { key: 'latencyMs', label: 'Latency / run', format: 'secs', better: 'down' },
];

export function formatMetric(value, format) {
  if (value == null) return '—';
  switch (format) {
    case 'pct': return `${(value * 100).toFixed(1)}%`;
    case 'num1': return value.toFixed(1);
    case 'num2': return value.toFixed(2);
    case 'secs': return `${(value / 1000).toFixed(2)}s`;
    default: return String(value);
  }
}

/** Did the candidate move this metric the wrong way? */
export function isRegression(row, base, cand) {
  const a = base[row.key];
  const b = cand[row.key];
  if (a == null || b == null) return false;
  return row.better === 'up' ? b < a : b > a;
}
