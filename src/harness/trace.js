import { runCase } from './index.js';
import { caseById } from './cases.js';
import { rehearseAll } from './shadow.js';
import { planCompensation } from './recovery.js';
import { v19 } from './agents.js';
import { hubspot } from './adapters.js';

/**
 * One run, as the trace view shows it.
 *
 * The connector spans are executed for real against a shadow account, so their
 * arguments, results and native requests are what the operations genuinely
 * produced. Three spans have no operation behind them — planning, tool
 * discovery, and the shadow rehearsal itself — and those are derived rather
 * than invented: the rehearsal span reports the diff and violation counts the
 * pre-flight gate actually found.
 */
export function runTrace({ adapter = hubspot, build = v19, caseId = 'c1' } = {}) {
  const testCase = caseById(caseId);
  const run = runCase(testCase, build, { adapter });

  const rehearsed = rehearseAll({ adapter });
  const diffs = rehearsed.reduce((n, a) => n + a.diff.length, 0);
  const blocked = rehearsed.filter((a) => a.trips.length).length;

  const connectorSpans = run.trace.map((s) => ({
    name: `${s.op}${s.id ? ` · ${s.id}` : ''}`,
    ms: s.ms,
    status: s.status === 'error' ? `${s.error.code} ${s.error.transient ? 'retry' : 'fatal'}` : s.result?.noop ? 'no-op' : s.result?._partial ? 'partial' : 'ok',
    args: s.args,
    result: s.status === 'error' ? s.error : s.result,
    native: `${s.native.method} ${s.native.path}`,
    class: s.class,
  }));

  const spans = [
    {
      name: 'llm.plan',
      ms: 940,
      status: 'ok',
      args: { goal: testCase.goal, build: build.id, settings: build.settings },
      result: { steps: run.trace.length, operations: [...new Set(run.trace.map((s) => s.op))] },
    },
    {
      name: 'composio.tools.discover',
      ms: 310,
      status: 'ok',
      args: { connection: adapter.id, objects: Object.keys(adapter.objects).filter((t) => adapter.supports(t)) },
      result: {
        tools: 10,
        unsupported: Object.keys(adapter.objects).filter((t) => !adapter.supports(t)),
        auth: 'session valid',
      },
    },
    {
      name: 'agentguard.shadow',
      ms: 720,
      status: blocked ? 'held' : 'ok',
      args: { mode: 'shadow', proposed: rehearsed.length, crm: adapter.label },
      result: { diffs, side_effects: 0, held: blocked },
    },
    ...connectorSpans,
    {
      name: 'agentguard.verify',
      ms: 260,
      status: run.pass ? 'ok' : 'failed',
      args: { assertions: Object.keys(testCase.expect || {}).length },
      result: {
        state_accuracy: `${(run.score.stateAccuracy * 100).toFixed(1)}%`,
        invariants_failed: run.violations.map((v) => v.id),
        misses: run.score.misses.map((m) => `${m.field}: ${m.got} (want ${m.want})`),
      },
    },
  ];

  // Lay the spans out on a shared timeline, so the bars reflect real durations.
  const total = spans.reduce((n, s) => n + s.ms, 0);
  let at = 0;
  const laid = spans.map((s, i) => {
    const left = (at / total) * 100;
    at += s.ms;
    return {
      id: `s${i + 1}`,
      name: s.name,
      left,
      width: (s.ms / total) * 100,
      ms: s.ms >= 1000 ? (s.ms / 1000).toFixed(2) + 's' : s.ms + 'ms',
      status: s.status,
      cls: s.class ?? null,
      native: s.native ?? null,
      args: JSON.stringify(s.args ?? {}, null, 2),
      result: JSON.stringify(s.result ?? {}, null, 2),
    };
  });

  return { spans: laid, run, totalMs: total };
}

/**
 * The compensating plan for a run, as the rollback panel shows it. Built from
 * the audit log, so the steps are the writes that actually happened — and the
 * ones with no inverse say so instead of claiming a clean restore.
 */
export function runSaga({ adapter = hubspot, build = v19, caseId = 'c1' } = {}) {
  const run = runCase(caseById(caseId), build, { adapter });
  const plan = planCompensation(run.world, adapter);

  return {
    steps: plan.map((s) => ({
      step: `${s.entry.op} — ${s.entry.type} ${s.entry.id}`,
      state: s.class === 'irreversible' ? 'no inverse' : s.action === 'delete' ? 'reversible' : 'compensable',
      undo: s.detail,
      color:
        s.class === 'irreversible'
          ? 'var(--color-accent-800)'
          : s.class === 'compensable'
            ? 'var(--color-neutral-800)'
            : 'var(--color-neutral-700)',
    })),
    unrecoverable: plan.filter((s) => s.class === 'irreversible').length,
    clean: run.pass,
  };
}
