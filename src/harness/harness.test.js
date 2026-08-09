import { describe, it, expect } from 'vitest';
import { createWorld, overlaps, similarity, days } from './world.js';
import { makeTools } from './tools.js';
import { checkInvariants } from './invariants.js';
import { compareSuites, runCase, runSuite, CASES, v14, v15 } from './index.js';
import { rehearse, rehearseAll, PROPOSAL, POLICIES, SEED, project } from './shadow.js';
import { runChaos } from './chaos.js';
import { runTrace, runSaga } from './trace.js';

describe('world primitives', () => {
  it('treats touching ranges as overlapping and disjoint ones as not', () => {
    expect(overlaps({ from: '2026-08-12', to: '2026-08-15' }, { from: '2026-08-15', to: '2026-08-16' })).toBe(true);
    expect(overlaps({ from: '2026-08-12', to: '2026-08-14' }, { from: '2026-08-15', to: '2026-08-16' })).toBe(false);
  });

  it('enumerates days inclusively across a month boundary', () => {
    expect(days('2026-08-30', '2026-09-01')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
  });

  it('scores the contact pair that separates the two planners between their thresholds', () => {
    // The whole dedupe regression hinges on this landing above 0.90 and below
    // 0.95. If it drifts outside that band the case stops testing anything.
    const score = similarity('marcus.hale@abcconstruction.com', 'marcus.hales@abcconstruction.com');
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThan(0.95);
  });
});

describe('availability reads', () => {
  const seed = {
    units: { 184: { reservations: [{ id: 'R-2209', from: '2026-08-15', to: '2026-08-16' }] } },
  };

  it('sees an interior conflict when scanning day by day', () => {
    const trace = [];
    const t = makeTools(createWorld(seed), trace);
    expect(t.inventory.check({ unit: '184', from: '2026-08-12', to: '2026-08-17', perDay: true }).available).toBe(false);
  });

  it('misses that same conflict when probing only the window endpoints', () => {
    const trace = [];
    const t = makeTools(createWorld(seed), trace);
    expect(t.inventory.check({ unit: '184', from: '2026-08-12', to: '2026-08-17', perDay: false }).available).toBe(true);
  });

  it('does not report a reservation as conflicting with itself', () => {
    const t = makeTools(createWorld({ units: { 184: { reservations: [{ id: 'R-1', from: '2026-08-12', to: '2026-08-14' }] } } }), []);
    expect(t.inventory.check({ unit: '184', from: '2026-08-12', to: '2026-08-14', perDay: true, ignore: 'R-1' }).available).toBe(true);
  });
});

describe('invariants', () => {
  it('catches overlapping holds on one unit', () => {
    const world = createWorld({
      units: { 184: { reservations: [
        { id: 'a', from: '2026-08-12', to: '2026-08-16' },
        { id: 'b', from: '2026-08-15', to: '2026-08-17' },
      ] } },
    });
    expect(checkInvariants(world).map((v) => v.id)).toContain('no_overlap');
  });

  it('passes a clean world', () => {
    expect(checkInvariants(createWorld({}))).toEqual([]);
  });

  it('catches a bulk send over the external recipient cap', () => {
    const world = createWorld({});
    makeTools(world, []).gmail.send({ to: Array.from({ length: 68 }, (_, i) => `x${i}@y.com`) });
    expect(checkInvariants(world).map((v) => v.id)).toContain('external_email_count');
  });
});

describe('replay suite', () => {
  const suite = compareSuites();

  it('passes every case on the baseline', () => {
    expect(runSuite(v14).every((r) => r.pass)).toBe(true);
  });

  it('regresses exactly the double-booking and duplicate-contact cases', () => {
    expect(suite.results.filter((r) => r.regressed).map((r) => r.name)).toEqual([
      'Extend a rental over a booked weekend',
      'Duplicate site contact merge',
    ]);
  });

  it('attributes each regression to the invariant that actually failed', () => {
    const byName = Object.fromEntries(suite.results.map((r) => [r.name, r]));
    expect(byName['Extend a rental over a booked weekend'].candidate.violations[0].id).toBe('no_overlap');
    expect(byName['Duplicate site contact merge'].candidate.violations[0].id).toBe('no_duplicate_contacts');
  });

  it('charges a regressing run for the rollback, so it reports slower', () => {
    for (const r of suite.results.filter((x) => x.regressed)) expect(r.delta).toBeGreaterThan(0);
  });

  it('is deterministic across runs', () => {
    expect(compareSuites().results.map((r) => r.delta)).toEqual(suite.results.map((r) => r.delta));
  });

  it('reports no divergence when a planner is compared against itself', () => {
    const same = compareSuites(v14, v14);
    expect(same.regressions).toBe(0);
    expect(same.results.every((r) => r.divergesAt === -1)).toBe(true);
  });
});

describe('pre-flight rehearsal', () => {
  const rehearsed = rehearseAll();
  const byId = Object.fromEntries(rehearsed.map((a) => [a.id, a]));

  it('rehearses without touching the seed world', () => {
    const before = JSON.stringify(SEED);
    rehearseAll();
    expect(JSON.stringify(SEED)).toBe(before);
  });

  it('derives a diff for every proposed call', () => {
    expect(rehearsed.every((a) => a.diff.length > 0)).toBe(true);
  });

  it('trips the double-booking policy on the excavator hold, and nothing else', () => {
    expect(byId.a1.trips).toEqual(['p1']);
    expect(byId.a2.trips).toEqual([]);
    expect(byId.a3.trips).toEqual([]);
  });

  it('trips the bulk-send policy only on the 68-recipient digest', () => {
    expect(byId.a4.trips).toEqual([]);
    expect(byId.a5.trips).toEqual(['p4']);
  });

  it('measures blast radius rather than describing it', () => {
    expect(byId.a5.blast).toContain('68 recipients');
    expect(byId.a5.blast).toContain('irreversible');
    expect(byId.a2.blast).toContain('reversible');
  });

  it('reports a call as clean once the policy it trips is removed', () => {
    // The point of policies-as-predicates: nothing is asserting a1 is bad.
    const withoutP1 = POLICIES.filter((p) => p.id !== 'p1');
    const world = createWorld(SEED);
    const before = project(world);
    PROPOSAL[0].apply(makeTools(world, []));
    const ctx = { before, after: project(world), world, trace: [] };
    expect(withoutP1.filter((p) => p.test(ctx))).toEqual([]);
  });
});

describe('chaos recovery', () => {
  it('recovers a transient fault with no duplicates and a clean world', () => {
    const { outcome, duplicates, halted } = runChaos({ fault: 'f1', stepId: 'gmail.send' });
    expect([duplicates, halted]).toEqual([0, false]);
    expect(outcome.checks.find((c) => c.label === 'State consistency').value).toBe('Clean');
  });

  it('halts and rolls back to the checkpoint when the retry budget is spent', () => {
    const { outcome, halted } = runChaos({ fault: 'f1', stepId: 'gmail.send', mods: { persist: true } });
    expect(halted).toBe(true);
    // Regression guard: rollback used to leave behind a unit key the
    // checkpoint never had, which read as drift on every halted run.
    expect(outcome.checks.find((c) => c.label === 'State consistency').value).toBe('Clean');
  });

  it('resumes in place after an OAuth refresh rather than crediting backoff', () => {
    const { outcome, halted } = runChaos({ fault: 'f3', stepId: 'gmail.send', mods: { expire: true } });
    expect(halted).toBe(false);
    expect(outcome.checks.find((c) => c.label === 'Recovered').note).toMatch(/refresh/i);
  });

  it('writes twice when a corrupted response costs the agent its idempotency key', () => {
    const { outcome, duplicates } = runChaos({ fault: 'f6', stepId: 'gmail.send', mods: { corrupt: true } });
    expect(duplicates).toBe(1);
    expect(outcome.checks.find((c) => c.label === 'State consistency').value).toBe('Diverged');
  });

  it('injects into whichever step was selected', () => {
    const { log } = runChaos({ fault: 'f2', stepId: 'crm.update' });
    expect(log.some((l) => l.text.includes('crm.update'))).toBe(true);
  });
});

describe('trace view', () => {
  const spans = runTrace();

  it('lays spans out over the full timeline without gaps', () => {
    expect(spans[0].left).toBe(0);
    const last = spans.at(-1);
    expect(last.left + last.width).toBeCloseTo(100, 6);
  });

  it('reports the diff and violation counts the rehearsal actually found', () => {
    const sim = JSON.parse(spans.find((s) => s.name === 'agentguard.simulate').result);
    expect(sim.diffs).toBe(rehearseAll().reduce((n, a) => n + a.diff.length, 0));
    expect(sim.violations).toBe(rehearseAll().filter((a) => a.trips.length).length);
  });

  it('carries parseable args and results on every span', () => {
    for (const s of spans) {
      expect(() => JSON.parse(s.args)).not.toThrow();
      expect(() => JSON.parse(s.result)).not.toThrow();
    }
  });

  it('marks the saga step that failed and leaves the later ones unrun', () => {
    const states = runSaga().steps.map((s) => s.state);
    expect(states).toEqual(['committed', 'failed', 'not run', 'not run']);
  });
});
