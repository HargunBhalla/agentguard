import { formatMetric } from './metrics.js';

/**
 * The deployment gate.
 *
 * A build is not promoted because someone clicked promote — it is promoted
 * because it cleared a fixed set of thresholds. Each row below is a metric the
 * suite already produced, a direction, and the bar it has to clear; the gate is
 * the conjunction of them. That makes the decision reproducible: the same
 * suite on the same build gates the same way, and moving a bar is a visible
 * edit here rather than a judgement call on the screen.
 *
 * `critical` marks a row that cannot be traded off. A build that fails one is
 * blocked whatever its composite score says, because the failures these count
 * are writes to a customer's CRM that no rollback reaches.
 */
export const THRESHOLDS = [
  {
    key: 'stateAccuracy', label: 'CRM state accuracy', format: 'pct',
    better: 'up', bar: 0.98, weight: 3,
  },
  {
    key: 'policyViolationRate', label: 'Policy violations / run', format: 'num2',
    better: 'down', bar: 0, weight: 2, critical: true,
  },
  {
    key: 'recoverySuccessRate', label: 'Recovery success', format: 'pct',
    better: 'up', bar: 0.94, weight: 2,
  },
  {
    key: 'incorrectMutationRate', label: 'Unexpected mutations', format: 'pct',
    better: 'down', bar: 0.004, weight: 3, critical: true,
  },
  {
    key: 'duplicateActionRate', label: 'Duplicate actions', format: 'pct',
    better: 'down', bar: 0, weight: 2,
  },
  {
    key: 'taskCompletionRate', label: 'Task completion', format: 'pct',
    better: 'up', bar: 0.95, weight: 1,
  },
];

/**
 * How far past a bar of zero a metric may drift before it scores nothing.
 * Only used for rows whose bar is 0, where there is no ratio to take.
 */
const ZERO_BAR_BAND = 0.05;

/** Does one measurement clear its bar? A metric with nothing to measure passes. */
export function clears(row, value) {
  if (value == null) return true;
  return row.better === 'up' ? value >= row.bar : value <= row.bar;
}

/** How the measured value relates to the bar — the comparison the UI shows. */
function comparisonSign(row, value) {
  if (value == null) return row.better === 'up' ? '>=' : '<=';
  if (value < row.bar) return '<';
  if (value > row.bar) return '>=';
  return row.better === 'up' ? '>=' : '<=';
}

/**
 * How close a measurement came, as a 0–1 fraction of its bar. This is what
 * makes the score continuous: a build that misses 98% accuracy by a point
 * scores differently from one that misses it by thirty.
 */
function credit(row, value) {
  if (value == null) return 1;
  if (clears(row, value)) return 1;
  if (row.better === 'up') return row.bar === 0 ? 0 : Math.max(0, value / row.bar);
  // A downward metric is scored as a ratio, so missing a 0.4% bar by a tenth
  // of a point is not the same as missing it by twenty. A bar of zero has no
  // ratio to take, so it is scored against a fixed band instead.
  if (row.bar > 0) return Math.max(0, Math.min(1, row.bar / value));
  return Math.max(0, 1 - value / ZERO_BAR_BAND);
}

/**
 * Score a build's metrics against the gate.
 *
 * Returns the rows as they are rendered, the weighted composite out of 100,
 * and the gate's own verdict — `pass` only when every row clears, so the score
 * never talks a failing build through the gate.
 */
export function scorecard(metrics, { thresholds = THRESHOLDS } = {}) {
  const rows = thresholds.map((row) => {
    const value = metrics[row.key];
    const ok = clears(row, value);
    return {
      key: row.key,
      label: row.label,
      value: formatMetric(value, row.format),
      bar: formatMetric(row.bar, row.format),
      direction: comparisonSign(row, value),
      critical: !!row.critical,
      measured: value != null,
      ok,
      credit: credit(row, value),
      weight: row.weight,
    };
  });

  const totalWeight = rows.reduce((t, r) => t + r.weight, 0);
  const score = Math.round(rows.reduce((t, r) => t + r.credit * r.weight, 0) / totalWeight * 100);
  const failed = rows.filter((r) => !r.ok);

  return {
    rows,
    score,
    failed,
    criticalFailures: failed.filter((r) => r.critical).length,
    verdict: failed.length === 0 ? 'pass' : 'block',
  };
}
