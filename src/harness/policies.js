import { all } from './world.js';
import { HIGH_VALUE, stageIndex } from './schema.js';

/**
 * The policy engine.
 *
 * Policies are predicates over a rehearsal, not labels attached to calls.
 * Each one is handed the projected before/after, the world the rehearsal
 * produced, the spans it recorded, and the adapter it ran against - and returns
 * the reasons it objects, or nothing.
 *
 * That shape is deliberate, and it is what makes the pre-flight screen honest:
 * turn a policy off and the call goes green, because nothing anywhere is
 * asserting that the call was bad. The only thing that ever said so was the
 * predicate, evaluated against a state the rehearsal genuinely produced.
 *
 * Two of these read the adapter rather than the operation, so the same proposed
 * mutation can be safe on one CRM and blocked on another.
 */

/** Confidence a merge must clear. Below this, two records are not known to be one. */
export const MERGE_CONFIDENCE = 0.95;

/** Mutations in a single run above which a human should see the batch first. */
export const BULK_MUTATION_CAP = 25;

const MUTATIONS = new Set([
  'create_record', 'update_record', 'delete_record', 'change_stage',
  'assign_owner', 'merge_records', 'create_task', 'add_note',
]);

/**
 * The four outcomes a policy can return, ordered by how much they restrain the
 * run. A rehearsal's verdict is the heaviest outcome any policy reached, so
 * this order is the comparison - not a list of special cases.
 *
 *   allow    nothing objected
 *   warn     advisory: recorded on the trace, does not hold the call
 *   approve  a human has to sign the call off before it is issued
 *   block    the call is never issued
 */
export const OUTCOMES = ['allow', 'warn', 'approve', 'block'];
export const OUTCOME_LABEL = { allow: 'allow', warn: 'warn', approve: 'require approval', block: 'block' };
export const heaviest = (outcomes) =>
  outcomes.reduce((worst, o) => (OUTCOMES.indexOf(o) > OUTCOMES.indexOf(worst) ? o : worst), 'allow');

export const POLICIES = [
  {
    id: 'p1',
    name: 'Never delete an enterprise account',
    mode: 'block',
    sev: 'block',
    rule: 'delete(company) => tier != enterprise',
    test: ({ world }) =>
      (world.audit || [])
        .filter((e) => e.type === 'company' && e.after === null && e.before?.tier === 'enterprise')
        .map((e) => `${e.id} - ${e.before.name} is an enterprise account`),
  },

  {
    id: 'p2',
    name: 'Closed Won cannot move backwards',
    mode: 'block',
    sev: 'block',
    rule: 'stage_change(d) => index(to) >= index(from) or from != Closed Won',
    test: ({ world }) =>
      (world.audit || [])
        .filter((e) => e.op === 'change_stage')
        .filter((e) => e.before.stage === 'Closed Won' && stageIndex(e.after.stage) < stageIndex(e.before.stage))
        .map((e) => `${e.id} moved Closed Won → ${e.after.stage}`),
  },

  {
    id: 'p3',
    name: `Merging records requires confidence > ${MERGE_CONFIDENCE}`,
    mode: 'block',
    sev: 'block',
    rule: `merge(a, b) => confidence(a, b) > ${MERGE_CONFIDENCE}`,
    test: ({ world }) =>
      (world.merges || [])
        .filter((m) => m.confidence <= MERGE_CONFIDENCE)
        .map((m) => `${m.duplicate} → ${m.primary} at ${m.confidence.toFixed(3)} confidence`),
  },

  {
    id: 'p4',
    name: `Deals over $${(HIGH_VALUE / 1000).toFixed(0)}K need approval before a stage change`,
    mode: 'require approval',
    sev: 'approve',
    rule: `stage_change(d) and amount(d) >= ${HIGH_VALUE} => approved_by != None`,
    test: ({ world }) => {
      const amount = Object.fromEntries(all(world, 'deal').map((d) => [d.id, d.amount]));
      return (world.audit || [])
        .filter((e) => e.op === 'change_stage' && (amount[e.id] ?? 0) >= HIGH_VALUE)
        .map((e) => `${e.id} at $${(amount[e.id] / 1000).toFixed(0)}K - ${e.before.stage} → ${e.after.stage}`);
    },
  },

  {
    id: 'p5',
    name: 'No overwrite of a record that changed after it was read',
    mode: 'block',
    sev: 'block',
    rule: 'write(r) => version(r) == version_read(r)',
    test: ({ world }) => {
      const audit = world.audit || [];
      const hits = [];
      for (let i = 0; i < audit.length; i++) {
        const outside = audit[i];
        if (outside.op !== 'concurrent_write') continue;
        for (const [field, fresh] of Object.entries(outside.after)) {
          const clobber = audit
            .slice(i + 1)
            .find((e) => e.id === outside.id && e.before?.[field] === fresh && e.after?.[field] !== fresh);
          if (clobber) hits.push(`${outside.id}.${field} was edited after the agent read it`);
        }
      }
      return hits;
    },
  },

  {
    id: 'p6',
    name: `No unattended batch over ${BULK_MUTATION_CAP} mutations`,
    mode: 'warn',
    sev: 'warn',
    rule: `count(mutations) <= ${BULK_MUTATION_CAP}`,
    test: ({ trace }) => {
      const n = trace.filter((s) => MUTATIONS.has(s.op) && s.status === 'ok').length;
      return n > BULK_MUTATION_CAP ? [`${n} mutations in a single run`] : [];
    },
  },

  {
    id: 'p7',
    name: 'Irreversible operations need approval',
    mode: 'require approval',
    sev: 'approve',
    rule: 'reversibility(op, crm) == irreversible => approved_by != None',
    // Reads the adapter, not the operation. Deleting a record is recoverable on
    // HubSpot and Salesforce and permanent on Attio, so the same proposed call
    // is reviewable on one CRM and waved through on another.
    test: ({ trace, adapter }) =>
      trace
        .filter((s) => s.status === 'ok' && adapter.class(s.op) === 'irreversible')
        .map((s) => `${s.op} on ${s.id ?? s.type} is permanent on ${adapter.label}`),
  },
];

/** Every policy that objects to a rehearsal, with its reasons. */
export function evaluate(ctx, policies = POLICIES) {
  return policies
    .map((p) => ({ policy: p, reasons: p.test(ctx) }))
    .filter((r) => r.reasons.length > 0);
}
