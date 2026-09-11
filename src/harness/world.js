/**
 * The shadow CRM the harness replays against.
 *
 * A plain object holding records by type, plus an audit log and a monotonic
 * clock. Agents never touch it directly - they go through the normalized
 * operations in ops.js, so every mutation is recorded, every read is dated, and
 * every run is reproducible.
 *
 * The clock is a tick counter rather than a timestamp. Two things depend on it:
 * optimistic concurrency (`_v` per record) and staleness (a write is stale if
 * the record moved after the agent read it). Both need ordering, neither needs
 * wall time, and a counter keeps runs byte-identical across machines.
 */

export const TYPES = ['company', 'contact', 'deal', 'lead', 'task', 'note', 'owner'];

/**
 * Dice coefficient over character bigrams - the fuzzy match behind duplicate
 * detection. Every CRM ships something like this; what differs between agent
 * builds is the confidence they will act on.
 */
export function similarity(a, b) {
  const bigrams = (s) => {
    const t = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
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

/**
 * Confidence that two contacts are the same person. Email dominates - it is the
 * one field a CRM treats as near-unique - but a matching name on its own is not
 * evidence, so the name only ever pulls the score toward the email's verdict.
 */
export function matchConfidence(a, b) {
  const email = similarity(a.email || '', b.email || '');
  const name = similarity(a.name || '', b.name || '');
  return Number((email * 0.8 + name * 0.2).toFixed(4));
}

export function createWorld(seed = {}) {
  const world = {
    records: Object.fromEntries(TYPES.map((t) => [t, {}])),
    audit: [],
    clock: 0,
    // Idempotency keys the world has already accepted. A retry that reuses its
    // key is a no-op; a retry that loses it writes twice.
    keys: new Set(),
    // Writes an outside actor makes mid-run, keyed by the op index they land
    // after. This is how "someone edited the record while the agent was
    // thinking" becomes a reproducible condition rather than a race.
    concurrent: structuredClone(seed.concurrent || []),
    // Ground truth the agent never sees: which real person or company each
    // record actually refers to. Two records sharing an identity are genuinely
    // the same entity and merging them is right; two that do not are different
    // people, and merging them destroys one of them. This is what lets the
    // suite judge a merge after the evidence for it has been deleted.
    identity: structuredClone(seed.identity || {}),
    merges: [],
  };

  for (const [type, rows] of Object.entries(seed.records || {})) {
    for (const row of rows) {
      world.records[type][row.id] = { ...structuredClone(row), _v: row._v ?? 1, _updated: row._updated ?? 0 };
    }
  }
  return world;
}

/** Every record of a type, as an array. */
export function all(world, type) {
  return Object.values(world.records[type] || {});
}

export function get(world, type, id) {
  return world.records[type]?.[id] ?? null;
}

/**
 * Write a patch onto a record, bumping its version and stamping the clock. The
 * prior field values go into the audit log, which is what compensating actions
 * are rebuilt from - recovery reads history rather than guessing at an inverse.
 */
export function put(world, type, id, patch, op = 'update_record') {
  const target = world.records[type][id];
  if (!target) return null;
  const before = {};
  for (const k of Object.keys(patch)) before[k] = target[k];
  Object.assign(target, patch);
  target._v += 1;
  target._updated = ++world.clock;
  world.audit.push({ op, type, id, before, after: { ...patch }, at: target._updated });
  return target;
}

export function insert(world, type, record, op = 'create_record') {
  const row = { ...record, _v: 1, _updated: ++world.clock };
  world.records[type][row.id] = row;
  world.audit.push({ op, type, id: row.id, before: null, after: { ...record }, at: row._updated });
  return row;
}

export function remove(world, type, id, op = 'delete_record') {
  const row = world.records[type][id];
  if (!row) return null;
  delete world.records[type][id];
  world.audit.push({ op, type, id, before: { ...row }, after: null, at: ++world.clock });
  return row;
}

/**
 * Flatten a world into the comparable fields a diff is expressed in - the
 * things an operator would recognise on a record page. Internal bookkeeping
 * (`_v`, `_updated`) stays out, so a version bump alone never reads as a change.
 */
export function project(world) {
  const out = {};
  const field = (type, id, name, value) => {
    out[`${type}.${id}.${name}`] = value == null ? '-' : String(value);
  };
  for (const c of all(world, 'company')) {
    field('company', c.id, 'owner_id', c.owner_id);
    field('company', c.id, 'tier', c.tier);
  }
  for (const d of all(world, 'deal')) {
    field('deal', d.id, 'stage', d.stage);
    field('deal', d.id, 'owner_id', d.owner_id);
    field('deal', d.id, 'amount', d.amount);
  }
  for (const c of all(world, 'contact')) {
    field('contact', c.id, 'email', c.email);
  }
  out['contact.count'] = String(all(world, 'contact').length);
  out['deal.count'] = String(all(world, 'deal').length);
  out['company.count'] = String(all(world, 'company').length);
  out['task.count'] = String(all(world, 'task').length);
  out['note.count'] = String(all(world, 'note').length);
  return out;
}

/**
 * Projected fields one audit entry could have moved. Used to attribute a wrong
 * end state back to the mutation that caused it - the difference between "this
 * run is wrong" and "this call is wrong".
 */
export function fieldsTouched(entry) {
  if (entry.after === null) return [`${entry.type}.count`];
  if (entry.before === null) return [`${entry.type}.count`];
  return Object.keys(entry.after).map((f) => `${entry.type}.${entry.id}.${f}`);
}

/** Fields where two projected worlds disagree. */
export function diffProjections(before, after) {
  return Object.keys({ ...before, ...after })
    .filter((k) => before[k] !== after[k])
    .sort()
    .map((k) => ({ field: k, before: before[k] ?? '-', after: after[k] ?? '-' }));
}
