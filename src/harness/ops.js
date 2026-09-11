/**
 * The normalized CRM operation surface - the tools an agent is handed.
 *
 * Ten operations cover what agents actually do to a CRM. Every one of them
 * records a span carrying the arguments, the result, the latency the adapter
 * charges, and the native request that a live deployment would have issued.
 * Nothing here reaches a provider; the whole surface runs against the shadow
 * world in world.js.
 *
 * Three mechanics in this file are what later stages measure:
 *
 *   reads are dated      get_record and search_records remember the version the
 *                        agent saw. A later blind write can therefore be told
 *                        apart from an informed one, which is the difference
 *                        between an update and a lost update.
 *   writes are keyed     every mutation carries an idempotency key. Replaying a
 *                        key the world has seen is a no-op; losing the key
 *                        writes twice.
 *   the world moves      seed.concurrent lets an outside actor edit a record
 *                        immediately after a nominated operation, so "someone
 *                        changed it while the agent was thinking" is
 *                        reproducible rather than a race.
 */

import { all, get, insert, put, remove, matchConfidence } from './world.js';
import { hubspot } from './adapters.js';
import { STAGES } from './schema.js';

/**
 * A provider error. `transient` is the single most consequential field in the
 * harness: it is what separates a fault worth retrying from one where retrying
 * is itself the bug. A 429 clears on its own. A 403 does not, and an agent that
 * retries it burns its budget and then fails anyway.
 */
export class CrmError extends Error {
  constructor(code, message, { transient = false, retryAfter = null, ambiguous = false } = {}) {
    super(message);
    this.name = 'CrmError';
    this.code = code;
    this.transient = transient;
    this.retryAfter = retryAfter;
    // An ambiguous failure is one where the agent cannot tell whether the write
    // landed - a timeout, not a rejection. Retrying is safe only under a key.
    this.ambiguous = ambiguous;
  }
}

const readKey = (type, id) => `${type}:${id}`;

/**
 * The record a span is about. Most operations name it `id`, but a merge names
 * two and an activity names its parent - and a trace that shows a blank there
 * is a trace nobody can read.
 */
const spanId = (args) => args.id ?? args.duplicate ?? args.about ?? null;

/**
 * Build the operation surface over one world.
 *
 * `hook` is the fault-injection seam. It is called before every operation with
 * the op name, its arguments and its index in the run, and may throw a CrmError
 * to fail the call or return `{ omit }` to hand back a response with fields
 * missing. chaos.js is its only caller; a clean run passes no hook at all.
 */
export function makeOps(world, trace, { adapter = hubspot, hook = null } = {}) {
  world.reads ||= new Map();
  let index = 0;

  /**
   * Outside writes scheduled to land after a particular operation. `after` is
   * either an op index or a `{ op, id }` signature; the signature form is what
   * cases use, because it lands in the same place whether the action is
   * rehearsed on its own or replayed inside a longer run.
   */
  const applyConcurrent = (justRan) => {
    for (const c of world.concurrent || []) {
      if (c._done) continue;
      const hit =
        typeof c.after === 'number'
          ? c.after === index
          : c.after.op === justRan.op &&
            (c.after.id == null || c.after.id === justRan.args.id) &&
            (c.after.type == null || c.after.type === justRan.args.type);
      if (!hit) continue;
      c._done = true;
      put(world, c.type, c.id, c.patch, 'concurrent_write');
    }
  };

  const run = (op, args, body) => {
    index += 1;
    const native = adapter.native(op, args);
    const ms = adapter.cost?.[op] ?? 120;

    let injected = null;
    if (hook) {
      try {
        injected = hook({ op, args, index, adapter }) || null;
      } catch (err) {
        trace.push({
          op, index, type: args.type ?? null, id: spanId(args), args, ms,
          adapter: adapter.id, native, status: 'error',
          error: { code: err.code, message: err.message, transient: err.transient },
          class: adapter.class(op),
        });
        applyConcurrent({ op, args });
        throw err;
      }
    }

    let result = body();
    // A response that lost fields in transit. The agent still gets a success,
    // which is the point - it proceeds on a partial read.
    if (injected?.omit) {
      result = { ...result };
      for (const f of injected.omit) delete result[f];
      result._partial = injected.omit;
    }
    // A search index that has not caught up. The result is well-formed and the
    // call succeeded; it is just missing a record that exists, which is how an
    // agent ends up creating something it already has.
    if (injected?.drop && Array.isArray(result.records)) {
      const kept = result.records.slice(0, Math.max(0, result.records.length - injected.drop));
      result = { ...result, records: kept, count: kept.length, _dropped: injected.drop };
    }

    trace.push({
      op, index, type: args.type ?? null, id: spanId(args), args, result, ms,
      adapter: adapter.id, native, status: 'ok', class: adapter.class(op),
    });
    applyConcurrent({ op, args });
    return result;
  };

  /** Reject an operation the adapter has no object for. */
  const requireType = (op, type) => {
    if (!adapter.supports(type)) {
      throw new CrmError(400, `${adapter.label} has no object for "${type}"`, { transient: false });
    }
  };

  /** Refuse a duplicate write rather than performing it twice. */
  const once = (key, fn) => {
    if (key && world.keys.has(key)) return { ok: true, deduped: true };
    if (key) world.keys.add(key);
    return fn();
  };

  return {
    adapter,

    search_records({ type, where = {}, limit = 100 }) {
      requireType('search_records', type);
      return run('search_records', { type, where, limit }, () => {
        const match = (r) =>
          Object.entries(where).every(([k, v]) =>
            typeof v === 'function' ? v(r[k], r) : r[k] === v
          );
        const rows = all(world, type).filter(match).slice(0, limit);
        // A search is a read: it dates every record it returned, so an update
        // built from these results can be checked for staleness later.
        for (const r of rows) world.reads.set(readKey(type, r.id), { version: r._v, at: world.clock });
        return { records: rows.map((r) => ({ ...r })), count: rows.length };
      });
    },

    get_record({ type, id }) {
      requireType('get_record', type);
      return run('get_record', { type, id }, () => {
        const r = get(world, type, id);
        if (!r) throw new CrmError(404, `${type} ${id} not found`, { transient: false });
        world.reads.set(readKey(type, id), { version: r._v, at: world.clock });
        return { record: { ...r }, version: r._v };
      });
    },

    create_record({ type, values, key = null }) {
      requireType('create_record', type);
      return run('create_record', { type, values, key }, () =>
        once(key, () => {
          const n = all(world, type).length + 1;
          const id = values.id ?? `${type[0].toUpperCase()}-new-${n}`;
          insert(world, type, { ...values, id });
          return { ok: true, id };
        })
      );
    },

    /**
     * `ifVersion` is optimistic concurrency. Supplying it turns a lost update
     * into a 409 the agent can recover from; omitting it turns the same
     * situation into a silent overwrite that only the invariants will catch.
     */
    update_record({ type, id, patch, ifVersion = null, key = null }) {
      requireType('update_record', type);
      return run('update_record', { type, id, patch, ifVersion, key }, () =>
        once(key, () => {
          const r = get(world, type, id);
          if (!r) throw new CrmError(404, `${type} ${id} not found`, { transient: false });
          if (ifVersion != null && ifVersion !== r._v) {
            throw new CrmError(409, `${type} ${id} changed since it was read (v${ifVersion} → v${r._v})`, {
              transient: false,
            });
          }
          put(world, type, id, patch);
          return { ok: true, version: r._v };
        })
      );
    },

    delete_record({ type, id, key = null }) {
      requireType('delete_record', type);
      return run('delete_record', { type, id, key }, () =>
        once(key, () => {
          const row = remove(world, type, id);
          if (!row) throw new CrmError(404, `${type} ${id} not found`, { transient: false });
          return { ok: true, id, recoverable: adapter.class('delete_record') !== 'irreversible' };
        })
      );
    },

    /**
     * Stage moves go through their own operation rather than a generic update,
     * because the pipeline is where the domain rules live - direction, closure,
     * and whether the adapter can even represent the destination.
     */
    change_stage({ id, to, ifVersion = null, key = null }) {
      return run('change_stage', { type: 'deal', id, to, ifVersion, key }, () =>
        once(key, () => {
          const d = get(world, 'deal', id);
          if (!d) throw new CrmError(404, `deal ${id} not found`, { transient: false });
          if (!STAGES.includes(to)) throw new CrmError(400, `unknown stage "${to}"`, { transient: false });
          if (ifVersion != null && ifVersion !== d._v) {
            throw new CrmError(409, `deal ${id} changed since it was read`, { transient: false });
          }
          const from = d.stage;
          // What the provider will actually hold. If the adapter's pipeline
          // cannot tell the requested stage apart from an earlier one, the
          // value that comes back on the next read is the earlier one - so
          // that is what the shadow CRM stores. The call still returns 200.
          // This is the sharpest example of why a green response is not an
          // outcome: the write succeeded and the deal did not move.
          const stored = STAGES.find((s) => adapter.stage(s) === adapter.stage(to)) ?? to;
          const noop = stored !== to;
          put(world, 'deal', id, { stage: stored }, 'change_stage');
          return { ok: true, from, to, stored, native_stage: adapter.stage(to), noop };
        })
      );
    },

    assign_owner({ type, id, owner, key = null }) {
      requireType('assign_owner', type);
      return run('assign_owner', { type, id, owner, key }, () =>
        once(key, () => {
          const r = get(world, type, id);
          if (!r) throw new CrmError(404, `${type} ${id} not found`, { transient: false });
          if (!get(world, 'owner', owner)) {
            throw new CrmError(400, `owner ${owner} is not a user in this workspace`, { transient: false });
          }
          put(world, type, id, { owner_id: owner }, 'assign_owner');
          return { ok: true, owner };
        })
      );
    },

    /**
     * Merge is the one operation in this surface with no way back. The loser's
     * fields are folded into the winner where the winner has none, and the
     * loser is deleted. Its prior values survive only in the audit log, which
     * the provider would not have kept.
     */
    merge_records({ type, primary, duplicate, key = null }) {
      requireType('merge_records', type);
      return run('merge_records', { type, primary, duplicate, key }, () =>
        once(key, () => {
          const a = get(world, type, primary);
          const b = get(world, type, duplicate);
          if (!a || !b) throw new CrmError(404, `cannot merge ${primary} with ${duplicate}`, { transient: false });
          const confidence = matchConfidence(a, b);
          const fill = {};
          for (const [k, v] of Object.entries(b)) {
            if (k.startsWith('_') || k === 'id') continue;
            if (a[k] == null || a[k] === '') fill[k] = v;
          }
          if (Object.keys(fill).length) put(world, type, primary, fill, 'merge_records');
          remove(world, type, duplicate, 'merge_records');
          world.merges ||= [];
          world.merges.push({ type, primary, duplicate, confidence, at: world.clock });
          return { ok: true, primary, absorbed: duplicate, confidence };
        })
      );
    },

    create_task({ about, subject, owner = null, due = null, key = null }) {
      requireType('create_task', 'task');
      return run('create_task', { type: 'task', about, subject, owner, due }, () =>
        once(key, () => {
          const id = `T-${all(world, 'task').length + 1}`;
          insert(world, 'task', { id, about, subject, owner_id: owner, due });
          return { ok: true, id };
        })
      );
    },

    add_note({ about, body, key = null }) {
      requireType('add_note', 'note');
      return run('add_note', { type: 'note', about, body }, () =>
        once(key, () => {
          const id = `N-${all(world, 'note').length + 1}`;
          insert(world, 'note', { id, about, body });
          return { ok: true, id };
        })
      );
    },
  };
}
