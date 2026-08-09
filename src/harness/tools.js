import { days, overlaps, similarity } from './world.js';

/**
 * Per-call cost in milliseconds. Fixed rather than sampled so a latency delta
 * between two planners reflects the calls they chose to make, not noise — the
 * same run always reports the same number.
 */
export const COST = {
  'inventory.check': 40,
  'inventory.reserve': 120,
  'inventory.release': 90,
  'inventory.swap': 140,
  'calendar.update': 180,
  'crm.query': 110,
  'crm.create': 130,
  'crm.merge': 150,
  'crm.update': 120,
  'gmail.send': 200,
};

/**
 * Wrap the world in the tool surface a planner sees. Every call appends a span
 * to `trace`, which is what the Replay tab renders and what divergence between
 * two planners is computed from.
 */
export function makeTools(world, trace) {
  const record = (tool, meta, result) => {
    trace.push({ tool, meta, ms: COST[tool] ?? 50 });
    return result;
  };

  return {
    inventory: {
      /**
       * `perDay` is the whole difference between the two planners' availability
       * reads. Scanning day by day sees a reservation sitting in the interior of
       * the requested window; probing only the endpoints does not.
       */
      check({ unit, from, to, perDay, ignore }) {
        // A reservation never conflicts with itself: when a window is being
        // moved or extended, the record being rewritten is excluded.
        const held = (world.inventory.units[unit]?.reservations || []).filter(
          (r) => r.id !== ignore
        );
        const conflicts = perDay
          ? held.filter((r) => days(from, to).some((d) => d >= r.from && d <= r.to))
          : held.filter((r) => (from >= r.from && from <= r.to) || (to >= r.from && to <= r.to));
        return record(
          'inventory.check',
          perDay ? `${unit} · ${days(from, to).length} days scanned` : `${unit} · window only`,
          { available: conflicts.length === 0, conflicts: conflicts.map((c) => c.id) }
        );
      },
      reserve({ unit, from, to, id }) {
        const u = (world.inventory.units[unit] ||= { reservations: [] });
        u.reservations.push({ id, from, to });
        return record('inventory.reserve', `${unit} · ${from}→${to}`, { id });
      },
      release({ unit, id }) {
        const u = world.inventory.units[unit];
        if (u) u.reservations = u.reservations.filter((r) => r.id !== id);
        return record('inventory.release', `${unit} · ${id}`, { released: true });
      },
      swap({ from: fromUnit, to: toUnit, id }) {
        const src = world.inventory.units[fromUnit];
        const moved = src?.reservations.find((r) => r.id === id);
        if (moved) {
          src.reservations = src.reservations.filter((r) => r.id !== id);
          (world.inventory.units[toUnit] ||= { reservations: [] }).reservations.push(moved);
        }
        return record('inventory.swap', `${fromUnit} → ${toUnit}`, { swapped: !!moved });
      },
    },

    calendar: {
      update({ event, start }) {
        world.calendar.events[event] = { ...(world.calendar.events[event] || {}), start };
        return record('calendar.update', `${event} · ${start}`, { ok: true });
      },
    },

    crm: {
      /** Fuzzy contact lookup. The threshold is the planner's to choose. */
      query({ candidate, threshold }) {
        const scored = world.crm.contacts
          .map((c) => ({ contact: c, score: similarity(c.email, candidate.email) }))
          .sort((a, b) => b.score - a.score);
        const best = scored[0];
        const match = best && best.score >= threshold ? best : null;
        return record(
          'crm.query',
          `dedupe threshold ${threshold.toFixed(2)}` +
            (best ? ` · best ${best.score.toFixed(2)}` : ' · no candidates'),
          { match: match?.contact ?? null, score: best?.score ?? 0 }
        );
      },
      create({ contact }) {
        world.crm.contacts.push({ ...contact });
        return record('crm.create', `${contact.email}`, { created: true });
      },
      merge({ into, contact }) {
        const target = world.crm.contacts.find((c) => c.email === into.email);
        if (target) target.aliases = [...(target.aliases || []), contact.email];
        return record('crm.merge', `into ${into.email}`, { merged: true });
      },
      update({ id, patch }) {
        world.crm.reservations[id] = { ...(world.crm.reservations[id] || {}), ...patch };
        return record('crm.update', `${id} · ${Object.keys(patch).join(', ')}`, { ok: true });
      },
    },

    gmail: {
      send({ to, template }) {
        const recipients = Array.isArray(to) ? to : [to];
        world.gmail.sent.push({ to: recipients, template });
        return record(
          'gmail.send',
          `${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`,
          { sent: recipients.length }
        );
      },
    },
  };
}
