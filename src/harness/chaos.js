import { createWorld } from './world.js';
import { project, SEED } from './shadow.js';

/**
 * Fault injection and recovery.
 *
 * The approved plan is replayed against a shadow copy with a fault forced into
 * one step, then driven through the real recovery policy: retry three times
 * with exponential backoff, and if the budget runs out, compensate back to the
 * checkpoint. The verdict is not scripted — duplicates are counted in the
 * resulting world and consistency is decided by diffing it against a clean run.
 */

const INK = 'var(--color-neutral-800)';
const GOLD = 'var(--color-accent-700)';
const DEEP = 'var(--color-accent-800)';

export const FAULTS = [
  { id: 'f1', name: '429 rate limit', note: 'Provider throttles mid-batch', transient: true },
  { id: 'f2', name: 'Timeout', note: 'No response after 30s', transient: true },
  { id: 'f3', name: 'Auth token expired', note: 'Composio session refresh fails once', transient: true },
  { id: 'f4', name: 'Partial write', note: 'Reservation lands, notification does not', transient: true, partial: true },
  { id: 'f5', name: '500 from provider', note: 'Upstream error, retryable', transient: true },
  { id: 'f6', name: 'Malformed JSON', note: 'Tool returns an unparseable payload', transient: true, unreadable: true },
  { id: 'f7', name: 'Stale inventory', note: 'Availability read is 40s out of date', transient: true, stale: true },
];

export const MODIFIERS = [
  { id: 'persist', label: 'Persist failure (every retry fails)' },
  { id: 'expire', label: 'Expire OAuth token mid-run' },
  { id: 'corrupt', label: 'Corrupt response payload' },
];

/** The approved plan for run 8812, after the operator swapped to unit #219. */
const PLAN = [
  { tool: 'inventory.reserve', key: 'ck-reserve-219', label: 'inventory.reserve' },
  { tool: 'calendar.update', key: 'ck-cal-184', label: 'calendar.update' },
  { tool: 'crm.update', key: 'ck-crm-2118', label: 'crm.update' },
  { tool: 'gmail.send', key: 'ck-mail-hale', label: 'gmail.send' },
];

const COST = { 'inventory.reserve': 620, 'calendar.update': 540, 'crm.update': 480, 'gmail.send': 700 };

/**
 * Apply one step to the world. Writes carry an idempotency key: replaying a key
 * the world has already seen is a no-op, which is what makes a retry safe.
 */
function commit(world, step, key) {
  world._keys ||= new Set();
  if (world._keys.has(key)) return { duplicate: false, skipped: true };
  world._keys.add(key);

  switch (step.tool) {
    case 'inventory.reserve': {
      const u = (world.inventory.units['219'] ||= { reservations: [] });
      const dup = u.reservations.some((r) => r.from === '2026-08-14');
      u.reservations.push({ id: `R-2118-${world._keys.size}`, from: '2026-08-14', to: '2026-08-17' });
      return { duplicate: dup };
    }
    case 'calendar.update':
      world.calendar.events['dlv-184'] = { start: '2026-08-14T07:00' };
      return { duplicate: false };
    case 'crm.update': {
      const dup = world.crm.reservations['R-2118']?.stage === 'Rescheduled';
      world.crm.reservations['R-2118'] = { stage: 'Rescheduled', customer_id: 'ABC' };
      return { duplicate: dup };
    }
    case 'gmail.send': {
      const dup = world.gmail.sent.length > 0;
      world.gmail.sent.push({ to: ['marcus.hale@abcconstruction.com'], template: 'rental-reschedule' });
      return { duplicate: dup };
    }
    default:
      return { duplicate: false };
  }
}

/** Run the plan with no faults — the reference the fault run is judged against. */
function cleanRun() {
  const world = createWorld(SEED);
  for (const step of PLAN) commit(world, step, step.key);
  return project(world);
}

/** Undo committed steps back to the checkpoint. */
function compensate(world, committed) {
  for (const step of [...committed].reverse()) {
    switch (step.tool) {
      case 'inventory.reserve':
        // The checkpoint had no unit 219 at all, so restoring it to an empty
        // record would leave a field the pre-run state never had.
        if (SEED.units['219']) world.inventory.units['219'] = structuredClone(SEED.units['219']);
        else delete world.inventory.units['219'];
        break;
      case 'calendar.update':
        world.calendar.events['dlv-184'] = { ...SEED.events['dlv-184'] };
        break;
      case 'crm.update':
        world.crm.reservations['R-2118'] = { ...SEED.reservations['R-2118'] };
        break;
      case 'gmail.send':
        world.gmail.sent.pop();
        break;
    }
  }
}

export function runChaos({ fault = 'f1', stepId = 'gmail.send', mods = {} } = {}) {
  const f = FAULTS.find((x) => x.id === fault) || FAULTS[0];
  const target = PLAN.find((s) => s.tool === stepId) || PLAN[PLAN.length - 1];

  const world = createWorld(SEED);
  const log = [];
  const committed = [];
  let t = 0;
  let duplicates = 0;
  let halted = false;
  let recoveredAt = null;

  const at = () => (t / 1000).toFixed(2) + 's';
  const say = (text, color = INK) => log.push({ t: at(), text, color });

  say('Replaying recorded run 8812 against the shadow copy.');

  for (const step of PLAN) {
    t += COST[step.tool];

    if (step !== target) {
      commit(world, step, step.key);
      committed.push(step);
      continue;
    }

    say(`Injected ${f.name} at ${step.tool} (batch 3 of 9).`, GOLD);

    // The OAuth modifier is handled before the retry loop: the session is
    // refreshed in place and the step resumes rather than being retried.
    if (mods.expire) {
      t += 820;
      say('OAuth token expired mid-run. Refresh requested.', GOLD);
      t += 820;
      say('Refresh succeeded after 1 failure. Session re-established.');
      t += 340;
      say(`Resumed ${step.tool} from the last acknowledged batch.`);
      commit(world, step, step.key);
      committed.push(step);
      recoveredAt = t;
      continue;
    }

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const fails = mods.persist || attempt === 1;

      if (!fails) {
        // A corrupted response means the agent never learns the write landed,
        // so it re-issues under a fresh idempotency key — and the key is what
        // was protecting it from writing twice.
        const key = mods.corrupt ? `${step.key}-retry${attempt}` : step.key;
        if (mods.corrupt) {
          t += 70;
          say('Response payload failed schema validation — 2 fields unreadable.', DEEP);
          t += 20;
          say(`Agent proceeded on a partial read and re-issued ${step.tool}.`, DEEP);
          commit(world, step, step.key);
          const again = commit(world, step, key);
          if (again.duplicate) duplicates++;
          t += 690;
          say(`Idempotency key missed on the re-issue — a duplicate ${step.tool} landed.`, DEEP);
        } else {
          commit(world, step, key);
          say(`Attempt ${attempt} succeeded. Batch 3 of 9 acknowledged.`);
        }
        committed.push(step);
        ok = true;
        recoveredAt = t;
        break;
      }

      const backoff = 2000 * attempt;
      t += 60;
      say(
        `Attempt ${attempt} failed.` +
          (attempt < 3 ? ` Backing off ${backoff / 1000}s.` : ' Retry budget exhausted.'),
        attempt < 3 ? INK : DEEP
      );
      if (attempt < 3) t += backoff;
    }

    if (!ok) {
      halted = true;
      t += 20;
      say(
        'Compensating saga to ck-8812-03 — reservation released, calendar event restored, notice recalled.',
        GOLD
      );
      compensate(world, committed);
      committed.length = 0;
      t += 680;
      say('Run halted. Incident filed as INC-2261.');
      break;
    }
  }

  if (mods.corrupt && duplicates) {
    t += 380;
    say('Rollback released the duplicate, but the CRM reservation stage is now ambiguous.', GOLD);
  } else if (!halted && !mods.expire) {
    say('Run completed. Reservation, calendar and notice all consistent.');
  } else if (mods.expire) {
    say('Run completed. Reservation, calendar and notice all consistent.');
  }

  // Verdict, read off the world rather than scripted.
  const final = project(world);
  const clean = cleanRun();
  const expected = halted ? project(createWorld(SEED)) : clean;
  const drifted = Object.keys({ ...expected, ...final }).filter((k) => expected[k] !== final[k]);
  const consistent = drifted.length === 0;

  const outcome = {
    headline: duplicates
      ? 'Recovered — but not cleanly.'
      : halted
        ? 'Failed safe. No duplicates, no drift.'
        : 'Recovered cleanly.',
    border: duplicates || halted ? 'var(--color-accent)' : 'var(--color-divider)',
    color: duplicates ? DEEP : halted ? GOLD : 'var(--color-text)',
    checks: [
      {
        label: 'Recovered',
        value: halted ? 'No — halted' : `Yes · ${(recoveredAt / 1000).toFixed(1)}s`,
        note: halted
          ? 'Retry budget spent; run stopped deliberately.'
          : mods.expire
            ? 'Token refreshed and the run resumed in place.'
            : 'Backoff absorbed the fault inside the SLA.',
        color: halted ? GOLD : 'var(--color-neutral-800)',
      },
      {
        label: 'Duplicate actions',
        value: duplicates ? `${duplicates} detected` : 'None',
        note: duplicates
          ? 'A re-issue under a fresh key wrote twice.'
          : 'Idempotency keys held across every retry.',
        color: duplicates ? DEEP : 'var(--color-neutral-700)',
      },
      {
        label: 'State consistency',
        value: consistent ? 'Clean' : 'Diverged',
        note: consistent
          ? halted
            ? 'Shadow state matches the pre-run checkpoint.'
            : 'Final state equals the predicted diff.'
          : `${drifted.length} field${drifted.length === 1 ? ' differs' : 's differ'}: ${drifted.slice(0, 2).join(', ')}.`,
        color: consistent ? 'var(--color-neutral-700)' : DEEP,
      },
    ],
  };

  return { log, outcome, world, duplicates, halted };
}
