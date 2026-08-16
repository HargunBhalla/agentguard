import { describe, it, expect } from 'vitest';

import {
  createWorld, all, get, put, insert, remove, project, diffProjections,
  fieldsTouched, similarity, matchConfidence,
} from './world.js';
import { makeOps, CrmError } from './ops.js';
import { hubspot, salesforce, attio, ADAPTERS, adapterById } from './adapters.js';
import { checkInvariants, INVARIANTS } from './invariants.js';
import { evaluate, POLICIES, MERGE_CONFIDENCE, BULK_MUTATION_CAP } from './policies.js';
import { planCompensation, compensate, rollback, classify } from './recovery.js';
import { makeInjector, FAULTS, faultById } from './faults.js';
import { scoreRun, aggregate, duplicateActions, isRegression, formatMetric, METRIC_ROWS } from './metrics.js';
import { ACCOUNT, GOAL, STAGES, stageIndex, isClosed, HIGH_VALUE } from './schema.js';
import { SEED } from './shadow.js';
import { v18, v19, BUILDS } from './agents.js';
import { CASES } from './cases.js';
import { runCase, runSuite, compareBuilds, compareAcrossCrms, verdictFor } from './index.js';

/** A world seeded from the demo account, plus an ops surface over it. */
function bench({ adapter = hubspot, seed = SEED, hook = null } = {}) {
  const world = createWorld(seed);
  const trace = [];
  return { world, trace, ops: makeOps(world, trace, { adapter, hook }) };
}

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------

describe('world', () => {
  it('seeds records with a version and a clock stamp', () => {
    const { world } = bench();
    const deal = get(world, 'deal', 'D-101');
    expect(deal.stage).toBe('Discovery');
    expect(deal._v).toBe(1);
    expect(deal._updated).toBe(0);
  });

  it('does not alias the seed — two worlds mutate independently', () => {
    const a = createWorld(SEED);
    const b = createWorld(SEED);
    put(a, 'deal', 'D-101', { stage: 'Qualified' });
    expect(get(a, 'deal', 'D-101').stage).toBe('Qualified');
    expect(get(b, 'deal', 'D-101').stage).toBe('Discovery');
    expect(ACCOUNT.records.deal[0].stage).toBe('Discovery');
  });

  it('bumps the version and records prior values on every write', () => {
    const { world } = bench();
    put(world, 'deal', 'D-101', { stage: 'Qualified' });
    const deal = get(world, 'deal', 'D-101');
    expect(deal._v).toBe(2);
    expect(deal._updated).toBeGreaterThan(0);

    const entry = world.audit.at(-1);
    expect(entry.before).toEqual({ stage: 'Discovery' });
    expect(entry.after).toEqual({ stage: 'Qualified' });
  });

  it('put on a missing record is a no-op rather than a throw', () => {
    const { world } = bench();
    expect(put(world, 'deal', 'nope', { stage: 'Qualified' })).toBeNull();
    expect(world.audit).toHaveLength(0);
  });

  it('the clock is monotonic across writes', () => {
    const { world } = bench();
    put(world, 'deal', 'D-101', { stage: 'Qualified' });
    insert(world, 'note', { id: 'N-9', about: 'D-101', body: 'hi' });
    remove(world, 'deal', 'D-104');
    const stamps = world.audit.map((e) => e.at);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('projects the operator-visible fields and hides bookkeeping', () => {
    const { world } = bench();
    const shot = project(world);
    expect(shot['deal.D-101.stage']).toBe('Discovery');
    expect(shot['company.A-200.owner_id']).toBe('—');
    expect(shot['contact.count']).toBe('5');
    expect(Object.keys(shot).some((k) => k.includes('_v') || k.includes('_updated'))).toBe(false);
  });

  it('a version bump alone is not a diff', () => {
    const { world } = bench();
    const before = project(world);
    put(world, 'deal', 'D-101', { stage: 'Discovery' }); // same value, new version
    expect(diffProjections(before, project(world))).toEqual([]);
  });

  it('diffs a real change with both sides', () => {
    const { world } = bench();
    const before = project(world);
    put(world, 'deal', 'D-101', { stage: 'Qualified' });
    expect(diffProjections(before, project(world))).toEqual([
      { field: 'deal.D-101.stage', before: 'Discovery', after: 'Qualified' },
    ]);
  });

  it('attributes creates and deletes to the type count', () => {
    expect(fieldsTouched({ type: 'task', id: 'T-1', before: null, after: { id: 'T-1' } })).toEqual(['task.count']);
    expect(fieldsTouched({ type: 'contact', id: 'C-1', before: { id: 'C-1' }, after: null })).toEqual(['contact.count']);
    expect(fieldsTouched({ type: 'deal', id: 'D-101', before: { stage: 'a' }, after: { stage: 'b' } }))
      .toEqual(['deal.D-101.stage']);
  });
});

// ---------------------------------------------------------------------------
// similarity — the fixture bands the whole merge story rests on
// ---------------------------------------------------------------------------

describe('match confidence', () => {
  it('is 1 for identical strings and 0 for nothing in common', () => {
    expect(similarity('acme', 'acme')).toBe(1);
    expect(similarity('abcd', 'wxyz')).toBe(0);
    expect(similarity('', '')).toBe(0);
  });

  it('is symmetric', () => {
    expect(similarity('marcus hale', 'marcus j hale')).toBeCloseTo(similarity('marcus j hale', 'marcus hale'), 10);
  });

  // schema.js promises these two bands. A fixture that drifts out of its band
  // stops testing anything, so both are pinned rather than merely ordered.
  it('puts the true duplicate above the merge bar', () => {
    const [c201, c205] = [ACCOUNT.records.contact[0], ACCOUNT.records.contact[1]];
    expect(matchConfidence(c201, c205)).toBeGreaterThan(MERGE_CONFIDENCE);
  });

  it('puts the two different Reyeses in the 0.90-0.95 trap band', () => {
    const [c301, c302] = [ACCOUNT.records.contact[2], ACCOUNT.records.contact[3]];
    const score = matchConfidence(c301, c302);
    expect(score).toBeGreaterThanOrEqual(v19.settings.mergeConfidence);
    expect(score).toBeLessThanOrEqual(MERGE_CONFIDENCE);
  });

  it('weights email over name', () => {
    const sameEmail = matchConfidence(
      { email: 'a@x.example', name: 'Completely Different' },
      { email: 'a@x.example', name: 'Nothing Alike' },
    );
    const sameName = matchConfidence(
      { email: 'totally@different.example', name: 'Marcus Hale' },
      { email: 'nothing@alike.example', name: 'Marcus Hale' },
    );
    expect(sameEmail).toBeGreaterThan(sameName);
  });
});

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

describe('ops', () => {
  it('records a span per call with latency and the native request', () => {
    const { trace, ops } = bench();
    ops.get_record({ type: 'deal', id: 'D-101' });
    expect(trace).toHaveLength(1);
    const [span] = trace;
    expect(span.op).toBe('get_record');
    expect(span.status).toBe('ok');
    expect(span.adapter).toBe('hubspot');
    expect(span.ms).toBe(hubspot.cost.get_record);
    expect(span.native.method).toBe('GET');
    expect(span.native.path).toContain('D-101');
  });

  it('search filters on predicates as well as values', () => {
    const { ops } = bench();
    expect(ops.search_records({ type: 'company', where: { owner_id: null } }).count).toBe(3);
    expect(ops.search_records({ type: 'deal', where: { amount: (v) => v >= HIGH_VALUE } }).records
      .map((d) => d.id)).toEqual(['D-102']);
  });

  it('honours the search limit', () => {
    const { ops } = bench();
    expect(ops.search_records({ type: 'deal', limit: 2 }).records).toHaveLength(2);
  });

  it('a 404 is not transient', () => {
    const { ops } = bench();
    try {
      ops.get_record({ type: 'deal', id: 'D-nope' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CrmError);
      expect(err.code).toBe(404);
      expect(err.transient).toBe(false);
    }
  });

  it('an idempotency key makes a replayed write a no-op', () => {
    const { world, ops } = bench();
    ops.create_task({ about: 'D-101', subject: 'Follow up', key: 'task:D-101' });
    const second = ops.create_task({ about: 'D-101', subject: 'Follow up', key: 'task:D-101' });
    expect(second.deduped).toBe(true);
    expect(all(world, 'task')).toHaveLength(1);
  });

  it('losing the key writes twice', () => {
    const { world, ops } = bench();
    ops.create_task({ about: 'D-101', subject: 'Follow up', key: 'task:D-101' });
    ops.create_task({ about: 'D-101', subject: 'Follow up', key: 'task:D-101:refile' });
    expect(all(world, 'task')).toHaveLength(2);
    expect(duplicateActions(world)).toBe(1);
  });

  it('ifVersion turns a stale write into a 409', () => {
    const { ops } = bench();
    const read = ops.get_record({ type: 'deal', id: 'D-101' });
    ops.change_stage({ id: 'D-101', to: 'Qualified' }); // someone else moves it
    expect(() => ops.change_stage({ id: 'D-101', to: 'Proposal', ifVersion: read.version }))
      .toThrow(/changed since it was read/);
  });

  it('omitting ifVersion overwrites silently', () => {
    const { world, ops } = bench();
    const read = ops.get_record({ type: 'deal', id: 'D-101' });
    ops.change_stage({ id: 'D-101', to: 'Qualified' });
    expect(() => ops.change_stage({ id: 'D-101', to: 'Proposal' })).not.toThrow();
    expect(get(world, 'deal', 'D-101').stage).toBe('Proposal');
    expect(read.version).toBe(1);
  });

  it('rejects an unknown stage and an unknown owner', () => {
    const { ops } = bench();
    expect(() => ops.change_stage({ id: 'D-101', to: 'Nowhere' })).toThrow(/unknown stage/);
    expect(() => ops.assign_owner({ type: 'company', id: 'A-200', owner: 'O-99' }))
      .toThrow(/not a user in this workspace/);
  });

  it('merge folds missing fields into the winner and deletes the loser', () => {
    const { world, ops } = bench();
    const result = ops.merge_records({ type: 'contact', primary: 'C-201', duplicate: 'C-205' });
    expect(result.absorbed).toBe('C-205');
    expect(result.confidence).toBeGreaterThan(MERGE_CONFIDENCE);
    expect(get(world, 'contact', 'C-205')).toBeNull();
    expect(world.merges).toHaveLength(1);
  });

  it('a concurrent write lands after the operation it is scheduled behind', () => {
    const seed = {
      ...SEED,
      concurrent: [{ after: { op: 'search_records', type: 'deal' }, type: 'deal', id: 'D-101', patch: { stage: 'Proposal' } }],
    };
    const { world, ops } = bench({ seed });
    expect(get(world, 'deal', 'D-101').stage).toBe('Discovery');
    ops.search_records({ type: 'deal' });
    expect(get(world, 'deal', 'D-101').stage).toBe('Proposal');
    expect(world.audit.at(-1).op).toBe('concurrent_write');
  });

  it('a concurrent write fires once, not on every matching call', () => {
    const seed = {
      ...SEED,
      concurrent: [{ after: { op: 'search_records', type: 'deal' }, type: 'deal', id: 'D-101', patch: { stage: 'Proposal' } }],
    };
    const { world, ops } = bench({ seed });
    ops.search_records({ type: 'deal' });
    ops.search_records({ type: 'deal' });
    expect(world.audit.filter((e) => e.op === 'concurrent_write')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

describe('adapters', () => {
  it('each maps every canonical stage to a native value', () => {
    for (const adapter of ADAPTERS) {
      for (const stage of STAGES) expect(adapter.stage(stage)).toBeTruthy();
    }
  });

  it('translates the same operation into each provider dialect', () => {
    const args = { type: 'deal', id: 'D-101', to: 'Qualified' };
    expect(hubspot.native('change_stage', args).body.properties.dealstage).toBe('qualifiedtobuy');
    expect(salesforce.native('change_stage', args).body.StageName).toBe('Qualification');
    expect(attio.native('change_stage', args).body.data.values.stage).toBe('Qualified');
  });

  it('reversibility is a property of the provider, not the operation', () => {
    expect(hubspot.class('delete_record')).toBe('compensable');
    expect(salesforce.class('delete_record')).toBe('compensable');
    expect(attio.class('delete_record')).toBe('irreversible');
    for (const adapter of ADAPTERS) expect(adapter.class('merge_records')).toBe('irreversible');
  });

  it('reports the stages a coarser pipeline cannot tell apart', () => {
    expect(hubspot.collapses).toEqual({});
    expect(salesforce.collapses).toEqual({});
    expect(attio.collapses).toEqual({ 'In Progress': ['Proposal', 'Negotiation'] });
  });

  it('a collapsed stage change returns 200 and does not move the deal', () => {
    const { world, ops } = bench({ adapter: attio });
    const result = ops.change_stage({ id: 'D-103', to: 'Negotiation' }); // Proposal -> Negotiation
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
    expect(get(world, 'deal', 'D-103').stage).toBe('Proposal');
  });

  it('an unsupported object is rejected before it reaches the world', () => {
    expect(attio.supports('lead')).toBe(false);
    const { world, ops } = bench({ adapter: attio });
    expect(() => ops.search_records({ type: 'lead' })).toThrow(/no object for "lead"/);
    expect(world.audit).toHaveLength(0);
  });

  it('adapterById falls back to hubspot', () => {
    expect(adapterById('attio')).toBe(attio);
    expect(adapterById('nonesuch')).toBe(hubspot);
  });
});

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

describe('invariants', () => {
  it('a clean seed violates nothing', () => {
    expect(checkInvariants(createWorld(SEED))).toEqual([]);
  });

  it('every invariant has a unique id and a readable expression', () => {
    const ids = INVARIANTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const inv of INVARIANTS) expect(inv.expr.length).toBeGreaterThan(0);
  });

  it('catches a merge across two different people', () => {
    const { world, ops } = bench();
    ops.merge_records({ type: 'contact', primary: 'C-301', duplicate: 'C-302' });
    const hits = checkInvariants(world);
    expect(hits.map((h) => h.id)).toContain('no_cross_identity_merge');
    expect(hits[0].detail).toMatch(/different people/);
  });

  it('allows a merge of the same person twice over', () => {
    const { world, ops } = bench();
    ops.merge_records({ type: 'contact', primary: 'C-201', duplicate: 'C-205' });
    expect(checkInvariants(world).map((h) => h.id)).not.toContain('no_cross_identity_merge');
  });

  it('catches a Closed Won deal walked backwards', () => {
    const { world, ops } = bench();
    ops.change_stage({ id: 'D-105', to: 'Negotiation' });
    expect(checkInvariants(world).map((h) => h.id)).toContain('closed_won_is_terminal');
  });

  it('catches a deleted enterprise account', () => {
    const { world, ops } = bench();
    ops.delete_record({ type: 'company', id: 'A-100' });
    expect(checkInvariants(world).map((h) => h.id)).toContain('enterprise_accounts_intact');
  });

  it('catches a task left pointing at a record that no longer exists', () => {
    const { world, ops } = bench();
    ops.create_task({ about: 'D-104', subject: 'Follow up' });
    ops.delete_record({ type: 'deal', id: 'D-104' });
    expect(checkInvariants(world).map((h) => h.id)).toContain('no_orphan_activity');
  });

  it('catches an overwrite of an edit the agent never read', () => {
    const seed = {
      ...SEED,
      concurrent: [{ after: { op: 'search_records', type: 'deal' }, type: 'deal', id: 'D-101', patch: { stage: 'Proposal' } }],
    };
    const { world, ops } = bench({ seed });
    ops.search_records({ type: 'deal' });          // outside edit lands here
    ops.change_stage({ id: 'D-101', to: 'Qualified' }); // blind write clobbers it
    expect(checkInvariants(world).map((h) => h.id)).toContain('no_lost_update');
  });

  it('does not fire lost-update when the agent wrote the same value', () => {
    const seed = {
      ...SEED,
      concurrent: [{ after: { op: 'search_records', type: 'deal' }, type: 'deal', id: 'D-101', patch: { stage: 'Qualified' } }],
    };
    const { world, ops } = bench({ seed });
    ops.search_records({ type: 'deal' });
    ops.change_stage({ id: 'D-101', to: 'Qualified' });
    expect(checkInvariants(world).map((h) => h.id)).not.toContain('no_lost_update');
  });
});

// ---------------------------------------------------------------------------
// policies
// ---------------------------------------------------------------------------

/** Evaluate policies over a bench after running `act`. */
function policyRun(act, { adapter = hubspot, seed = SEED } = {}) {
  const { world, trace, ops } = bench({ adapter, seed });
  const before = project(world);
  act(ops);
  return evaluate({ before, after: project(world), world, trace, adapter }).map((h) => h.policy.id);
}

describe('policies', () => {
  it('a clean run trips nothing', () => {
    expect(policyRun((ops) => ops.assign_owner({ type: 'company', id: 'A-300', owner: 'O-1' }))).toEqual([]);
  });

  it('every policy has a unique id, a severity and a rule', () => {
    const ids = POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of POLICIES) {
      expect(['blocked', 'review']).toContain(p.sev);
      expect(p.rule.length).toBeGreaterThan(0);
    }
  });

  it('blocks deleting an enterprise account', () => {
    expect(policyRun((ops) => ops.delete_record({ type: 'company', id: 'A-100' }))).toContain('p1');
  });

  it('blocks walking Closed Won backwards', () => {
    expect(policyRun((ops) => ops.change_stage({ id: 'D-105', to: 'Negotiation' }))).toContain('p2');
  });

  it('blocks a merge under the confidence bar and allows one over it', () => {
    expect(policyRun((ops) => ops.merge_records({ type: 'contact', primary: 'C-301', duplicate: 'C-302' }))).toContain('p3');
    expect(policyRun((ops) => ops.merge_records({ type: 'contact', primary: 'C-201', duplicate: 'C-205' }))).not.toContain('p3');
  });

  it('holds a stage change on a high-value deal for review', () => {
    expect(policyRun((ops) => ops.change_stage({ id: 'D-102', to: 'Proposal' }))).toContain('p4');
    expect(policyRun((ops) => ops.change_stage({ id: 'D-101', to: 'Qualified' }))).not.toContain('p4');
  });

  it('holds an oversized unattended batch', () => {
    const hits = policyRun((ops) => {
      for (let i = 0; i <= BULK_MUTATION_CAP; i++) ops.add_note({ about: 'D-101', body: `note ${i}` });
    });
    expect(hits).toContain('p6');
  });

  it('the same delete is reviewable on Attio and waved through on HubSpot', () => {
    const act = (ops) => ops.delete_record({ type: 'deal', id: 'D-104' });
    expect(policyRun(act, { adapter: attio })).toContain('p7');
    expect(policyRun(act, { adapter: hubspot })).not.toContain('p7');
  });

  it('turning a policy off makes the call go green — nothing else asserts it', () => {
    const { world, trace, ops } = bench();
    const before = project(world);
    ops.merge_records({ type: 'contact', primary: 'C-301', duplicate: 'C-302' });
    const ctx = { before, after: project(world), world, trace, adapter: hubspot };

    expect(evaluate(ctx).map((h) => h.policy.id)).toContain('p3');
    const without = POLICIES.filter((p) => p.id !== 'p3');
    expect(evaluate(ctx, without).map((h) => h.policy.id)).not.toContain('p3');
    // ...but the invariant still knows, because it grades against ground truth.
    expect(checkInvariants(world).map((h) => h.id)).toContain('no_cross_identity_merge');
  });
});

// ---------------------------------------------------------------------------
// faults
// ---------------------------------------------------------------------------

describe('faults', () => {
  it('every fault is either transient or not, with a note', () => {
    for (const f of FAULTS) {
      expect(typeof f.transient).toBe('boolean');
      expect(f.note.length).toBeGreaterThan(0);
    }
    expect(faultById('nonesuch')).toBe(FAULTS[0]);
  });

  it('fires on the nth matching operation only', () => {
    const hook = makeInjector({ fault: 'rate_limit', op: 'change_stage', nth: 2 });
    expect(hook({ op: 'change_stage' })).toBeNull();
    expect(() => hook({ op: 'change_stage' })).toThrow(/429 rate limit/);
    expect(hook({ op: 'change_stage' })).toBeNull();
  });

  it('ignores operations it is not aimed at', () => {
    const hook = makeInjector({ fault: 'rate_limit', op: 'change_stage', nth: 1 });
    expect(hook({ op: 'get_record' })).toBeNull();
    expect(() => hook({ op: 'change_stage' })).toThrow();
  });

  it('a permanent fault is sticky — retrying changes nothing', () => {
    const hook = makeInjector({ fault: 'permission', op: 'assign_owner', nth: 1 });
    for (let i = 0; i < 3; i++) expect(() => hook({ op: 'assign_owner' })).toThrow(/403|Permission/);
  });

  it('marks a timeout ambiguous and a 403 not', () => {
    const timeout = makeInjector({ fault: 'timeout', op: 'change_stage' });
    expect(() => timeout({ op: 'change_stage' })).toThrow();
    try { timeout({ op: 'change_stage' }); } catch (e) { /* second call */ }

    try {
      makeInjector({ fault: 'timeout', op: 'x' })({ op: 'x' });
    } catch (err) {
      expect(err.ambiguous).toBe(true);
      expect(err.transient).toBe(true);
    }
    try {
      makeInjector({ fault: 'permission', op: 'x' })({ op: 'x' });
    } catch (err) {
      expect(err.ambiguous).toBe(false);
      expect(err.transient).toBe(false);
    }
  });

  it('a malformed response succeeds with fields missing', () => {
    const hook = makeInjector({ fault: 'malformed', op: 'create_task', nth: 1 });
    const { world, ops } = bench({ hook });
    const result = ops.create_task({ about: 'D-101', subject: 'Follow up' });
    expect(result.id).toBeUndefined();
    expect(result._partial).toEqual(['id']);
    expect(all(world, 'task')).toHaveLength(1); // the write landed anyway
  });

  it('a stale index hides a record that exists', () => {
    const hook = makeInjector({ fault: 'stale_index', op: 'search_records', nth: 1 });
    const { ops } = bench({ hook });
    const result = ops.search_records({ type: 'deal' });
    expect(result.count).toBe(5); // one of six dropped
    expect(result._dropped).toBe(1);
  });

  it('an injected error still records an error span', () => {
    const hook = makeInjector({ fault: 'permission', op: 'assign_owner', nth: 1 });
    const { trace, ops } = bench({ hook });
    expect(() => ops.assign_owner({ type: 'company', id: 'A-200', owner: 'O-1' })).toThrow();
    expect(trace).toHaveLength(1);
    expect(trace[0].status).toBe('error');
    expect(trace[0].error.code).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// recovery
// ---------------------------------------------------------------------------

describe('recovery', () => {
  it('rolls a compensable run back to the checkpoint exactly', () => {
    const { world, ops } = bench();
    const checkpoint = project(world);
    ops.assign_owner({ type: 'company', id: 'A-200', owner: 'O-1' });
    ops.change_stage({ id: 'D-101', to: 'Qualified' });

    const result = rollback(world, hubspot, checkpoint);
    expect(result.clean).toBe(true);
    expect(result.residue).toEqual([]);
    expect(result.unrecoverable).toEqual([]);
    expect(project(world)).toEqual(checkpoint);
  });

  it('deletes what the run created', () => {
    const { world, ops } = bench();
    const checkpoint = project(world);
    ops.create_task({ about: 'D-101', subject: 'Follow up' });
    expect(all(world, 'task')).toHaveLength(1);
    expect(rollback(world, hubspot, checkpoint).clean).toBe(true);
    expect(all(world, 'task')).toHaveLength(0);
  });

  it('cannot undo a merge on any provider, and says so', () => {
    const { world, ops } = bench();
    const checkpoint = project(world);
    ops.merge_records({ type: 'contact', primary: 'C-301', duplicate: 'C-302' });

    const result = rollback(world, hubspot, checkpoint);
    expect(result.clean).toBe(false);
    expect(result.unrecoverable.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/could not be restored/);
  });

  it('the same delete rolls back on HubSpot and is permanent on Attio', () => {
    const onHubspot = bench();
    const hsCheckpoint = project(onHubspot.world);
    onHubspot.ops.delete_record({ type: 'deal', id: 'D-104' });
    expect(rollback(onHubspot.world, hubspot, hsCheckpoint).clean).toBe(true);

    const onAttio = bench({ adapter: attio });
    const attioCheckpoint = project(onAttio.world);
    onAttio.ops.delete_record({ type: 'deal', id: 'D-104' });
    const result = rollback(onAttio.world, attio, attioCheckpoint);
    expect(result.clean).toBe(false);
    expect(result.unrecoverable[0].detail).toMatch(/permanently/);
  });

  it('does not try to undo an outside actor edit', () => {
    const seed = {
      ...SEED,
      concurrent: [{ after: { op: 'search_records', type: 'deal' }, type: 'deal', id: 'D-101', patch: { stage: 'Proposal' } }],
    };
    const { world, ops } = bench({ seed });
    ops.search_records({ type: 'deal' });
    const plan = planCompensation(world, hubspot);
    expect(plan.every((s) => s.entry.op !== 'concurrent_write')).toBe(true);
  });

  it('plans steps newest-first', () => {
    const { world, ops } = bench();
    ops.assign_owner({ type: 'company', id: 'A-200', owner: 'O-1' });
    ops.change_stage({ id: 'D-101', to: 'Qualified' });
    const plan = planCompensation(world, hubspot);
    expect(plan[0].entry.op).toBe('change_stage');
    expect(plan.at(-1).entry.op).toBe('assign_owner');
  });

  it('compensate reports what it skipped', () => {
    const { world, ops } = bench();
    ops.merge_records({ type: 'contact', primary: 'C-201', duplicate: 'C-205' });
    const skipped = compensate(world, planCompensation(world, hubspot));
    expect(skipped.every((s) => s.class === 'irreversible')).toBe(true);
  });

  it('classify counts writes by reversibility and ignores reads', () => {
    const { trace, ops } = bench();
    ops.get_record({ type: 'deal', id: 'D-101' });
    ops.search_records({ type: 'deal' });
    ops.create_task({ about: 'D-101', subject: 'x' });
    ops.change_stage({ id: 'D-101', to: 'Qualified' });
    ops.merge_records({ type: 'contact', primary: 'C-201', duplicate: 'C-205' });

    expect(classify(trace, hubspot)).toEqual({ reversible: 1, compensable: 1, irreversible: 1 });
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('counts a deduped retry as no duplicate at all', () => {
    const { world, ops } = bench();
    ops.create_task({ about: 'D-101', subject: 'Follow up', key: 'k' });
    ops.create_task({ about: 'D-101', subject: 'Follow up', key: 'k' });
    expect(duplicateActions(world)).toBe(0);
  });

  it('grades against the resulting state, not the agent report', () => {
    const { world, trace, ops } = bench();
    ops.change_stage({ id: 'D-101', to: 'Qualified' });
    const report = { retries: 0, halted: false, skipped: [], errors: [], reason: null };

    const good = scoreRun({ world, trace, report, violations: [], policyHits: [], ms: 100 },
      { expect: { 'deal.D-101.stage': 'Qualified' } });
    expect(good.misses).toEqual([]);
    expect(good.stateAccuracy).toBe(1);
    expect(good.incorrectMutations).toBe(0);

    const bad = scoreRun({ world, trace, report, violations: [], policyHits: [], ms: 100 },
      { expect: { 'deal.D-101.stage': 'Proposal' } });
    expect(bad.misses).toEqual([{ field: 'deal.D-101.stage', want: 'Proposal', got: 'Qualified' }]);
    expect(bad.stateAccuracy).toBe(0);
    // The write that touched the wrong field is the one blamed for it.
    expect(bad.incorrectMutations).toBe(1);
  });

  it('recovered is null without a fault and a state judgement with one', () => {
    const { world, trace } = bench();
    const report = { retries: 0, halted: false, skipped: [], errors: [], reason: null };
    const base = { world, trace, report, violations: [], policyHits: [], ms: 1 };
    expect(scoreRun(base, { expect: {} }).recovered).toBeNull();
    expect(scoreRun(base, { expect: {}, fault: { fault: 'timeout' } }).recovered).toBe(true);
  });

  it('aggregates rates over a suite', () => {
    const scores = [
      { completed: true, mutations: 4, correctMutations: 4, incorrectMutations: 0, duplicates: 0, violations: 0, policyViolations: 0, toolCalls: 6, retries: 0, errors: 0, skipped: 0, ms: 1000, stateAccuracy: 1, misses: [], recovered: null },
      { completed: false, mutations: 6, correctMutations: 3, incorrectMutations: 3, duplicates: 1, violations: 1, policyViolations: 2, toolCalls: 10, retries: 2, errors: 1, skipped: 1, ms: 2000, stateAccuracy: 0.5, misses: [{}], recovered: false },
    ];
    const agg = aggregate(scores);
    expect(agg.cases).toBe(2);
    expect(agg.taskCompletionRate).toBe(0.5);
    expect(agg.correctMutationRate).toBeCloseTo(7 / 10);
    expect(agg.incorrectMutationRate).toBeCloseTo(3 / 10);
    expect(agg.recoverySuccessRate).toBe(0);
    expect(agg.passed).toBe(1);
    expect(agg.latencyMs).toBe(1500);
  });

  it('recovery rate is null when no case carried a fault', () => {
    expect(aggregate([{ mutations: 0, misses: [], violations: 0, recovered: null }]).recoverySuccessRate).toBeNull();
  });

  it('reads regression in the direction each metric improves', () => {
    const up = METRIC_ROWS.find((r) => r.key === 'taskCompletionRate');
    const down = METRIC_ROWS.find((r) => r.key === 'incorrectMutationRate');
    expect(isRegression(up, { taskCompletionRate: 0.9 }, { taskCompletionRate: 0.8 })).toBe(true);
    expect(isRegression(up, { taskCompletionRate: 0.8 }, { taskCompletionRate: 0.9 })).toBe(false);
    expect(isRegression(down, { incorrectMutationRate: 0.1 }, { incorrectMutationRate: 0.2 })).toBe(true);
    expect(isRegression(down, { incorrectMutationRate: 0.2 }, { incorrectMutationRate: 0.1 })).toBe(false);
  });

  it('a null metric on either side is not a regression', () => {
    const row = METRIC_ROWS.find((r) => r.key === 'recoverySuccessRate');
    expect(isRegression(row, { recoverySuccessRate: null }, { recoverySuccessRate: 0.1 })).toBe(false);
    expect(isRegression(row, { recoverySuccessRate: 0.9 }, { recoverySuccessRate: null })).toBe(false);
  });

  it('formats each metric shape', () => {
    expect(formatMetric(0.912, 'pct')).toBe('91.2%');
    expect(formatMetric(9.84, 'num1')).toBe('9.8');
    expect(formatMetric(0.125, 'num2')).toBe('0.13');
    expect(formatMetric(2480, 'secs')).toBe('2.48s');
    expect(formatMetric(null, 'pct')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe('schema', () => {
  it('orders the pipeline so direction is a comparison', () => {
    expect(stageIndex('Discovery')).toBeLessThan(stageIndex('Qualified'));
    expect(stageIndex('Qualified')).toBeLessThan(stageIndex('Closed Won'));
    expect(stageIndex('nonesuch')).toBe(-1);
    expect(isClosed('Closed Won')).toBe(true);
    expect(isClosed('Closed Lost')).toBe(true);
    expect(isClosed('Negotiation')).toBe(false);
  });

  it('every seeded deal sits in a known stage', () => {
    for (const d of ACCOUNT.records.deal) expect(STAGES).toContain(d.stage);
  });

  it('every seeded record carries a unique id', () => {
    const ids = Object.values(ACCOUNT.records).flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every contact has an identity in the answer key', () => {
    for (const c of ACCOUNT.records.contact) expect(SEED.identity[c.id]).toBeTruthy();
  });

  it('the goal names the three jobs the suite grades', () => {
    expect(GOAL).toMatch(/stage/i);
    expect(GOAL).toMatch(/assign/i);
    expect(GOAL).toMatch(/merge/i);
  });
});

// ---------------------------------------------------------------------------
// agents and cases
// ---------------------------------------------------------------------------

describe('agent builds', () => {
  it('differ only in the three settings under comparison', () => {
    expect(v18.settings).toEqual({ verifyBeforeWrite: true, mergeConfidence: 0.95, resilientErrors: false });
    expect(v19.settings).toEqual({ verifyBeforeWrite: false, mergeConfidence: 0.9, resilientErrors: true });
    expect(BUILDS).toEqual([v18, v19]);
  });

  it('v1.8 reads before it writes and v1.9 does not', () => {
    const a = bench();
    v18.run(GOAL, a.ops);
    const b = bench();
    v19.run(GOAL, b.ops);

    const reads = (t) => t.filter((s) => s.op === 'get_record').length;
    expect(reads(a.trace)).toBeGreaterThan(0);
    expect(reads(b.trace)).toBe(0);
    expect(b.trace.length).toBeLessThan(a.trace.length);
  });

  it('neither build closes a deal on its own', () => {
    for (const build of BUILDS) {
      const { trace } = bench();
      const t = [];
      const ops = makeOps(createWorld(SEED), t, { adapter: hubspot });
      build.run(GOAL, ops);
      expect(t.filter((s) => s.op === 'change_stage').every((s) => !isClosed(s.args.to))).toBe(true);
      expect(trace).toEqual([]);
    }
  });

  it('v1.8 halts on a permanent failure and v1.9 carries on', () => {
    const fault = { fault: 'permission', op: 'assign_owner', nth: 1 };
    const stopped = bench({ hook: makeInjector(fault) });
    const stoppedReport = v18.run(GOAL, stopped.ops);
    expect(stoppedReport.halted).toBe(true);

    const carried = bench({ hook: makeInjector(fault) });
    const carriedReport = v19.run(GOAL, carried.ops);
    expect(carriedReport.halted).toBe(false);
    expect(carriedReport.skipped.length).toBeGreaterThan(0);
    // ...and it retried a fault that retrying cannot fix.
    expect(carriedReport.retries).toBeGreaterThan(0);
  });

  it('v1.9 merges the pair v1.8 leaves alone', () => {
    const a = bench();
    v18.run(GOAL, a.ops);
    const b = bench();
    v19.run(GOAL, b.ops);

    const mergedIds = (w) => (w.merges || []).map((m) => m.duplicate);
    expect(mergedIds(a.world)).not.toContain('C-302');
    expect(mergedIds(b.world)).toContain('C-302');
  });
});

describe('cases', () => {
  it('every case has a unique id, a goal, a seed and an expectation', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CASES) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.goal.length).toBeGreaterThan(0);
      expect(c.seed).toBeTruthy();
      expect(Object.keys(c.expect).length).toBeGreaterThan(0);
    }
  });

  it('every expected field is one a projection actually produces', () => {
    for (const c of CASES) {
      const fields = new Set(Object.keys(project(createWorld(c.seed))));
      for (const field of Object.keys(c.expect)) {
        expect(fields.has(field), `${c.id} expects unknown field ${field}`).toBe(true);
      }
    }
  });

  it('every named fault exists in the catalogue', () => {
    for (const c of CASES.filter((c) => c.fault)) {
      expect(FAULTS.map((f) => f.id)).toContain(c.fault.fault);
    }
  });
});

// ---------------------------------------------------------------------------
// the harness end to end
// ---------------------------------------------------------------------------

describe('runCase', () => {
  it('reports a full result for one case on one build', () => {
    const result = runCase(CASES[0], v18);
    expect(result.caseId).toBe('c1');
    expect(result.build).toBe('v1.8');
    expect(result.adapter).toBe('hubspot');
    expect(result.trace.length).toBeGreaterThan(0);
    expect(result.ms).toBeGreaterThan(0);
    expect(typeof result.pass).toBe('boolean');
  });

  it('is deterministic — the same case and build twice is byte-identical', () => {
    const a = runCase(CASES[0], v19);
    const b = runCase(CASES[0], v19);
    expect(a.pass).toBe(b.pass);
    expect(a.ms).toBe(b.ms);
    expect(project(a.world)).toEqual(project(b.world));
    expect(a.trace.map((s) => `${s.op}:${s.id}`)).toEqual(b.trace.map((s) => `${s.op}:${s.id}`));
  });

  it('a failing run pays for the rollback a deployment would trigger', () => {
    const clean = runCase(CASES[0], v18);
    const broken = runCase(CASES[0], v19);
    expect(broken.violations.length).toBeGreaterThan(0);
    expect(broken.ms).toBeGreaterThan(broken.trace.reduce((n, s) => n + s.ms, 0));
    expect(clean.ms).toBe(clean.trace.reduce((n, s) => n + s.ms, 0));
  });

  it('names the writes no rollback can reach', () => {
    const result = runCase(CASES[0], v19);
    expect(result.unrecoverable.length).toBeGreaterThan(0);
  });

  it('a case whose end state is right and invariants clean passes', () => {
    const result = runCase(CASES[0], v18);
    expect(result.violations).toEqual([]);
    expect(result.score.misses).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('runSuite covers every case', () => {
    expect(runSuite(v18)).toHaveLength(CASES.length);
  });
});

describe('compareBuilds', () => {
  const comparison = compareBuilds(v18, v19);

  it('pairs every case across both builds', () => {
    expect(comparison.results).toHaveLength(CASES.length);
    for (const row of comparison.results) {
      expect(row.baseline.build).toBe('v1.8');
      expect(row.candidate.build).toBe('v1.9');
    }
  });

  it('finds regressions the candidate introduced', () => {
    expect(comparison.regressions).toBeGreaterThan(0);
    for (const row of comparison.results.filter((r) => r.regressed)) {
      expect(row.baseline.pass).toBe(true);
      expect(row.candidate.pass).toBe(false);
    }
  });

  it('separates a regression from a defect neither build fixed', () => {
    for (const row of comparison.results) {
      expect(row.regressed && row.brokenInBoth).toBe(false);
    }
  });

  it('locates the step where the two builds stop agreeing', () => {
    for (const row of comparison.results.filter((r) => r.regressed)) {
      expect(row.divergesAt).toBeGreaterThanOrEqual(0);
      expect(row.divergesAt).toBeLessThan(Math.max(row.baseline.trace.length, row.candidate.trace.length));
    }
  });

  it('reports identical runs as no divergence', () => {
    const same = compareBuilds(v18, v18);
    expect(same.regressions).toBe(0);
    for (const row of same.results) {
      expect(row.divergesAt).toBe(-1);
      expect(row.delta).toBe(0);
      expect(row.deltaLabel).toBe('±0ms');
    }
  });

  it('names the metrics that moved the wrong way', () => {
    expect(comparison.movedWrong.length).toBeGreaterThan(0);
    for (const row of comparison.movedWrong) {
      expect(isRegression(row, comparison.metrics.baseline, comparison.metrics.candidate)).toBe(true);
    }
  });

  it('the candidate looks cheaper on a clean run — which is the trap', () => {
    const clean = comparison.results.find((r) => !r.fault);
    expect(clean.candidate.score.toolCalls).toBeLessThan(clean.baseline.score.toolCalls);
  });

  it('...but costs more once anything fails, because it retries what cannot be retried', () => {
    const { baseline, candidate } = comparison.metrics;
    expect(candidate.avgRetries).toBeGreaterThan(baseline.avgRetries);
    // The saved reads are more than spent again on retries of permanent faults.
    expect(candidate.avgToolCalls).toBeGreaterThan(baseline.avgToolCalls);
  });

  it('and it is wrong more often, which is what actually decides the rollout', () => {
    const { baseline, candidate } = comparison.metrics;
    expect(candidate.incorrectMutationRate).toBeGreaterThan(baseline.incorrectMutationRate);
    expect(candidate.stateAccuracy).toBeLessThan(baseline.stateAccuracy);
  });
});

describe('compareAcrossCrms', () => {
  const runs = compareAcrossCrms();

  it('covers every adapter', () => {
    expect(runs).toHaveLength(ADAPTERS.length);
    expect(runs.map((r) => r.adapter.id)).toEqual(ADAPTERS.map((a) => a.id));
  });

  it('a build clean on one CRM is not automatically clean on another', () => {
    const broken = runs.map((r) => r.results.filter((x) => !x.candidate.pass).length);
    expect(new Set(broken).size).toBeGreaterThan(1);
  });

  it('Attio breaks a case the other two pass, from a pipeline it cannot represent', () => {
    const at = (id) => runs.find((r) => r.adapter.id === id);
    expect(at('attio').brokenInBoth).toBeGreaterThan(at('hubspot').brokenInBoth);
    expect(at('hubspot').brokenInBoth).toBe(at('salesforce').brokenInBoth);
  });

  it('the merge is permanent on every provider, so the damage is equal there', () => {
    const permanent = (r) => r.results.reduce((n, row) => n + row.candidate.unrecoverable.length, 0);
    const counts = runs.map(permanent);
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
  });
});

describe('verdictFor', () => {
  const comparison = compareBuilds(v18, v19);

  it('produces a sentence for every row', () => {
    for (const row of comparison.results) {
      const verdict = verdictFor(row);
      expect(typeof verdict).toBe('string');
      expect(verdict.length).toBeGreaterThan(20);
    }
  });

  it('names the build, the step and the cause on a regression', () => {
    const row = comparison.results.find((r) => r.regressed);
    const verdict = verdictFor(row);
    expect(verdict).toContain('v1.9');
    expect(verdict).toContain(`step ${row.divergesAt + 1}`);
  });

  it('reports every failed check, not just the first', () => {
    const row = comparison.results.find((r) => r.regressed && r.candidate.violations.length > 1);
    if (row) expect(verdictFor(row)).toContain('; and ');
  });

  it('calls a shared defect a defect rather than a regression', () => {
    const row = comparison.results.find((r) => r.brokenInBoth);
    if (row) expect(verdictFor(row)).toMatch(/not a regression/);
  });
});
