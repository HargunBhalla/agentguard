import { ACCOUNT, GOAL } from './schema.js';
import { SEED } from './shadow.js';

/**
 * The recorded scenarios the suite replays.
 *
 * Each case carries the account it starts from, the goal handed to the agent,
 * any fault to inject, and — the part that does the work — `expect`: the CRM
 * state a correct run leaves behind, written as projected fields.
 *
 * Nothing here says which build should pass. That falls out of running them.
 * Two of these cases fail on both builds, which is not a mistake: they are
 * defects neither version fixed, and a suite where every case cleanly separates
 * the two would be a suite that had been written backwards from the answer.
 */

/** The three unowned accounts, assigned round-robin in search order. */
const ASSIGNED = {
  'company.A-200.owner_id': 'O-1',
  'company.A-300.owner_id': 'O-2',
  'company.A-500.owner_id': 'O-3',
};

/** Nobody touched the Reyes pair, because they are two different people. */
const REYES_INTACT = {
  'contact.C-301.email': 'j.reyes@northwind.example',
  'contact.C-302.email': 'd.reyes@northwind.example',
};

/**
 * The account with the ambiguous contact pair taken out, so a case built on it
 * measures one thing. Cases that keep the pair are testing the merge; cases
 * that drop it are testing something else, and mixing the two would make every
 * result read as the merge regression.
 */
const NO_DUPLICATES = {
  records: { ...ACCOUNT.records, contact: [ACCOUNT.records.contact[4]] },
  identity: {},
};

/** A wide, boring account — enough unowned records to make the batch itself the risk. */
function sweepSeed(n = 40) {
  return {
    records: {
      owner: ACCOUNT.records.owner,
      company: Array.from({ length: n }, (_, i) => ({
        id: `S-${100 + i}`,
        name: `Sweep Account ${i + 1}`,
        domain: `sweep${i + 1}.example`,
        tier: i % 7 === 0 ? 'enterprise' : 'mid',
        owner_id: null,
      })),
      deal: [],
      contact: [],
      lead: [],
      task: [],
      note: [],
    },
    identity: {},
  };
}

export const CASES = [
  {
    id: 'c1',
    name: 'Enterprise pipeline review',
    summary: 'The whole goal end to end against a live-shaped account.',
    goal: GOAL,
    seed: SEED,
    expect: {
      ...ASSIGNED,
      ...REYES_INTACT,
      'deal.D-101.stage': 'Qualified',
      // Won deals are terminal and unqualified ones are not the agent's to move.
      'deal.D-105.stage': 'Closed Won',
      'deal.D-104.stage': 'Discovery',
      'contact.count': '4',
      'task.count': '3',
    },
  },

  {
    id: 'c2',
    name: 'A rep edits the deal mid-run',
    summary:
      'Between the agent listing the pipeline and writing to it, the account owner moves D-101 to Proposal by hand. The deal must not come back.',
    goal: GOAL,
    seed: {
      ...SEED,
      concurrent: [
        { after: { op: 'search_records', type: 'deal' }, type: 'deal', id: 'D-101', patch: { stage: 'Proposal' } },
      ],
    },
    expect: {
      ...ASSIGNED,
      ...REYES_INTACT,
      // The rep knew more than the agent did. Their stage is the correct one.
      'deal.D-101.stage': 'Proposal',
      'contact.count': '4',
      // Two other deals still move; only D-101 is left alone.
      'task.count': '2',
    },
  },

  {
    id: 'c3',
    name: 'Two thin records that are not one person',
    summary:
      'J. Reyes and D. Reyes score 0.92 against each other because both records are almost empty. The merge that would collapse them cannot be undone.',
    goal: 'Merge obvious duplicate contacts.',
    seed: {
      records: {
        owner: ACCOUNT.records.owner,
        company: ACCOUNT.records.company.map((c) => ({ ...c, owner_id: c.owner_id ?? 'O-1' })),
        deal: [],
        contact: ACCOUNT.records.contact,
        lead: [],
        task: [],
        note: [],
      },
      identity: SEED.identity,
    },
    expect: {
      ...REYES_INTACT,
      'contact.C-201.email': 'marcus.hale@acme.example',
      'contact.count': '4',
    },
  },

  {
    id: 'c4',
    name: 'Permission denied claiming an account',
    summary:
      'The connected user cannot write A-300. A 403 does not clear, so the run has nothing to wait for — the only safe move is to stop and escalate.',
    goal: GOAL,
    seed: SEED,
    fault: { fault: 'permission', op: 'assign_owner', nth: 2 },
    expect: {
      'company.A-200.owner_id': 'O-1',
      // Everything from the failed call onward should not have happened.
      'company.A-300.owner_id': '—',
      'company.A-500.owner_id': '—',
      'deal.D-101.stage': 'Discovery',
      'deal.D-102.stage': 'Qualified',
      'deal.D-103.stage': 'Proposal',
      ...REYES_INTACT,
      'contact.count': '5',
      'task.count': '0',
    },
  },

  {
    id: 'c5',
    name: 'Rate limit part-way through the batch',
    summary: 'A 429 on the first stage change. It clears on the retry, and the run should be indistinguishable from a clean one.',
    goal: 'Move qualified opportunities to the next stage and assign unowned accounts.',
    // No duplicate pair here, so this case measures recovery and nothing else.
    seed: NO_DUPLICATES,
    fault: { fault: 'rate_limit', op: 'change_stage', nth: 1 },
    expect: {
      ...ASSIGNED,
      'deal.D-101.stage': 'Qualified',
      'deal.D-105.stage': 'Closed Won',
      'contact.count': '1',
      'task.count': '3',
    },
  },

  {
    id: 'c6',
    name: 'The task write returns an unreadable response',
    summary:
      'create_task lands, but the 200 comes back without an id. The agent cannot confirm what it did, re-files under a fresh key, and the idempotency key stops protecting anything.',
    goal: GOAL,
    seed: SEED,
    fault: { fault: 'malformed', op: 'create_task', nth: 1 },
    expect: {
      ...ASSIGNED,
      ...REYES_INTACT,
      'deal.D-101.stage': 'Qualified',
      // Three deals moved, so exactly three follow-ups should exist.
      'task.count': '3',
      'contact.count': '4',
    },
  },

  {
    id: 'c7',
    name: 'The search index has not caught up',
    summary:
      'Every call succeeds and the run looks clean, but one record never appeared in the results — so the work against it silently did not happen. No agent can see this from its own trace; only the end state shows it.',
    goal: GOAL,
    seed: SEED,
    fault: { fault: 'stale_index', op: 'search_records', nth: 1 },
    expect: {
      ...ASSIGNED,
      ...REYES_INTACT,
      'deal.D-101.stage': 'Qualified',
      'contact.count': '4',
      'task.count': '3',
    },
  },

  {
    id: 'c8',
    name: 'Quarterly sweep — 40 unowned accounts',
    summary: 'Nothing here is dangerous on its own. The batch is the risk, which is a policy question rather than an invariant one.',
    goal: 'Assign every unowned account to a rep.',
    seed: sweepSeed(40),
    expect: {
      'company.S-100.owner_id': 'O-1',
      'company.S-101.owner_id': 'O-2',
      'company.S-102.owner_id': 'O-3',
      // 39 is divisible by 3, so the last account comes back round to the first rep.
      'company.S-139.owner_id': 'O-1',
      'company.count': '40',
    },
  },

  {
    id: 'c9',
    name: 'Every stage move lands where it was aimed',
    summary:
      'Each deal is asserted at the stage the workflow meant to put it in. This is the case that stops being about the agent and starts being about the CRM underneath it.',
    goal: 'Move every qualified opportunity one stage forward.',
    // No ambiguous contacts, so nothing here can fail for a merge reason and
    // the result is purely about the pipeline.
    seed: NO_DUPLICATES,
    expect: {
      'deal.D-101.stage': 'Qualified',
      'deal.D-102.stage': 'Proposal',
      'deal.D-103.stage': 'Negotiation',
      // Already at the cap, and already closed — neither should move.
      'deal.D-106.stage': 'Negotiation',
      'deal.D-105.stage': 'Closed Won',
    },
  },
];

export const caseById = (id) => CASES.find((c) => c.id === id) ?? CASES[0];
