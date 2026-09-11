import { matchConfidence } from './world.js';
import { stageIndex, isClosed, STAGES } from './schema.js';

/**
 * The two agent builds under comparison.
 *
 * They share one body. Everything separating v1.9 from v1.8 is the three
 * settings below, and each one is the kind of change that gets merged without
 * argument - fewer API calls, more duplicates caught, fewer runs abandoned:
 *
 *   verifyBeforeWrite  v1.8 re-reads a record immediately before writing to it
 *                      and sends the version it saw. v1.9 writes straight from
 *                      the search result. Half the calls, and no way to notice
 *                      that a human edited the record in between.
 *
 *   mergeConfidence    v1.8 will only merge two records at 0.95. v1.9 lowered
 *                      the bar to 0.90 to catch more duplicates. The records
 *                      most likely to score in that band are the thin ones -
 *                      an initial and a surname - where the score is high
 *                      because there is nothing there to disagree.
 *
 *   resilientErrors    v1.8 stops when a provider rejects a call outright.
 *                      v1.9 retries everything and, if it still fails, moves on
 *                      to the next record. It finishes more runs. It also
 *                      hammers a 403 three times and then keeps writing.
 *
 * None of the three is a bug on its own. All three are regressions, and the
 * only thing that says so is the state the runs leave behind.
 */

const MAX_ATTEMPTS = 3;

function makeAgent({ id, label, verifyBeforeWrite, mergeConfidence, resilientErrors }) {
  return {
    id,
    label,
    settings: { verifyBeforeWrite, mergeConfidence, resilientErrors },

    run(goal, ops) {
      const report = { retries: 0, halted: false, skipped: [], errors: [], reason: null };

      /**
       * The retry policy - the thing failure injection is really testing.
       *
       * A transient fault clears if you wait. A 403 or a 400 does not, and the
       * only question is whether the agent notices the difference.
       */
      const attempt = (label, fn) => {
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
          try {
            return { ok: true, value: fn(n) };
          } catch (err) {
            const worthRetrying = err.transient || resilientErrors;
            if (n < MAX_ATTEMPTS && worthRetrying) {
              report.retries += 1;
              continue;
            }
            report.errors.push({ at: label, code: err.code, message: err.message, transient: !!err.transient });
            if (resilientErrors) {
              // Skip this record and carry on with the rest of the batch.
              report.skipped.push(label);
              return { ok: false, err };
            }
            report.halted = true;
            report.reason = `${err.code} at ${label}: ${err.message}`;
            return { ok: false, err, fatal: true };
          }
        }
        return { ok: false };
      };

      // ---- 1. Unowned accounts -------------------------------------------
      const unowned = ops.search_records({ type: 'company', where: { owner_id: null } }).records;
      const owners = ops.search_records({ type: 'owner' }).records;

      for (const [i, company] of unowned.entries()) {
        const owner = owners[i % owners.length];
        const r = attempt(`assign_owner:${company.id}`, () =>
          ops.assign_owner({ type: 'company', id: company.id, owner: owner.id, key: `own:${company.id}` })
        );
        if (r.fatal) return report;
      }

      // ---- 2. Qualified deals, moved one stage forward --------------------
      // Never past Negotiation: closing a deal is a human's call, and an agent
      // that can write Closed Won can write it wrongly.
      const CAP = stageIndex('Negotiation');
      const candidates = ops.search_records({ type: 'deal', where: { qualified: true } }).records
        .filter((d) => !isClosed(d.stage) && stageIndex(d.stage) < CAP);

      for (const deal of candidates) {
        let version = null;
        let current = deal.stage;

        if (verifyBeforeWrite) {
          const read = attempt(`get_record:${deal.id}`, () => ops.get_record({ type: 'deal', id: deal.id }));
          if (read.fatal) return report;
          if (read.ok) {
            version = read.value.version;
            current = read.value.record.stage;
          }
        }

        const next = STAGES[stageIndex(deal.stage) + 1];
        // Somebody may have moved this deal since the search. Writing the
        // planned stage anyway would drag it backwards.
        if (isClosed(current) || stageIndex(current) >= stageIndex(next)) {
          report.skipped.push(`change_stage:${deal.id} - already at ${current}`);
          continue;
        }

        const moved = attempt(`change_stage:${deal.id}`, () =>
          ops.change_stage({ id: deal.id, to: next, ifVersion: version, key: `stage:${deal.id}` })
        );
        if (moved.fatal) return report;
        if (!moved.ok) continue;

        // Follow-up task, keyed on the deal so a retry cannot file it twice.
        const filed = attempt(`create_task:${deal.id}`, (n) =>
          ops.create_task({
            about: deal.id,
            subject: `Confirm qualification - ${deal.name}`,
            owner: deal.owner_id ?? owners[0].id,
            key: `task:${deal.id}`,
          })
        );
        if (filed.fatal) return report;
        // A response that came back without an id tells the agent nothing about
        // whether the task exists. It re-files under a fresh key, which is the
        // moment the idempotency key stops protecting anything.
        if (filed.ok && filed.value && filed.value.id === undefined) {
          attempt(`create_task:${deal.id}:refile`, () =>
            ops.create_task({
              about: deal.id,
              subject: `Confirm qualification - ${deal.name}`,
              owner: deal.owner_id ?? owners[0].id,
              key: `task:${deal.id}:refile`,
            })
          );
        }
      }

      // ---- 3. Obvious duplicates -----------------------------------------
      const contacts = ops.search_records({ type: 'contact' }).records;
      const merged = new Set();

      for (let i = 0; i < contacts.length; i++) {
        for (let j = i + 1; j < contacts.length; j++) {
          const a = contacts[i];
          const b = contacts[j];
          if (merged.has(a.id) || merged.has(b.id)) continue;
          if (matchConfidence(a, b) < mergeConfidence) continue;

          const r = attempt(`merge_records:${b.id}`, () =>
            ops.merge_records({ type: 'contact', primary: a.id, duplicate: b.id, key: `merge:${b.id}` })
          );
          if (r.fatal) return report;
          if (r.ok) merged.add(b.id);
        }
      }

      return report;
    },
  };
}

export const v18 = makeAgent({
  id: 'v1.8',
  label: 'v1.8 - current',
  verifyBeforeWrite: true,
  mergeConfidence: 0.95,
  resilientErrors: false,
});

export const v19 = makeAgent({
  id: 'v1.9',
  label: 'v1.9 - candidate',
  verifyBeforeWrite: false,
  mergeConfidence: 0.9,
  resilientErrors: true,
});

export const BUILDS = [v18, v19];
