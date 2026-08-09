import { createWorld } from './world.js';
import { makeTools } from './tools.js';
import { SEED, PROPOSAL, rehearseAll } from './shadow.js';
import { runChaos } from './chaos.js';

/**
 * Run 8812, as the trace view shows it.
 *
 * The connector calls are executed for real against a shadow copy, so their
 * arguments and results are what the tools actually produced. The three spans
 * that have no tool behind them — planning, tool discovery, and the shadow
 * simulation itself — are derived instead: the simulate span reports the diff
 * and violation counts the pre-flight rehearsal genuinely found.
 */
export function runTrace() {
  const world = createWorld(SEED);
  const trace = [];
  const t = makeTools(world, trace);

  // The planner's own reads, executed against the shadow world.
  t.crm.query({
    candidate: { email: 'marcus.hale@abcconstruction.com' },
    threshold: 0.9,
  });
  t.inventory.check({ unit: '184', from: '2026-08-14', to: '2026-08-17', perDay: true, ignore: 'R-2118' });

  const rehearsed = rehearseAll();
  const diffs = rehearsed.reduce((n, a) => n + a.diff.length, 0);
  const violations = rehearsed.filter((a) => a.trips.length).length;

  // Counted off the tool surface rather than quoted.
  const toolCount = Object.values(makeTools(createWorld(), [])).reduce(
    (n, group) => n + Object.keys(group).length,
    0
  );

  const connectorSpans = trace.map((s) => ({ ...s, status: 'ok' }));

  const spans = [
    {
      tool: 'llm.plan',
      ms: 820,
      status: 'ok',
      args: { goal: 'move ABC excavator to Friday, update salesperson, notify customer' },
      result: { steps: PROPOSAL.length, tools: [...new Set(PROPOSAL.map((a) => a.tool.split('.')[0]))] },
    },
    {
      tool: 'composio.tools.discover',
      ms: 290,
      status: 'ok',
      args: { connections: ['gmail', 'google_calendar', 'rentalcrm'] },
      result: { tools: toolCount, auth: 'all sessions valid' },
    },
    ...connectorSpans,
    {
      tool: 'agentguard.simulate',
      ms: 690,
      status: 'shadow',
      args: { mode: 'shadow', actions: PROPOSAL.length },
      result: { diffs, side_effects: 0, violations },
    },
    // The calendar write is the step the recorded run had to retry.
    ...(() => {
      const w2 = createWorld(SEED);
      const tr2 = [];
      makeTools(w2, tr2).calendar.update({ event: 'dlv-184', start: '2026-08-14T07:00' });
      return tr2.map((s) => ({
        ...s,
        ms: 1100,
        status: 'retry 2/3',
        result: { error: '429 rateLimitExceeded', retry_after: '30s' },
      }));
    })(),
    ...(() => {
      const w3 = createWorld(SEED);
      const tr3 = [];
      makeTools(w3, tr3).gmail.send({
        to: 'marcus.hale@abcconstruction.com',
        template: 'rental-reschedule',
      });
      return tr3.map((s) => ({ ...s, status: 'ok', result: { ...s.result, checkpoint: 'ck-8812-03' } }));
    })(),
  ];

  // Lay the spans out on a shared timeline, so the bars reflect real durations.
  const total = spans.reduce((n, s) => n + s.ms, 0);
  let at = 0;
  return spans.map((s, i) => {
    const left = (at / total) * 100;
    at += s.ms;
    return {
      id: `s${i + 1}`,
      name: s.tool,
      left,
      width: (s.ms / total) * 100,
      ms: s.ms >= 1000 ? (s.ms / 1000).toFixed(2) + 's' : s.ms + 'ms',
      status: s.status,
      args: JSON.stringify(s.args ?? {}, null, 2),
      result: JSON.stringify(s.result ?? {}, null, 2),
    };
  });
}

/**
 * The compensating saga, taken from a run whose retries all failed: whatever
 * had been committed when the budget ran out is what has to be undone.
 */
export function runSaga() {
  const { log } = runChaos({ fault: 'f1', stepId: 'calendar.update', mods: { persist: true } });
  const failedAt = 'calendar.update';
  const order = ['inventory.reserve', 'calendar.update', 'crm.update', 'gmail.send'];
  const undo = {
    'inventory.reserve': 'Reservation released; unit returned to Wed–Sat.',
    'calendar.update': 'Nothing to undo — the write never landed.',
    'crm.update': 'Stage reverted to Scheduled; last_touch restored.',
    'gmail.send': 'Skipped; no notice went out.',
  };
  const labels = {
    'inventory.reserve': 'inventory.reserve — #219',
    'calendar.update': 'calendar.update — dlv-184',
    'crm.update': 'crm.update — R-2118',
    'gmail.send': 'gmail.send — Marcus Hale',
  };

  const failedIndex = order.indexOf(failedAt);
  return {
    log,
    steps: order.map((tool, i) => ({
      step: labels[tool],
      state: i < failedIndex ? 'committed' : i === failedIndex ? 'failed' : 'not run',
      undo: undo[tool],
    })),
  };
}
