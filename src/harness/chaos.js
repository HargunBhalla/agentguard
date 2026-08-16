import { runCase } from './index.js';
import { caseById } from './cases.js';
import { faultById, FAULTS, INJECTION_POINTS } from './faults.js';
import { rollback } from './recovery.js';
import { v18, v19 } from './agents.js';
import { hubspot } from './adapters.js';
import { duplicateActions } from './metrics.js';

export { FAULTS, INJECTION_POINTS };

/**
 * The failure lab.
 *
 * A recorded case is replayed against a shadow account with a fault forced into
 * one operation, and the agent's own retry policy decides what happens next.
 * Nothing about the verdict is scripted: the log is read off the spans the run
 * really produced, duplicates are counted in the resulting CRM, and consistency
 * is a diff against the same case run clean.
 *
 * When the run leaves the account wrong, the compensating plan is built from
 * the audit log and applied — and whatever it cannot put back is reported as
 * exactly that, rather than as a successful rollback.
 */

const INK = 'var(--color-neutral-800)';
const GOLD = 'var(--color-accent-700)';
const DEEP = 'var(--color-accent-800)';

export const MODIFIERS = [
  { id: 'persist', label: 'Persist the fault (every attempt fails)' },
  { id: 'rollback', label: 'Roll back if the run leaves the CRM wrong' },
];

/** Turn the spans a run produced into an operator-readable log. */
function narrate(run, fault, target, adapter) {
  const log = [];
  let t = 0;
  const say = (text, color = INK) => log.push({ t: (t / 1000).toFixed(2) + 's', text, color });

  say(`Replaying “${run.case}” against a shadow ${adapter.label} account.`);

  let attempt = 0;
  for (const span of run.trace) {
    t += span.ms;

    if (span.status === 'error') {
      attempt += 1;
      const e = span.error;
      const kind = e.transient ? 'transient' : 'permanent';
      say(
        `${span.op}${span.id ? ` ${span.id}` : ''} failed — ${e.code} ${e.message} (${kind}).` +
          (e.transient ? ` Backing off ${attempt * 2}s.` : ' Waiting will not help.'),
        e.transient ? GOLD : DEEP
      );
      if (e.transient) t += attempt * 2000;
      continue;
    }

    if (span.op === target && attempt > 0) {
      say(`${span.op}${span.id ? ` ${span.id}` : ''} succeeded on attempt ${attempt + 1}.`);
      attempt = 0;
      continue;
    }

    if (span.result?.deduped) {
      say(`${span.op} replayed under a key the account had already seen — no second write.`, GOLD);
      continue;
    }
    if (span.result?.noop) {
      say(
        `${span.op} ${span.id} returned 200, but ${adapter.label} stores ${span.result.stored} for ` +
          `both ${span.result.stored} and ${span.args.to}. The deal did not move.`,
        DEEP
      );
      continue;
    }
    if (span.result?._partial) {
      say(`${span.op} returned 200 with ${span.result._partial.join(', ')} missing from the payload.`, DEEP);
      continue;
    }
    if (span.result?._dropped) {
      say(`${span.op} returned ${span.result.count} records. The index is behind, and it is not saying so.`, DEEP);
      continue;
    }
    if (span.op === 'search_records' || span.op === 'get_record') continue;

    say(`${span.op}${span.id ? ` ${span.id}` : ''} · ${adapter.class(span.op)}`);
  }

  for (const err of run.report.errors) {
    say(
      run.report.halted
        ? `Run halted at ${err.at}. ${err.code} is not retryable, so the agent stopped and filed an incident.`
        : `${err.at} gave up after 3 attempts. The agent skipped the record and carried on.`,
      run.report.halted ? GOLD : DEEP
    );
  }

  return { log, elapsed: t };
}

export function runChaos({
  adapter = hubspot,
  build = v18,
  caseId = 'c1',
  fault = 'rate_limit',
  op = 'change_stage',
  nth = 1,
  mods = {},
} = {}) {
  const base = caseById(caseId);
  const f = faultById(fault);
  const testCase = { ...base, fault: { fault, op, nth, persist: !!mods.persist } };

  const run = runCase(testCase, build, { adapter });
  const clean = runCase({ ...base, fault: null }, build, { adapter });

  const { log, elapsed } = narrate(run, f, op, adapter);
  const duplicates = duplicateActions(run.world);

  // Consistency is measured against the state a correct run leaves behind, and
  // `clean` is the same case replayed without the fault — the control the
  // faulted run is read against rather than a description of what should have
  // happened.
  const misses = run.score.misses;

  let recovery = null;
  if (mods.rollback && !run.pass) {
    recovery = rollback(run.world, adapter, run.checkpoint);
    log.push({
      t: ((elapsed + 680) / 1000).toFixed(2) + 's',
      text: recovery.clean
        ? `Compensating plan applied — ${recovery.plan.length} writes undone. ${recovery.summary}`
        : `Compensating plan applied, but ${recovery.unrecoverable.length} step${recovery.unrecoverable.length === 1 ? '' : 's'} had no inverse on ${adapter.label}. ${recovery.summary}`,
      color: recovery.clean ? GOLD : DEEP,
    });
  }

  const permanentDamage = run.unrecoverable.length;

  const outcome = {
    headline: run.report.halted
      ? 'Failed safe. The run stopped rather than guessing.'
      : misses.length === 0
        ? 'Recovered cleanly.'
        : permanentDamage
          ? 'Completed — and did permanent damage.'
          : 'Completed, but the account is wrong.',
    border: misses.length ? 'var(--color-accent)' : 'var(--color-divider)',
    color: permanentDamage ? DEEP : misses.length || run.report.halted ? GOLD : 'var(--color-text)',
    checks: [
      {
        label: 'Recovered',
        value: run.report.halted ? 'No — halted' : misses.length === 0 ? `Yes · ${(elapsed / 1000).toFixed(1)}s` : 'No — completed wrong',
        note: run.report.halted
          ? `${f.name} is not retryable; the agent stopped and escalated.`
          : misses.length === 0
            ? 'Backoff absorbed the fault and the end state matches a clean run.'
            : `${misses.length} field${misses.length === 1 ? '' : 's'} differ from a clean run.`,
        color: misses.length || run.report.halted ? GOLD : 'var(--color-neutral-800)',
      },
      {
        label: 'Duplicate actions',
        value: duplicates ? `${duplicates} written twice` : 'None',
        note: duplicates
          ? 'A re-issue under a fresh key wrote a second time.'
          : 'Idempotency keys held across every retry.',
        color: duplicates ? DEEP : 'var(--color-neutral-700)',
      },
      {
        label: 'Work preserved',
        value: `${run.score.correctMutations} of ${run.score.mutations} writes`,
        note: run.score.incorrectMutations
          ? `${run.score.incorrectMutations} write${run.score.incorrectMutations === 1 ? '' : 's'} left a field wrong.`
          : 'Everything committed before the fault survived it.',
        color: run.score.incorrectMutations ? DEEP : 'var(--color-neutral-700)',
      },
      {
        label: 'Recoverable',
        value: permanentDamage ? `No — ${permanentDamage} permanent` : recovery ? (recovery.clean ? 'Rolled back' : 'Partly') : 'Yes',
        note: permanentDamage
          ? run.unrecoverable[0]
          : recovery
            ? recovery.summary
            : `Every write this run made is reversible or compensable on ${adapter.label}.`,
        color: permanentDamage ? DEEP : 'var(--color-neutral-700)',
      },
    ],
  };

  return { log, outcome, run, clean, recovery, duplicates, halted: run.report.halted, elapsed };
}
