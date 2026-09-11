import { CASES } from './cases.js';
import { mutations } from './metrics.js';

/**
 * Automated regression-test generation.
 *
 * A failure the suite found once is only worth something if it cannot come back
 * quietly. This turns a failing run into a case that can be checked in: the
 * smallest account that still reproduces it, the fault that triggered it, and
 * assertions on exactly the fields that went wrong.
 *
 * The minimisation is the part that makes these usable. A failure discovered
 * against a forty-record account is unreadable as a test; the same failure
 * against the three records actually involved is a test somebody will keep.
 *
 * Proposals are checked against the existing suite before being offered, so a
 * failure that an existing case already pins comes back marked as covered
 * rather than as a new test. A generator that only ever adds is a generator
 * that buries the suite.
 */

/** Record ids named by a projected field, e.g. deal.D-101.stage → D-101. */
function idIn(field) {
  const parts = field.split('.');
  return parts.length >= 3 ? parts[1] : null;
}

/**
 * What this failure is about, for deduplication against the existing suite.
 *
 * Every invariant that failed, not just the first - a run that both merged the
 * wrong records and clobbered a rep's edit is two findings, and collapsing it
 * to whichever check happens to be declared first would file it under the
 * wrong one.
 */
function signature(run) {
  const invariants = run.violations.map((v) => v.id).sort();
  const fields = run.score.misses.map((m) => m.field.replace(/\.[A-Z]-[\w-]+\./, '.*.')).sort();
  return [invariants.length ? `invariant:${invariants.join('+')}` : null, fields.length ? `state:${fields.join('|')}` : null]
    .filter(Boolean)
    .join(' & ');
}

/**
 * Cut the seed down to the records the failure actually needs: everything named
 * in a failing assertion, everything the run wrote to, and the owners, without
 * which nothing can be assigned.
 */
function minimizeSeed(seed, run) {
  const keep = new Set();
  for (const m of run.score.misses) {
    const id = idIn(m.field);
    if (id) keep.add(id);
  }
  for (const e of mutations(run.world)) keep.add(e.id);
  for (const e of run.world.audit || []) if (e.op === 'concurrent_write') keep.add(e.id);

  const records = {};
  let dropped = 0;
  for (const [type, rows] of Object.entries(seed.records || {})) {
    if (type === 'owner') {
      records[type] = rows;
      continue;
    }
    const kept = rows.filter((r) => keep.has(r.id));
    dropped += rows.length - kept.length;
    records[type] = kept;
  }

  // Identity is ground truth for the records that survived, and only those.
  const identity = {};
  for (const [id, who] of Object.entries(seed.identity || {})) if (keep.has(id)) identity[id] = who;

  return { seed: { records, identity, concurrent: seed.concurrent }, dropped, kept: keep.size };
}

/** Assertions pinning exactly what went wrong, at the value it should have had. */
function assertionsFor(run) {
  return Object.fromEntries(run.score.misses.map((m) => [m.field, m.want]));
}

/**
 * Every distinct thing that went wrong, in the order a reader needs them: the
 * checks that failed, then the state that proves it. Both, because an invariant
 * names the rule and a miss names the damage.
 */
function causes(run) {
  const out = run.violations.map((v) => `${v.expr} failed - ${v.detail}`);
  for (const m of run.score.misses.slice(0, 2)) {
    out.push(`${m.field} ended at ${m.got} where a correct run leaves ${m.want}`);
  }
  return out.length ? out : ['the run did not complete'];
}

const why = (run) => causes(run).slice(0, 2).join('; ');

/** A short name for the failure, taken from its most specific cause. */
function headline(run, testCase) {
  if (run.violations.length) {
    const ids = [...new Set(run.violations.map((v) => v.id))];
    return `${ids.join(' + ').replace(/_/g, ' ')} - minimised from ${testCase.id}`;
  }
  const m = run.score.misses[0];
  return m ? `${m.field} regression - minimised from ${testCase.id}` : `incomplete run - minimised from ${testCase.id}`;
}

/** Render a proposal as source a developer can paste into cases.js. */
function toSource(p) {
  const j = (v) => JSON.stringify(v, null, 2).split('\n').join('\n  ');
  return [
    '{',
    `  id: '${p.id}',`,
    `  name: ${JSON.stringify(p.name)},`,
    `  summary: ${JSON.stringify(p.why)},`,
    `  goal: ${JSON.stringify(p.goal)},`,
    p.fault ? `  fault: ${JSON.stringify(p.fault)},` : null,
    `  seed: ${j(p.seed)},`,
    `  expect: ${j(p.expect)},`,
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Propose a regression case from one failing run.
 * Returns null for a run that passed - there is nothing to pin.
 */
export function proposeFromRun(run, testCase, { existing = CASES } = {}) {
  if (run.pass) return null;

  const sig = signature(run);
  const { seed, dropped, kept } = minimizeSeed(testCase.seed, run);
  const expect = assertionsFor(run);

  // Covered means an existing case already pins every field this proposal
  // would pin, to the same value, under the same fault. Matching on the field
  // alone is not enough: c1 asserts deal.D-101.stage too, but it asserts the
  // stage a clean run produces, which is not the assertion that would have
  // caught a rep's edit being overwritten.
  const covered = Object.keys(expect).length
    ? existing.find((c) => {
        const sameFault = JSON.stringify(c.fault ?? null) === JSON.stringify(testCase.fault ?? null);
        const pins = Object.entries(expect).every(([f, want]) => (c.expect || {})[f] === want);
        return sameFault && pins;
      })
    : null;

  const proposal = {
    id: `gen-${testCase.id}-${run.build.replace(/\W/g, '')}`,
    from: { case: testCase.id, build: run.build, adapter: run.adapter },
    name: headline(run, testCase),
    why: why(run),
    causes: causes(run),
    goal: testCase.goal,
    fault: testCase.fault ?? null,
    seed,
    expect,
    signature: sig,
    covered: covered ? covered.id : null,
    novel: !covered,
    // How much smaller the reproduction is than the run that found it.
    reduction: { dropped, kept, from: Object.values(testCase.seed.records || {}).reduce((n, r) => n + r.length, 0) },
    unrecoverable: run.unrecoverable,
  };

  return { ...proposal, source: toSource(proposal) };
}

/**
 * Walk a build comparison and propose a regression case for every failure the
 * candidate produced, newest failures first. Proposals that an existing case
 * already pins are kept in the list and marked, because "this is already
 * covered by c3" is an answer worth showing rather than a row worth hiding.
 */
export function proposeTests(comparison, { cases = CASES } = {}) {
  const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
  const out = [];

  for (const row of comparison.results) {
    const testCase = byId[row.id];
    if (!testCase) continue;
    for (const run of [row.candidate, row.baseline]) {
      const p = proposeFromRun(run, testCase, { existing: cases });
      if (!p) continue;
      // One proposal per distinct failure, not one per build that hit it.
      if (out.some((x) => x.signature === p.signature && x.from.case === p.from.case)) continue;
      out.push(p);
    }
  }

  // Novel first: those are the ones that change the suite.
  return out.sort((a, b) => Number(b.novel) - Number(a.novel));
}
