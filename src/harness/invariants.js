import { overlaps, similarity } from './world.js';

/**
 * Invariants are checked against the final shadow state, not against the
 * planner's intentions — a run fails if the world it left behind is wrong,
 * however reasonable each individual call looked.
 */
export const INVARIANTS = [
  {
    id: 'no_overlap',
    expr: 'no_overlap(unit, window)',
    check(world) {
      const hits = [];
      for (const [unit, u] of Object.entries(world.inventory.units)) {
        const rs = u.reservations;
        for (let i = 0; i < rs.length; i++) {
          for (let j = i + 1; j < rs.length; j++) {
            if (overlaps(rs[i], rs[j])) {
              hits.push(`unit ${unit}: ${rs[i].id} overlaps ${rs[j].id}`);
            }
          }
        }
      }
      return hits;
    },
  },
  {
    id: 'external_email_count',
    expr: 'external_email_count <= 10',
    check(world) {
      const n = world.gmail.sent.reduce((sum, m) => sum + m.to.length, 0);
      return n > 10 ? [`${n} external recipients in one run`] : [];
    },
  },
  {
    id: 'no_duplicate_contacts',
    expr: 'no_duplicate_contacts(crm)',
    check(world) {
      const hits = [];
      const cs = world.crm.contacts;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          if (similarity(cs[i].email, cs[j].email) >= 0.9) {
            hits.push(`${cs[i].email} duplicates ${cs[j].email}`);
          }
        }
      }
      return hits;
    },
  },
  {
    id: 'reservation_has_customer',
    expr: 'reservation.customer_id != None',
    check(world) {
      return Object.entries(world.crm.reservations)
        .filter(([, r]) => r.customer_id === null)
        .map(([id]) => `${id} has no customer`);
    },
  },
];

export function checkInvariants(world) {
  return INVARIANTS.flatMap((inv) =>
    inv.check(world).map((detail) => ({ id: inv.id, expr: inv.expr, detail }))
  );
}
