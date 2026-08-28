import { createWorld, project } from './world.js';
import { makeOps } from './ops.js';
import { makeInjector } from './faults.js';
import { checkInvariants } from './invariants.js';
import { evaluate, POLICIES } from './policies.js';
import { planCompensation } from './recovery.js';
import { scoreRun, aggregate, METRIC_ROWS, isRegression } from './metrics.js';
import { CASES } from './cases.js';
import { v18, v19, BUILDS } from './agents.js';
import { hubspot, ADAPTERS, adapterById } from './adapters.js';

export { CASES, v18, v19, BUILDS, ADAPTERS, adapterById, METRIC_ROWS };
export { INVARIANTS } from './invariants.js';
export { POLICIES } from './policies.js';
export { aggregate, formatMetric, isRegression } from './metrics.js';

/** What a compensating rollback costs when a run leaves the CRM wrong. */
const ROLLBACK_MS = 340;

/**
 * Replay one case against one build on one CRM.
 *
 * The agent runs against a fresh shadow account, every operation is recorded,
 * and the CRM it leaves behind is checked three ways: against the invariants,
 * against the policy engine, and against the state the case said a correct run
 * produces. A run that leaves the account wrong also pays for the rollback a
 * real deployment would trigger, so a broken case reports slower as well as
 * incorrect.
 */
export function runCase(testCase, build, { adapter = hubspot, policies = POLICIES } = {}) {
  const world = createWorld(testCase.seed);
  const checkpoint = project(world);
  const trace = [];
  const hook = testCase.fault ? makeInjector(testCase.fault) : null;
  const ops = makeOps(world, trace, { adapter, hook });

  let report;
  try {
    report = build.run(testCase.goal, ops);
  } catch (err) {
    // An error that escaped the agent's own handling is itself a finding.
    report = { retries: 0, halted: true, skipped: [], errors: [{ code: err.code ?? null, message: err.message }], reason: err.message };
  }

  const violations = checkInvariants(world);
  const policyHits = evaluate({ before: checkpoint, after: project(world), world, trace, adapter }, policies);
  const ms = trace.reduce((n, s) => n + s.ms, 0) + (violations.length ? ROLLBACK_MS : 0);

  const plan = planCompensation(world, adapter);
  const unrecoverable = plan.filter((s) => s.class === 'irreversible');

  const score = scoreRun({ world, trace, report, violations, policyHits, ms }, testCase);

  return {
    case: testCase.name,
    caseId: testCase.id,
    build: build.id,
    adapter: adapter.id,
    pass: violations.length === 0 && score.misses.length === 0,
    violations,
    policyHits: policyHits.map((h) => ({ id: h.policy.id, name: h.policy.name, reasons: h.reasons })),
    trace,
    report,
    world,
    checkpoint,
    ms,
    score,
    // What a rollback could not put back. On a clean run this is empty; on a
    // run that merged the wrong records it is the whole point.
    unrecoverable: unrecoverable.map((s) => s.detail),
  };
}

export function runSuite(build, { adapter = hubspot, cases = CASES } = {}) {
  return cases.map((c) => runCase(c, build, { adapter }));
}

/**
 * The first step where two runs stop agreeing. Compared on the operation, the
 * record and the arguments that decide behaviour, so the same operation against
 * a different record — or with a version attached rather than not — counts as
 * divergence.
 */
function divergenceIndex(a, b) {
  const sig = (s) =>
    s && `${s.op}:${s.id ?? s.type ?? ''}:${s.args?.to ?? ''}:${s.args?.ifVersion ?? 'none'}:${s.status}`;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (sig(a[i]) !== sig(b[i])) return i;
  return -1;
}

/**
 * Replay the suite against both builds on one CRM and pair the results up.
 * This is what the build-comparison screen renders and what the deployment gate
 * is a decision about.
 */
export function compareBuilds(baseline = v18, candidate = v19, { adapter = hubspot, cases = CASES } = {}) {
  const results = cases.map((testCase) => {
    const base = runCase(testCase, baseline, { adapter });
    const cand = runCase(testCase, candidate, { adapter });
    const delta = cand.ms - base.ms;

    return {
      id: testCase.id,
      name: testCase.name,
      summary: testCase.summary,
      fault: testCase.fault ?? null,
      baseline: base,
      candidate: cand,
      divergesAt: divergenceIndex(base.trace, cand.trace),
      delta,
      deltaLabel: `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)}ms`,
      regressed: base.pass && !cand.pass,
      brokenInBoth: !base.pass && !cand.pass,
    };
  });

  const baseMetrics = aggregate(results.map((r) => r.baseline.score));
  const candMetrics = aggregate(results.map((r) => r.candidate.score));

  return {
    adapter,
    baseline,
    candidate,
    results,
    regressions: results.filter((r) => r.regressed).length,
    brokenInBoth: results.filter((r) => r.brokenInBoth).length,
    metrics: { baseline: baseMetrics, candidate: candMetrics },
    movedWrong: METRIC_ROWS.filter((row) => isRegression(row, baseMetrics, candMetrics)),
  };
}

/**
 * The same suite against every CRM.
 *
 * This is the reason the adapters exist. A build can be clean on one provider
 * and regress on another, because what a provider will let you take back is not
 * uniform — and a rollout decision made on one CRM's numbers is a rollout
 * decision made blind for the other two.
 */
export function compareAcrossCrms(baseline = v18, candidate = v19, { cases = CASES, adapters = ADAPTERS } = {}) {
  return adapters.map((adapter) => compareBuilds(baseline, candidate, { adapter, cases }));
}

/** Prose explanation of one case's outcome, for the comparison panel. */
export function verdictFor(row) {
  const { candidate, baseline } = row;

  if (row.regressed) {
    // Every check that failed, not just whichever is declared first. A run can
    // merge the wrong records and clobber a rep's edit in the same pass, and
    // naming one of the two sends somebody to debug half the problem.
    const causes = candidate.violations.map((v) => `${v.expr} failed — ${v.detail}`);
    if (!causes.length) {
      const miss = candidate.score.misses[0];
      causes.push(`the CRM ended with ${miss.field} = ${miss.got} where a correct run leaves ${miss.want}`);
    }
    const permanent = candidate.unrecoverable.length
      ? ` ${candidate.unrecoverable.length} of its writes are permanent on ${candidate.adapter} and no rollback reaches them.`
      : ` The run was rolled back, which is where the ${row.deltaLabel} went.`;
    return `${candidate.build} diverges at step ${row.divergesAt + 1} and leaves the account in a state the checks reject: ${causes.join('; and ')}.${permanent}`;
  }

  if (row.brokenInBoth) {
    const miss = candidate.score.misses[0];
    return (
      `Both builds fail this case, so it is not a regression — it is a defect neither version fixed. ` +
      (miss ? `The account ends with ${miss.field} = ${miss.got} where it should be ${miss.want}.` : '')
    );
  }

  if (row.divergesAt === -1) {
    return `Both builds issue the same calls and leave the same account behind. Latency moved ${row.deltaLabel}.`;
  }

  return (
    `The builds diverge at step ${row.divergesAt + 1} — ${baseline.trace.length} calls against ` +
    `${candidate.trace.length} — but reach the same final state, and every check holds. ` +
    `Latency moved ${row.deltaLabel}.`
  );
}

export { scorecard, THRESHOLDS, clears } from './scorecard.js';
