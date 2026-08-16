import { insert, put, remove, project } from './world.js';

/**
 * Recovery and compensating actions.
 *
 * There is no generic "undo" against a CRM, so this file does the next best
 * thing: it rebuilds the inverse of a run from the audit log, and is explicit
 * about the steps where no inverse exists.
 *
 * Every plan step carries the reversibility class the adapter assigned it, and
 * that class is a property of the provider rather than the operation — the same
 * delete is recoverable on HubSpot and permanent on Attio. A plan containing an
 * irreversible step is not a rollback. It is a partial rollback plus an
 * incident, and saying so is more useful than pretending otherwise.
 */

/** Audit entries the agent caused, newest first. Outside edits are not ours to undo. */
function ourWrites(world) {
  return (world.audit || []).filter((e) => e.op !== 'concurrent_write').slice().reverse();
}

/**
 * Build the compensating plan for a run. Steps come back in the order they
 * should be applied — reverse of the order they were written, so a record is
 * restored before anything that depended on it.
 */
export function planCompensation(world, adapter) {
  return ourWrites(world).map((e) => {
    const cls = adapter.class(e.op === 'merge_records' ? 'merge_records' : e.op);

    if (e.before === null) {
      return {
        entry: e, action: 'delete', class: 'reversible',
        detail: `Delete ${e.type} ${e.id}, which this run created.`,
      };
    }
    if (e.after === null) {
      return {
        entry: e, action: 'recreate', class: cls,
        detail:
          cls === 'irreversible'
            ? `${e.type} ${e.id} was deleted permanently on ${adapter.label}. The audit log holds its fields, but the record and everything hanging off it are gone.`
            : `Recreate ${e.type} ${e.id} from the values captured before the delete.`,
      };
    }
    return {
      entry: e, action: 'restore', class: cls,
      detail: `Restore ${Object.keys(e.before).join(', ')} on ${e.type} ${e.id}.`,
    };
  });
}

/**
 * Apply a compensating plan to the world. Returns what it could not put back —
 * an empty list means the run was fully undone, and anything in it is the
 * damage that survives.
 */
export function compensate(world, plan) {
  const unrecoverable = [];

  for (const step of plan) {
    const e = step.entry;
    if (step.class === 'irreversible') {
      unrecoverable.push(step);
      continue;
    }
    if (step.action === 'delete') remove(world, e.type, e.id, 'compensate');
    else if (step.action === 'recreate') insert(world, e.type, e.before, 'compensate');
    else put(world, e.type, e.id, e.before, 'compensate');
  }

  return unrecoverable;
}

/**
 * Roll a world back and report how close to the checkpoint it landed. The
 * verdict is a diff, not a claim: whatever still differs from the pre-run state
 * after compensating is exactly the damage the rollback could not reach.
 */
export function rollback(world, adapter, checkpoint) {
  const plan = planCompensation(world, adapter);
  const unrecoverable = compensate(world, plan);
  const after = project(world);
  const residue = Object.keys({ ...checkpoint, ...after }).filter((k) => checkpoint[k] !== after[k]);

  return {
    plan,
    unrecoverable,
    residue,
    clean: residue.length === 0,
    summary: residue.length === 0
      ? `Restored to the checkpoint. ${plan.length} write${plan.length === 1 ? '' : 's'} undone.`
      : `${residue.length} field${residue.length === 1 ? '' : 's'} could not be restored: ${residue.slice(0, 3).join(', ')}.`,
  };
}

/** Counts by reversibility class, for the pre-flight summary. */
export function classify(trace, adapter) {
  const out = { reversible: 0, compensable: 0, irreversible: 0 };
  for (const s of trace) {
    if (s.status !== 'ok' || s.op === 'search_records' || s.op === 'get_record') continue;
    out[adapter.class(s.op)] += 1;
  }
  return out;
}
