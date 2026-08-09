/**
 * The shadow world the harness replays against.
 *
 * This is the "sandbox copy of every app" the pipeline talks about: a plain
 * object holding inventory, calendar, CRM and mail state. Planners never touch
 * it directly — they go through the instrumented tools in tools.js, so every
 * mutation is recorded and every run is reproducible.
 */

/** Inclusive list of ISO days from `from` to `to`. */
export function days(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** ISO date strings sort lexicographically, so range overlap is a string compare. */
export function overlaps(a, b) {
  return a.from <= b.to && b.from <= a.to;
}

/**
 * Dice coefficient over character bigrams — the CRM's fuzzy match for
 * deciding whether an inbound site contact is someone it already knows.
 */
export function similarity(a, b) {
  const bigrams = (s) => {
    const t = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const out = new Map();
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const n of x.values()) total += n;
  for (const [g, n] of y) {
    total += n;
    shared += Math.min(n, x.get(g) || 0);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}

export function createWorld(seed = {}) {
  return {
    inventory: {
      // unit id -> reservations already committed against it
      units: structuredClone(seed.units || {}),
    },
    calendar: { events: structuredClone(seed.events || {}) },
    crm: {
      contacts: structuredClone(seed.contacts || []),
      reservations: structuredClone(seed.reservations || {}),
    },
    gmail: { sent: [] },
  };
}
