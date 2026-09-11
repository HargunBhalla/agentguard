import { CrmError } from './ops.js';

/**
 * The failure catalogue.
 *
 * These are the ways a CRM actually misbehaves under an agent, and they are
 * sorted by the only distinction that changes what a correct agent should do:
 * whether waiting helps. Everything above the line clears on its own.
 * Everything below it will still be there on the third attempt, so retrying is
 * not resilience - it is three times the damage and a later failure.
 *
 * `ambiguous` marks the faults where the agent cannot tell whether its write
 * landed. Those are the ones where an idempotency key is the only thing
 * standing between a retry and a duplicate.
 */
export const FAULTS = [
  // - transient ------------------------------------------------
  { id: 'rate_limit', code: 429, name: '429 rate limit', transient: true, retryAfter: '30s', note: 'Provider throttles part-way through the batch.' },
  { id: 'timeout', code: 408, name: 'Timeout', transient: true, ambiguous: true, note: 'No response after 30s. The write may or may not have landed.' },
  { id: 'server_error', code: 500, name: '500 from provider', transient: true, note: 'Upstream error. Retryable, and usually gone by the second attempt.' },
  { id: 'partial_batch', code: 207, name: 'Partial batch failure', transient: true, sticky: true, note: 'The batch stops succeeding part-way and stays broken.' },

  // - permanent ------------------------------------------------
  // `sticky` is what makes these permanent rather than merely labelled so: they
  // fire on every attempt, because that is what "retrying changes nothing"
  // means. A 403 that cleared on the second try would quietly reward exactly
  // the behaviour this catalogue exists to catch.
  { id: 'permission', code: 403, name: 'Permission denied', transient: false, sticky: true, note: 'The connected user cannot write this object. Retrying changes nothing.' },
  { id: 'invalid_field', code: 400, name: 'Invalid field', transient: false, sticky: true, note: 'A property this pipeline does not define. Retrying changes nothing.' },
  { id: 'conflict', code: 409, name: 'Concurrent modification', transient: false, sticky: true, note: 'Another write landed first. The fix is a re-read, not a retry.' },

  // - succeeds, but lies ------------------------------------------
  { id: 'malformed', code: 200, name: 'Malformed response', transient: false, malformed: true, note: '200 with fields missing from the payload. The agent proceeds on a partial read.' },
  { id: 'stale_index', code: 200, name: 'Stale search index', transient: false, drops: 1, note: 'A recently written record is missing from search results.' },
];

export const faultById = (id) => FAULTS.find((f) => f.id === id) ?? FAULTS[0];

/** Operations a fault can be aimed at, in the order a run reaches them. */
export const INJECTION_POINTS = [
  { op: 'search_records', label: 'search_records - finding the work' },
  { op: 'assign_owner', label: 'assign_owner - claiming an account' },
  { op: 'get_record', label: 'get_record - the read before a write' },
  { op: 'change_stage', label: 'change_stage - moving the deal' },
  { op: 'create_task', label: 'create_task - the follow-up' },
  { op: 'merge_records', label: 'merge_records - collapsing a duplicate' },
];

/**
 * Build the hook ops.js calls before every operation.
 *
 * The fault fires on the `nth` matching operation. With `persist`, it fires on
 * that one and every one after it - which is the difference between a blip and
 * an outage, and the difference between an agent that recovers and an agent
 * that has to decide when to stop.
 */
export function makeInjector({ fault = 'rate_limit', op = 'change_stage', nth = 1, persist = false } = {}) {
  const f = faultById(fault);
  let seen = 0;

  return ({ op: called }) => {
    if (called !== op) return null;
    seen += 1;
    const armed = persist || f.sticky ? seen >= nth : seen === nth;
    if (!armed) return null;

    if (f.malformed) return { omit: ['id'] };
    if (f.drops) return { drop: f.drops };

    throw new CrmError(f.code, `${f.name} on ${op}`, {
      transient: f.transient,
      retryAfter: f.retryAfter ?? null,
      ambiguous: !!f.ambiguous,
    });
  };
}
