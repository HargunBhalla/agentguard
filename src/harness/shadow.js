import { createWorld, overlaps } from './world.js';
import { makeTools } from './tools.js';
import { INVARIANTS } from './invariants.js';

/**
 * Shadow simulation for the pre-flight gate.
 *
 * The agent's proposed calls are rehearsed one at a time against a throwaway
 * copy of the seed world. Nothing here declares what a call will do — the
 * diff, the blast radius and the policy verdicts are all read back off the
 * world the rehearsal produced.
 */

/** State of run 8812 before the agent touched anything. */
export const SEED = {
  units: {
    184: {
      reservations: [
        { id: 'R-2118', from: '2026-08-12', to: '2026-08-13' },
        // Already committed over the weekend. Any hold that spans Sat/Sun
        // collides with it.
        { id: 'R-2209', from: '2026-08-15', to: '2026-08-16' },
      ],
    },
  },
  events: { 'dlv-184': { start: '2026-08-12T07:00' } },
  reservations: { 'R-2118': { stage: 'Scheduled', customer_id: 'ABC' } },
  contacts: [{ email: 'marcus.hale@abcconstruction.com', name: 'Marcus Hale' }],
};

/** The rental agreement the reservation has to stay inside. */
const CONTRACT = { from: '2026-08-01', to: '2026-08-31' };

/** The yard distribution list the planner expanded "update the team" into. */
const YARD_LIST = Array.from({ length: 68 }, (_, i) => `dispatch${i + 1}@rentalco.example`);

/**
 * Flatten a world into the comparable fields the diff is expressed in. Only
 * things an operator would recognise; internal structure stays out.
 */
export function project(world) {
  const out = {};
  for (const [unit, u] of Object.entries(world.inventory.units)) {
    const rs = u.reservations;
    out[`unit.${unit}.holds`] = String(rs.length);
    const span = rs.length
      ? `${rs.map((r) => r.from).sort()[0]} → ${rs.map((r) => r.to).sort().at(-1)}`
      : '—';
    out[`unit.${unit}.window`] = span;
    let clashes = 0;
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) if (overlaps(rs[i], rs[j])) clashes++;
    }
    out[`unit.${unit}.conflicts`] = String(clashes);
  }
  for (const [id, r] of Object.entries(world.crm.reservations)) {
    out[`reservation.${id}.stage`] = String(r.stage);
  }
  for (const [id, e] of Object.entries(world.calendar.events)) {
    out[`event.${id}.start`] = String(e.start);
  }
  out['contacts.count'] = String(world.crm.contacts.length);
  out['messages.sent'] = String(world.gmail.sent.length);
  out['recipients.distinct'] = String(
    new Set(world.gmail.sent.flatMap((m) => m.to)).size
  );
  return out;
}

/**
 * The five calls the planner proposed. `apply` is the real tool call; the prose
 * is narration that the rehearsal cannot derive.
 */
export const PROPOSAL = [
  {
    id: 'a1',
    tool: 'inventory.reserve',
    summary: 'Hold excavator #184 for Fri 14 – Mon 17 Aug',
    detail:
      'Moving the rental to Friday extends the hold across the weekend. Shadow execution wrote the reservation into the sandbox inventory service and found unit #184 already committed to reservation R-2209 from Saturday morning.',
    risk: 'Risk: high — execution blocked. Excavator #184 is already booked Friday.',
    alt: 'Suggested alternative: excavator #219, same 8-ton class, available Fri–Mon at the same rate. Swapping the unit clears the invariant without moving the date.',
    apply: (t) =>
      t.inventory.reserve({ unit: '184', from: '2026-08-14', to: '2026-08-17', id: 'R-2118b' }),
  },
  {
    id: 'a2',
    tool: 'calendar.update',
    summary: 'Move delivery window to Fri 14 Aug, 07:00',
    detail:
      'The delivery event sits on the dispatch calendar with the driver and the yard lead as attendees. Both are free in the new window, and the event carries a restorable checkpoint.',
    apply: (t) => t.calendar.update({ event: 'dlv-184', start: '2026-08-14T07:00' }),
  },
  {
    id: 'a3',
    tool: 'crm.update',
    summary: 'Reschedule reservation R-2118 on ABC Construction',
    detail:
      'The rental record on the ABC Construction account is updated to the new window and the owning salesperson is flagged for a follow-up. Inside the agent’s scoped permission set.',
    apply: (t) => t.crm.update({ id: 'R-2118', patch: { stage: 'Rescheduled', customer_id: 'ABC' } }),
  },
  {
    id: 'a4',
    tool: 'gmail.send',
    summary: 'Notify Marcus Hale — new delivery window',
    detail:
      'A single confirmation to the site contact on file, quoting the new window and the unit number. No attachments, no account data in the body.',
    apply: (t) =>
      t.gmail.send({ to: 'marcus.hale@abcconstruction.com', template: 'rental-reschedule' }),
  },
  {
    id: 'a5',
    tool: 'gmail.send',
    summary: 'Yard-wide schedule digest to 68 recipients',
    detail:
      'The planner expanded “update the team” into a digest addressed to every dispatcher and driver on the yard distribution list — 68 recipients for a change that affects two of them.',
    apply: (t) => t.gmail.send({ to: YARD_LIST, template: 'yard-digest' }),
  },
];

/**
 * Policies are predicates over the rehearsal, not labels attached to calls.
 * Each is handed the projected before/after and the resulting world.
 */
export const POLICIES = [
  {
    id: 'p1',
    name: 'No double-booked equipment',
    mode: 'hard block',
    sev: 'blocked',
    test: ({ before, after }) =>
      Object.keys(after).some(
        (k) => k.endsWith('.conflicts') && Number(after[k]) > Number(before[k] ?? 0)
      ),
  },
  {
    id: 'p2',
    name: 'Reservation stays inside the contract window',
    mode: 'hold for review',
    sev: 'review',
    test: ({ world }) =>
      Object.values(world.inventory.units).some((u) =>
        u.reservations.some((r) => r.from < CONTRACT.from || r.to > CONTRACT.to)
      ),
  },
  {
    id: 'p3',
    name: 'No deletions on shared calendars',
    mode: 'hard block',
    sev: 'blocked',
    test: ({ before, after }) =>
      Object.keys(before).filter((k) => k.startsWith('event.')).length >
      Object.keys(after).filter((k) => k.startsWith('event.')).length,
  },
  {
    id: 'p4',
    name: 'No bulk send over 50 recipients',
    mode: 'hold for review',
    sev: 'review',
    test: ({ world }) => world.gmail.sent.some((m) => m.to.length > 50),
  },
];

/**
 * Rehearse one proposed call against a fresh copy of the seed world and read
 * back what it did.
 */
export function rehearse(action, seed = SEED) {
  const world = createWorld(seed);
  const before = project(world);
  const trace = [];
  action.apply(makeTools(world, trace));
  const after = project(world);

  const diff = Object.keys(after)
    .filter((k) => before[k] !== after[k])
    .map((k) => ({ field: k, before: before[k] ?? '—', after: after[k] }));

  const ctx = { before, after, world, trace };
  const trips = POLICIES.filter((p) => p.test(ctx)).map((p) => p.id);

  // Blast radius, measured off the rehearsal rather than described.
  const recipients = world.gmail.sent.reduce((n, m) => n + m.to.length, 0);
  const reversible = recipients === 0;
  const parts = [`${diff.length} field${diff.length === 1 ? '' : 's'} changed`];
  if (recipients) parts.push(`${recipients} recipient${recipients === 1 ? '' : 's'}`);
  const conflicts = Object.entries(after)
    .filter(([k, v]) => k.endsWith('.conflicts') && Number(v) > 0)
    .reduce((n, [, v]) => n + Number(v), 0);
  if (conflicts) parts.push(`${conflicts} scheduling conflict${conflicts === 1 ? '' : 's'}`);
  parts.push(reversible ? 'reversible from checkpoint' : 'irreversible once sent');

  return { ...action, diff, trips, blast: `Blast radius: ${parts.join(' · ')}`, ms: trace[0]?.ms ?? 0 };
}

/** Rehearse the whole proposal. */
export function rehearseAll(proposal = PROPOSAL, seed = SEED) {
  return proposal.map((a) => rehearse(a, seed));
}

/**
 * Apply the whole proposal to one world and report which invariants survive it.
 * This is the pre-flight answer to "if we let all of this through, what breaks?"
 */
export function invariantStatus(proposal = PROPOSAL, seed = SEED) {
  const world = createWorld(seed);
  const trace = [];
  const tools = makeTools(world, trace);
  for (const a of proposal) a.apply(tools);
  return INVARIANTS.map((inv) => ({ expr: inv.expr, ok: inv.check(world).length === 0 }));
}
