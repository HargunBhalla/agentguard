#!/usr/bin/env node
/**
 * Replay the recorded suite against both agent builds, on every CRM.
 *
 *   npm run eval
 *
 * Exits non-zero when the candidate regresses a case the current build passes,
 * so this can gate a deploy rather than only inform one.
 */
import { compareAcrossCrms, METRIC_ROWS, formatMetric, isRegression, verdictFor } from '../src/harness/index.js';
import { proposeTests } from '../src/harness/testgen.js';

const pad = (s, n) => String(s).padEnd(n);
const mark = (ok) => (ok ? 'pass' : 'FAIL');

const runs = compareAcrossCrms();
const { baseline, candidate } = runs[0];

console.log(`\n  ${baseline.label}  →  ${candidate.label}`);
console.log(`  ${runs[0].results.length} recorded cases replayed against ${runs.length} shadow CRMs\n`);

let totalRegressions = 0;

for (const suite of runs) {
  const crm = suite.adapter.label;
  totalRegressions += suite.regressions;

  console.log(`  ${crm}`);
  console.log('  ' + '─'.repeat(78));
  console.log(`  ${pad('Recorded case', 46)}${pad(baseline.id, 8)}${pad(candidate.id, 8)}Δ latency`);
  for (const r of suite.results) {
    const tag = r.regressed ? '  ← regression' : r.brokenInBoth ? '  ← broken in both' : '';
    console.log(`  ${pad(r.name, 46)}${pad(mark(r.baseline.pass), 8)}${pad(mark(r.candidate.pass), 8)}${pad(r.deltaLabel, 10)}${tag}`);
  }

  console.log(`\n  ${pad('Metric', 30)}${pad(baseline.id, 12)}${pad(candidate.id, 12)}`);
  for (const row of METRIC_ROWS) {
    const a = suite.metrics.baseline[row.key];
    const b = suite.metrics.candidate[row.key];
    const flag = isRegression(row, suite.metrics.baseline, suite.metrics.candidate) ? '  ↓' : '';
    console.log(`  ${pad(row.label, 30)}${pad(formatMetric(a, row.format), 12)}${pad(formatMetric(b, row.format), 12)}${flag}`);
  }
  console.log('');
}

const hubspot = runs.find((s) => s.adapter.id === 'hubspot');

const regressed = hubspot.results.filter((r) => r.regressed);
if (regressed.length) {
  console.log('  Regressions');
  for (const r of regressed) {
    console.log(`\n    ${r.name}`);
    console.log(`      ${verdictFor(r)}`);
  }
  console.log('');
}

// Failures on one CRM and not another are not the build's fault, and reporting
// them as regressions would send somebody to debug the wrong thing.
const portability = runs.flatMap((s) =>
  s.results
    .filter((r) => r.brokenInBoth && hubspot.results.find((h) => h.id === r.id)?.brokenInBoth === false)
    .map((r) => `${r.name} fails on ${s.adapter.label} for both builds — ${r.baseline.score.misses[0]?.field}`)
);
if (portability.length) {
  console.log('  CRM-specific failures (not build regressions)');
  for (const line of [...new Set(portability)]) console.log(`    ${line}`);
  console.log('');
}

const proposals = proposeTests(hubspot);
const novel = proposals.filter((p) => p.novel);
console.log(`  Regression tests: ${proposals.length} failure${proposals.length === 1 ? '' : 's'} analysed · ${novel.length} need a new case`);
for (const p of novel) console.log(`    NEW  ${p.name} — ${p.why}`);
console.log('');

console.log(
  totalRegressions
    ? `  ${totalRegressions} regression${totalRegressions === 1 ? '' : 's'} across ${runs.length} CRMs — rollout should stay held.\n`
    : '  No regressions — the candidate is clear to promote.\n'
);

process.exit(totalRegressions ? 1 : 0);
