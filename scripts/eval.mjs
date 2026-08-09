#!/usr/bin/env node
/**
 * Replay the recorded suite against both planners and print the result.
 *
 *   npm run eval
 *
 * Exits non-zero when the candidate regresses a case the baseline passes, so
 * this can gate a deploy rather than only inform one.
 */
import { compareSuites, verdictFor } from '../src/harness/index.js';

const { results, regressions, metrics, baseline, candidate } = compareSuites();

const pad = (s, n) => String(s).padEnd(n);
const mark = (ok) => (ok ? 'pass' : 'FAIL');

console.log(`\n  ${baseline.label}  →  ${candidate.label}`);
console.log(`  ${metrics.cases} recorded cases replayed against shadow connectors\n`);

console.log(`  ${pad('Recorded case', 42)}${pad(baseline.id, 8)}${pad(candidate.id, 8)}Δ latency`);
console.log('  ' + '─'.repeat(72));
for (const r of results) {
  console.log(
    `  ${pad(r.name, 42)}${pad(mark(r.baseline.pass), 8)}${pad(mark(r.candidate.pass), 8)}${r.deltaLabel}`
  );
}

console.log('\n  Metrics');
console.log(`    cases passed     ${metrics.baselinePassed}/${metrics.cases} → ${metrics.candidatePassed}/${metrics.cases}`);
console.log(`    tool calls       ${metrics.baselineCalls} → ${metrics.candidateCalls}`);
console.log(`    total latency    ${metrics.baselineMs}ms → ${metrics.candidateMs}ms`);
console.log(`    violations       ${metrics.violations}`);

const regressed = results.filter((r) => r.regressed);
if (regressed.length) {
  console.log('\n  Regressions');
  for (const r of regressed) {
    console.log(`\n    ${r.name}`);
    console.log(`      ${verdictFor(r)}`);
    // Show the metadata too — the divergence is often inside a call the two
    // planners both made, so tool names alone look deceptively identical.
    const step = (s) => `${s.tool} (${s.meta})`;
    console.log(`      ${baseline.id}: ${r.baseline.trace.map(step).join('\n              → ')}`);
    console.log(`      ${candidate.id}: ${r.candidate.trace.map(step).join('\n              → ')}`);
  }
}

console.log(
  regressions
    ? `\n  ${regressions} regression${regressions === 1 ? '' : 's'} — rollout should stay held.\n`
    : '\n  No regressions — the candidate is clear to promote.\n'
);

process.exit(regressions ? 1 : 0);
