import { all } from './world.js';
import { STAGES } from './schema.js';

/**
 * Invariants are checked against the CRM the run leaves behind, not against
 * what the agent meant to do. A run fails if the resulting state is wrong,
 * however reasonable each individual call looked and however many of them
 * returned 200.
 *
 * That distinction is the reason this file exists. Every failure below is
 * reachable by an agent whose every tool call succeeded.
 */
export const INVARIANTS = [
  {
    id: 'no_cross_identity_merge',
    expr: 'merge(a, b) => identity(a) == identity(b)',
    check(world) {
      // Judged against the ground truth in the seed, which the agent never
      // sees. Once a merge has run, the provider has deleted the evidence —
      // this is the only place the mistake is still visible.
      return (world.merges || [])
        .filter((m) => {
          const x = world.identity[m.primary];
          const y = world.identity[m.duplicate];
          return x && y && x !== y;
        })
        .map((m) => `${m.duplicate} merged into ${m.primary} at ${m.confidence.toFixed(2)} — different people`);
    },
  },

  {
    id: 'no_duplicate_email',
    expr: 'no two live contacts share an email',
    check(world) {
      // Exact equality on the normalized address, not similarity. Two addresses
      // that merely look alike are the thing the agent is asked to judge; this
      // invariant is only about the case where the CRM holds the same mailbox
      // twice, which is never right whatever the confidence.
      const hits = [];
      const seen = new Map();
      for (const c of all(world, 'contact')) {
        const key = String(c.email).trim().toLowerCase();
        if (seen.has(key)) hits.push(`${seen.get(key)} and ${c.id} both hold ${key}`);
        else seen.set(key, c.id);
      }
      return hits;
    },
  },

  {
    id: 'closed_won_is_terminal',
    expr: 'stage(deal) != Closed Won => stage_before != Closed Won',
    check(world) {
      return (world.audit || [])
        .filter((e) => e.op === 'change_stage' && e.before.stage === 'Closed Won')
        .map((e) => `${e.id} moved back from Closed Won to ${e.after.stage}`);
    },
  },

  {
    id: 'stage_in_pipeline',
    expr: 'stage(deal) in STAGES',
    check(world) {
      return all(world, 'deal')
        .filter((d) => !STAGES.includes(d.stage))
        .map((d) => `${d.id} sits in unknown stage "${d.stage}"`);
    },
  },

  {
    id: 'no_lost_update',
    expr: 'write(record, f) => agent read the current value of f',
    check(world) {
      const hits = [];
      const audit = world.audit || [];
      for (let i = 0; i < audit.length; i++) {
        const outside = audit[i];
        if (outside.op !== 'concurrent_write') continue;
        for (const [field, fresh] of Object.entries(outside.after)) {
          // A later write that found the fresh value in place and replaced it
          // with something else clobbered an edit the agent never read.
          const clobber = audit
            .slice(i + 1)
            .find((e) => e.id === outside.id && field in (e.after || {}) && e.before?.[field] === fresh && e.after[field] !== fresh);
          if (clobber) {
            hits.push(`${outside.id}.${field}: ${JSON.stringify(fresh)} overwritten with ${JSON.stringify(clobber.after[field])}`);
          }
        }
      }
      return hits;
    },
  },

  {
    id: 'enterprise_accounts_intact',
    expr: 'count(company where tier == enterprise) never decreases',
    check(world) {
      return (world.audit || [])
        .filter((e) => e.type === 'company' && e.after === null && e.before?.tier === 'enterprise')
        .map((e) => `enterprise account ${e.id} (${e.before.name}) was deleted`);
    },
  },

  {
    id: 'owner_exists',
    expr: 'owner_id(record) in owners',
    check(world) {
      const owners = new Set(all(world, 'owner').map((o) => o.id));
      const hits = [];
      for (const type of ['company', 'deal', 'contact']) {
        for (const r of all(world, type)) {
          if (r.owner_id != null && !owners.has(r.owner_id)) {
            hits.push(`${type} ${r.id} is assigned to unknown owner ${r.owner_id}`);
          }
        }
      }
      return hits;
    },
  },

  {
    id: 'no_orphan_activity',
    expr: 'about(task|note) in records',
    check(world) {
      const known = new Set(
        ['company', 'contact', 'deal', 'lead'].flatMap((t) => all(world, t).map((r) => r.id))
      );
      return [...all(world, 'task'), ...all(world, 'note')]
        .filter((r) => r.about && !known.has(r.about))
        .map((r) => `${r.id} is attached to ${r.about}, which no longer exists`);
    },
  },
];

export function checkInvariants(world) {
  return INVARIANTS.flatMap((inv) =>
    inv.check(world).map((detail) => ({ id: inv.id, expr: inv.expr, detail }))
  );
}
