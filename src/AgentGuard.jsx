import React from 'react';
import { css } from './css.js';
import {
  compareAcrossCrms, verdictFor,
  ADAPTERS, adapterById, CASES, v18, v19, METRIC_ROWS, formatMetric, isRegression,
} from './harness/index.js';
import { rehearseAll, invariantStatus } from './harness/shadow.js';
import { POLICIES, OUTCOME_LABEL, heaviest } from './harness/policies.js';
import { runChaos, FAULTS, INJECTION_POINTS, MODIFIERS } from './harness/chaos.js';
import { runTrace, runSaga } from './harness/trace.js';
import { proposeFromRun, proposeTests } from './harness/testgen.js';
import { scorecard } from './harness/scorecard.js';
import { GOAL } from './harness/schema.js';
import { tabFromHash, DEFAULT_TAB } from './routing.js';

/*
 * Everything the screens render is executed, not written down. The suite, the
 * rehearsals and the traces are computed once per CRM at module load — every
 * agent build runs against a fresh shadow account and every operation cost is
 * fixed, so the result is deterministic: the same nine cases, the same four
 * regressions, every reload.
 *
 * Three CRMs × nine cases × two builds is the whole cost, and it is paid once.
 */
const SUITES = Object.fromEntries(compareAcrossCrms().map((s) => [s.adapter.id, s]));
const REHEARSALS = Object.fromEntries(ADAPTERS.map((a) => [a.id, rehearseAll({ adapter: a })]));
const INVARIANTS = Object.fromEntries(ADAPTERS.map((a) => [a.id, invariantStatus({ adapter: a })]));

/** Traces are heavier and only one is on screen at a time, so they are cached lazily. */
const traceCache = new Map();
function traceFor(crm, buildId) {
  const key = `${crm}:${buildId}`;
  if (!traceCache.has(key)) {
    const adapter = adapterById(crm);
    const build = buildId === 'v1.9' ? v19 : v18;
    traceCache.set(key, { ...runTrace({ adapter, build }), saga: runSaga({ adapter, build }) });
  }
  return traceCache.get(key);
}

/* The four policy outcomes, in the colours the status system reserves for
   them: amber is held, red is refused, and warn stays advisory. */
const V = {
  allow: 'var(--color-pass)',
  warn: 'var(--color-accent-600)',
  approve: 'var(--color-held)',
  block: 'var(--color-fail)',
};
const LABEL = OUTCOME_LABEL;
/** An outcome that stops the call going out on its own. */
const HOLDS = new Set(['approve', 'block']);
const CLASS_COLOR = {
  reversible: 'var(--color-text-2)',
  compensable: 'var(--color-neutral-800)',
  irreversible: 'var(--color-fail)',
};

/**
 * The six features the platform is built from. Each opens the screen where it
 * is worked, so the list is a table of contents rather than a picture — and
 * each row reports what it actually measured on this run, not what it does.
 */
const FEATURE_DEFS = [
  { n: '1', name: 'CRM execution layer', tab: 'preflight' },
  { n: '2', name: 'Shadow simulation & state validation', tab: 'preflight' },
  { n: '3', name: 'Policy engine', tab: 'preflight' },
  { n: '4', name: 'Failure & recovery testing', tab: 'chaos' },
  { n: '5', name: 'Replay & agent evaluation', tab: 'evals' },
  { n: '6', name: 'Trace & deployment gate', tab: 'evals' },
];

/**
 * The five screens, in the order an operator works them. This is the single
 * source for the tab bar, each screen's header and the step footer, so the
 * numbering, the plain-language titles and the "what next" prompt can never
 * disagree with each other.
 *
 * `label` is the tab; `title` is the screen's own heading; `blurb` is the one
 * sentence that says what the screen is for, in plain words.
 */
const STEPS = [
  {
    id: 'pipeline', label: 'Overview', title: 'Overview',
    blurb: 'What this evaluation run found. Start here — every row below opens the screen where that check was made.',
    nextCta: 'Review the mutations',
  },
  {
    id: 'preflight', label: 'Review', title: 'Review the proposed changes',
    blurb: 'The agent wants to make these CRM changes. Pick one to see exactly what it would write and which policies object, then approve or block it.',
    nextCta: 'See how they executed',
  },
  {
    id: 'trace', label: 'Trace', title: 'Trace',
    blurb: 'A single agent run, call by call. Open a span to see the request that went to the CRM and what came back.',
    nextCta: 'Try breaking it',
  },
  {
    id: 'chaos', label: 'Failure testing', title: 'Break it on purpose',
    blurb: 'Replay a recorded run with a real failure injected, and see whether the agent recovers or leaves the account wrong.',
    nextCta: 'Compare the builds',
  },
  {
    id: 'evals', label: 'Compare & ship', title: 'Compare builds and decide',
    blurb: 'Both agent builds replayed against every recorded case, scored against the production thresholds — and the ship decision that follows.',
  },
];

export default class AgentGuard extends React.Component {
  state = {
    tab: tabFromHash(), crm: 'hubspot', build: 'v1.9',
    sim: 'idle', selId: 'a1', decisions: {},
    policyOn: Object.fromEntries(POLICIES.map((p) => [p.id, true])),
    openSpans: {}, rollback: 'none',
    chaos: 'idle', chaosLog: [], verdict: null, proposal: null,
    caseId: 'c1', fault: 'permission', op: 'assign_owner', mods: {},
    openCase: null, gate: 'held', showSource: false,
  };

  // ---- derived reads -------------------------------------------------------

  get adapter() { return adapterById(this.state.crm); }
  get suite() { return SUITES[this.state.crm]; }
  get rehearsed() { return REHEARSALS[this.state.crm]; }
  get buildObj() { return this.state.build === 'v1.9' ? v19 : v18; }

  componentDidMount() {
    window.addEventListener('hashchange', this.onHashChange);
    // Give the first tab a hash too, so every tab is equally linkable — but
    // replace rather than push, so Back still leaves the app on the first press.
    if (!window.location.hash) window.history.replaceState(null, '', `#${DEFAULT_TAB}`);
  }

  componentWillUnmount() {
    window.removeEventListener('hashchange', this.onHashChange);
    (this._t || []).forEach(clearTimeout);
  }

  onHashChange = () => this.setState({ tab: tabFromHash() });

  /** Navigate by writing the hash; the listener above is what moves the tab. */
  goTab = (tab) => { if (tab !== this.state.tab) window.location.hash = tab; };
  later(fn, ms) { (this._t = this._t || []).push(setTimeout(fn, ms)); }

  /**
   * A mutation's verdict, given which policies are switched on. Strict mode
   * escalates every objection to a block, which is the difference between a
   * console that advises and one that gates.
   */
  verdictOf(a) {
    const strict = this.props.strictMode ?? false;
    const tripped = a.trips.filter((id) => this.state.policyOn[id]);
    if (!tripped.length) return 'allow';
    // Strict mode escalates every objection to the top of the ladder.
    if (strict) return 'block';
    return heaviest(tripped.map((id) => POLICIES.find((p) => p.id === id).sev));
  }

  runSim = () => {
    this.setState({ sim: 'running' });
    this.later(() => this.setState({ sim: 'done' }), this.props.simMs ?? 1400);
  };

  doRollback = () => {
    if (this.state.rollback !== 'none') return;
    this.setState({ rollback: 'running' });
    this.later(() => this.setState({ rollback: 'done' }), 1100);
  };

  setCrm = (e) => {
    // Traces are per-CRM, and a stale rollback panel would be describing a
    // provider the reader is no longer looking at.
    this.setState({ crm: e.target.value, chaos: 'idle', chaosLog: [], verdict: null, proposal: null, rollback: 'none' });
  };

  /** Replay the selected case with the selected fault genuinely injected. */
  inject = () => {
    if (this.state.chaos === 'running') return;
    const { caseId, fault, op, mods } = this.state;
    const result = runChaos({ adapter: this.adapter, build: this.buildObj, caseId, fault, op, mods });

    // The experiment is also an incident: if it left the account wrong, the
    // generator turns it into a case that can be checked in.
    const base = CASES.find((c) => c.id === caseId);
    const spec = { ...base, fault: { fault, op, nth: 1, persist: !!mods.persist } };
    const proposal = proposeFromRun(result.run, spec);

    this.setState({ chaos: 'running', chaosLog: [], verdict: result.outcome, proposal, showSource: false });
    result.log.forEach((line, i) =>
      this.later(() => this.setState((s) => ({ chaosLog: s.chaosLog.concat(line) })), 260 * (i + 1))
    );
    this.later(() => this.setState({ chaos: 'done' }), 260 * (result.log.length + 1));
  };

  // ---- view values ---------------------------------------------------------

  renderVals() {
    const st = this.state;
    const adapter = this.adapter;
    const suite = this.suite;
    const strict = this.props.strictMode ?? false;

    const tabs = STEPS.map((step, i) => ({
      label: step.label, n: i + 1, go: () => this.goTab(step.id), active: st.tab === step.id,
      bg: st.tab === step.id ? 'var(--color-panel)' : 'transparent',
      color: st.tab === step.id ? 'var(--color-text)' : 'var(--color-text-2)',
    }));

    // Where the reader is in the flow, and what the obvious next move is. A
    // console with five dense screens needs to answer "what now" without the
    // reader having to infer it from the tab bar.
    const stepIndex = Math.max(0, STEPS.findIndex((x) => x.id === st.tab));
    const step = STEPS[stepIndex];
    const nav = {
      n: stepIndex + 1, total: STEPS.length,
      title: step.title, blurb: step.blurb,
      prev: STEPS[stepIndex - 1] && { label: STEPS[stepIndex - 1].label, go: () => this.goTab(STEPS[stepIndex - 1].id) },
      next: STEPS[stepIndex + 1] && { label: STEPS[stepIndex + 1].label, go: () => this.goTab(STEPS[stepIndex + 1].id), cta: STEPS[stepIndex].nextCta },
    };

    // ---- pre-flight --------------------------------------------------------
    const actions = this.rehearsed.map((a) => {
      const d = st.decisions[a.id];
      const v = d === 'blocked' ? 'block' : d === 'approved' ? 'allow' : this.verdictOf(a);
      return {
        ...a, vc: V[v],
        verdictLabel: d === 'approved' ? 'approved' : d === 'blocked' ? 'blocked by you' : LABEL[v],
        cardBg: st.selId === a.id ? 'var(--color-panel)' : 'transparent',
        classColor: CLASS_COLOR[a.reversibility],
        select: () => this.setState({ selId: a.id }),
      };
    });
    const sel = actions.find((a) => a.id === st.selId) || actions[0];

    const selChecks = POLICIES.map((p) => {
      const on = st.policyOn[p.id];
      const trips = sel.trips.includes(p.id);
      const sev = strict ? 'block' : p.sev;
      return {
        name: p.name, rule: p.rule,
        state: !on ? 'off' : trips ? OUTCOME_LABEL[sev] : 'allow',
        reason: trips && on ? (sel.reasons[p.id] || []).join(' · ') : '',
        color: !on ? 'var(--color-neutral-500)' : trips ? V[sev] : 'var(--color-text-2)',
      };
    });

    const policies = POLICIES.map((p) => ({
      name: p.name, mode: strict ? 'hard block' : p.mode,
      mark: st.policyOn[p.id] ? 'var(--color-accent)' : 'var(--color-neutral-400)',
      fill: st.policyOn[p.id] ? 'var(--color-accent)' : 'transparent',
      text: st.policyOn[p.id] ? 'var(--color-text)' : 'var(--color-neutral-500)',
      toggle: () => this.setState((s) => ({ policyOn: { ...s.policyOn, [p.id]: !s.policyOn[p.id] } })),
    }));

    const dec = st.decisions[sel.id];
    const decisionNote = dec === 'approved'
      ? `Executed against ${adapter.label} · checkpoint saved · ${sel.reversibility === 'irreversible' ? 'no undo exists' : 'undo available'}`
      : dec === 'blocked' ? 'Blocked. The agent was told to re-plan without this mutation.' : '';

    const heldCount = actions.filter((a) => {
      const d = st.decisions[a.id];
      if (d === 'approved') return false;
      if (d === 'blocked') return true;
      // A warn is advisory — it is recorded, but it does not hold the call.
      return HOLDS.has(this.verdictOf(a));
    }).length;

    // ---- trace -------------------------------------------------------------
    const t = traceFor(st.crm, st.build);
    const spans = t.spans.map((s) => ({
      ...s, left: s.left + '%', width: s.width + '%',
      bar: s.status === 'ok' ? 'var(--color-text-2)' : 'var(--color-accent)',
      color: s.status === 'ok' ? 'var(--color-text-2)' : 'var(--color-accent-700)',
      caret: st.openSpans[s.id] ? '▾' : '▸',
      open: !!st.openSpans[s.id],
      classColor: s.cls ? CLASS_COLOR[s.cls] : 'var(--color-text-2)',
      toggle: () => this.setState((x) => ({ openSpans: { ...x.openSpans, [s.id]: !x.openSpans[s.id] } })),
    }));

    // ---- failure lab -------------------------------------------------------
    const faultDef = FAULTS.find((f) => f.id === st.fault) || FAULTS[0];
    const opDef = INJECTION_POINTS.find((p) => p.op === st.op) || INJECTION_POINTS[0];
    const caseDef = CASES.find((c) => c.id === st.caseId) || CASES[0];
    const modNames = MODIFIERS.filter((m) => st.mods[m.id]).map((m) => m.label.split(' (')[0].toLowerCase());

    const experimentLine =
      `Injecting ${faultDef.name} into ${opDef.op} while ${this.buildObj.label} replays “${caseDef.name}” ` +
      `against a shadow ${adapter.label} account` + (modNames.length ? `, with ${modNames.join(' and ')}` : '') +
      `. ${faultDef.note} The agent's own retry policy decides what happens next. AgentGuard reports whether the ` +
      `account ended up in the expected state, and which writes a rollback cannot undo.`;

    const modifiers = MODIFIERS.map((m) => ({
      label: m.label,
      mark: st.mods[m.id] ? 'var(--color-accent)' : 'var(--color-neutral-400)',
      fill: st.mods[m.id] ? 'var(--color-accent)' : 'transparent',
      text: st.mods[m.id] ? 'var(--color-text)' : 'var(--color-text-2)',
      toggle: () => this.setState((s) => ({ mods: { ...s.mods, [m.id]: !s.mods[m.id] }, chaos: 'idle', chaosLog: [] })),
    }));

    // ---- evals -------------------------------------------------------------
    const metrics = METRIC_ROWS.map((row) => {
      const a = suite.metrics.baseline[row.key];
      const b = suite.metrics.candidate[row.key];
      const bad = isRegression(row, suite.metrics.baseline, suite.metrics.candidate);
      return {
        label: row.label, old: formatMetric(a, row.format), cand: formatMetric(b, row.format),
        color: bad ? 'var(--color-accent-800)' : 'var(--color-neutral-800)',
        mark: bad ? '↓' : '',
      };
    });

    const cases = suite.results.map((r, i) => ({
      id: r.id, name: r.name,
      fault: r.fault ? FAULTS.find((f) => f.id === r.fault.fault)?.name ?? r.fault.fault : '—',
      base: r.baseline.pass ? 'pass' : 'fail',
      cand: r.candidate.pass ? 'pass' : 'fail',
      delta: r.deltaLabel,
      tag: r.regressed ? 'regression' : r.brokenInBoth ? 'broken in both' : '',
      color: r.candidate.pass ? 'var(--color-text-2)' : 'var(--color-accent-800)',
      tagColor: r.regressed ? 'var(--color-accent-800)' : 'var(--color-text-2)',
      caret: st.openCase === i ? '▾' : '▸',
      bg: st.openCase === i ? 'var(--color-accent-100)' : 'transparent',
      open: () => this.setState((s) => ({ openCase: s.openCase === i ? null : i })),
    }));

    const proposals = proposeTests(suite);
    const novel = proposals.filter((p) => p.novel).length;

    // Failures that belong to the CRM rather than to the build — a case both
    // builds fail here and both pass somewhere else.
    const portability = suite.results
      .filter((r) => r.brokenInBoth && SUITES.hubspot.results.find((h) => h.id === r.id)?.brokenInBoth === false)
      .map((r) => ({ name: r.name, field: r.baseline.score.misses[0]?.field ?? '' }));

    // ---- the run --------------------------------------------------------
    // The pipeline screen reports one concrete evaluation run rather than
    // describing the architecture, so every number below is read off the
    // rehearsals, the trace and the suite that already ran.
    const approvedCount = actions.length - heldCount;
    const diffRows = actions.flatMap((a) => a.diff);
    const touchedRecords = new Set(diffRows.map((d) => d.field.split('.').slice(0, 2).join('.'))).size;
    const irreversible = actions.filter((a) => a.reversibility === 'irreversible').length;
    const accuracy = suite.metrics.candidate.stateAccuracy;

    const runTiles = [
      { n: String(actions.length), label: 'mutations', tone: 'ink' },
      { n: String(approvedCount), label: 'approved', tone: 'pass' },
      { n: String(heldCount), label: 'held', tone: heldCount ? 'held' : 'ink' },
      { n: formatMetric(accuracy, 'pct'), label: 'state accuracy', tone: accuracy < 1 ? 'held' : 'pass' },
    ];

    // Where this run currently sits. Nothing is executed until the operator
    // works the pre-flight screen, so the CRM step is genuinely pending.
    const pathSteps = [
      { mark: 'done', name: 'Request received', note: GOAL },
      { mark: 'done', name: `Agent planned ${actions.length} mutations`, note: `${this.buildObj.label} · ${adapter.label} adapter` },
      { mark: 'active', name: 'AgentGuard evaluating', note: `${approvedCount} cleared · ${heldCount} held` },
      { mark: 'pending', name: 'CRM execution', note: heldCount ? 'awaiting approval' : 'ready to issue' },
    ];

    // One row per feature, reporting what it measured on this run.
    const policyMix = ['allow', 'warn', 'approve', 'block']
      .map((o) => [o, actions.filter((a) => this.verdictOf(a) === o).length])
      .filter(([, n]) => n > 0)
      .map(([o, n]) => `${n} ${OUTCOME_LABEL[o]}`)
      .join(' · ');
    const recovery = suite.metrics.candidate.recoverySuccessRate;
    const card = scorecard(suite.metrics.candidate);

    const stageResults = [
      ['ok', `${actions.length} mutations intercepted`, `normalized across ${ADAPTERS.length} CRM providers`],
      ['ok', `${diffRows.length} fields changed`, `across ${touchedRecords} records, on a shadow account`],
      [heldCount ? 'warn' : 'ok', policyMix || 'no objections', `${POLICIES.length} policies · ${irreversible} irreversible write${irreversible === 1 ? '' : 's'}`],
      [recovery != null && recovery < 0.94 ? 'warn' : 'ok', `${FAULTS.length} faults × ${INJECTION_POINTS.length} injection points`, `recovery ${formatMetric(recovery, 'pct')}`],
      [suite.regressions ? 'fail' : 'ok', `${suite.results.length} cases replayed`, `${suite.baseline.label} vs ${suite.candidate.label} · ${suite.regressions} regressions`],
      [card.verdict === 'pass' ? 'ok' : 'fail', `score ${card.score}/100`, card.verdict === 'pass' ? 'ready for production' : `${card.failed.length} thresholds missed`],
    ];

    const TONE = { ok: 'var(--color-pass)', warn: 'var(--color-held)', fail: 'var(--color-fail)', pending: 'var(--color-pending)', ink: 'var(--color-text)', pass: 'var(--color-pass)', done: 'var(--color-pass)', active: 'var(--color-held)' };
    const MARK = { ok: '✓', warn: '⚠', fail: '✕', done: '✓', active: '●', pending: '○' };

    const run = {
      id: `#${1800 + suite.results.length * 4 + ADAPTERS.findIndex((a) => a.id === st.crm)}`,
      subtitle: `Revenue Ops Agent · ${this.buildObj.label} · ${adapter.label} · staging`,
      status: heldCount ? `${heldCount} held for review` : 'evaluation clear',
      statusTone: heldCount ? TONE.warn : TONE.ok,
      summary: `${actions.length} proposed CRM mutations evaluated before execution. ${approvedCount} cleared policy checks; ${heldCount} held.`,
      tiles: runTiles.map((x) => ({ ...x, color: TONE[x.tone] })),
      path: pathSteps.map((x) => ({ ...x, glyph: MARK[x.mark], color: TONE[x.mark] })),
      provider: 'Composio',
    };

    return {
      run, nav,
      tabs, adapter,
      crm: st.crm, setCrm: this.setCrm, crms: ADAPTERS,
      build: st.build, buildLabel: this.buildObj.label,
      setBuild: (e) => this.setState({ build: e.target.value, chaos: 'idle', chaosLog: [], rollback: 'none' }),
      fleet: `${actions.length} mutations proposed · ${heldCount} held`,

      onPipeline: st.tab === 'pipeline', onPreflight: st.tab === 'preflight',
      onTrace: st.tab === 'trace', onChaos: st.tab === 'chaos', onEvals: st.tab === 'evals',

      stages: FEATURE_DEFS.map((s, i) => {
        const [tone, headline, detail] = stageResults[i];
        return { ...s, headline, detail, glyph: MARK[tone], tone: TONE[tone], go: () => this.goTab(s.tab) };
      }),
      capabilities: ADAPTERS.map((a) => ({
        label: a.label,
        current: a.id === st.crm,
        lead: a.supports('lead') ? 'yes' : 'no object',
        del: a.class('delete_record'),
        merge: a.class('merge_records'),
        collapsed: Object.values(a.collapses).flat().join(' / ') || 'none',
        delColor: CLASS_COLOR[a.class('delete_record')],
      })),

      simIdle: st.sim === 'idle', simRunning: st.sim === 'running',
      simDone: st.sim === 'done', simNotDone: st.sim !== 'done', runSim: this.runSim,
      actions, sel, selDiff: sel.diff, selChecks, policies, decisionNote,
      hasRisk: !!(sel.risk && this.verdictOf(sel) !== 'safe'),
      approve: () => this.setState((s) => ({ decisions: { ...s.decisions, [sel.id]: 'approved' } })),
      block: () => this.setState((s) => ({ decisions: { ...s.decisions, [sel.id]: 'blocked' } })),
      invariants: INVARIANTS[st.crm].map((i) => ({
        expr: i.expr, detail: i.detail,
        mark: i.ok ? '✓' : '✗',
        color: i.ok ? 'var(--color-text-2)' : 'var(--color-accent-800)',
      })),

      spans, traceRun: t.run,
      traceHeadline: `${t.spans.length} spans · ${(t.totalMs / 1000).toFixed(1)}s · ${t.run.trace.length} CRM calls`,
      rollback: this.doRollback,
      rollbackLabel: st.rollback === 'none' ? 'Show the compensating plan' : st.rollback === 'running' ? 'Building…' : 'Plan built',
      rolledBack: st.rollback === 'done',
      saga: t.saga.steps, sagaUnrecoverable: t.saga.unrecoverable,

      faults: FAULTS, points: INJECTION_POINTS, allCases: CASES, modifiers,
      fault: st.fault, op: st.op, caseId: st.caseId, experimentLine,
      setFault: (e) => this.setState({ fault: e.target.value, chaos: 'idle', chaosLog: [] }),
      setOp: (e) => this.setState({ op: e.target.value, chaos: 'idle', chaosLog: [] }),
      setCase: (e) => this.setState({ caseId: e.target.value, chaos: 'idle', chaosLog: [] }),
      inject: this.inject,
      injectLabel: st.chaos === 'running' ? 'Injecting…' : st.chaos === 'done' ? 'Run again' : 'Inject & replay',
      chaosDone: st.chaos === 'done', chaosIdle: st.chaos === 'idle', chaosLog: st.chaosLog,
      verdict: st.verdict || { checks: [] },
      proposal: st.proposal, showSource: st.showSource,
      toggleSource: () => this.setState((s) => ({ showSource: !s.showSource })),

      score: {
        candidate: scorecard(suite.metrics.candidate),
        baseline: scorecard(suite.metrics.baseline),
        candidateLabel: suite.candidate.label,
        baselineLabel: suite.baseline.label,
      },
      metrics, cases, proposals, novel, portability,
      regressions: suite.regressions, brokenInBoth: suite.brokenInBoth,
      compareOpen: st.openCase != null,
      compare: this.compareFor(st.openCase),
      gate: this.gateFor(),
    };
  }

  /** Side-by-side traces for one case, tinted from where the runs stopped agreeing. */
  compareFor(i) {
    if (i == null) return { name: '', summary: '', left: [], right: [], verdict: '', misses: [] };
    const r = this.suite.results[i];
    const ink = 'var(--color-text)';
    const flag = 'var(--color-accent-800)';

    const rows = (run, tint) => [
      ...run.trace.map((sp, n) => ({
        step: `${sp.op}${sp.id ? ` · ${sp.id}` : ''}`,
        meta: sp.status === 'error' ? `${sp.error.code}` : sp.result?.noop ? 'no-op' : sp.native.method,
        color: tint && r.divergesAt >= 0 && n >= r.divergesAt ? flag : ink,
      })),
      { step: 'result', meta: run.pass ? 'pass' : 'fail', color: run.pass ? ink : flag },
    ];

    const summary = r.divergesAt < 0
      ? 'no divergence · both builds agree'
      : `divergence at step ${r.divergesAt + 1} · ` +
        (r.candidate.violations[0]?.id.replace(/_/g, ' ') ?? 'same checks, different state');

    return {
      name: r.name, summary, note: r.summary,
      left: rows(r.baseline, false), right: rows(r.candidate, true),
      verdict: verdictFor(r),
      misses: r.candidate.score.misses.slice(0, 4),
    };
  }

  gateFor() {
    const g = this.state.gate;
    const suite = this.suite;
    const n = suite.regressions;
    const map = {
      held: {
        status: 'held at 10% canary', color: 'var(--color-accent-700)',
        note: `${suite.results.length} recorded cases replayed against ${suite.candidate.label} on ${ADAPTERS.length} CRMs. ${n} regress on ${suite.adapter.label}, and each one writes something no rollback can reach. The candidate stays behind the canary, with every mutation still pre-flighted.`,
        badge: `${n} regressions · rollout held at 10%`,
        outlook: 'Rollout stays held until the suite is green or the merge threshold is put back.',
      },
      promoted: {
        status: 'promoted to 100%', color: 'var(--color-accent-800)',
        note: `${suite.candidate.label} is now the default build for all pipeline traffic. The ${n} failing cases were accepted under an amended policy: any run that trips it is held and the account owner is paged.`,
        badge: `${n} regressions · rolled out to 100%`,
        outlook: 'The failures were accepted with an amended policy, so any run that trips it is held and the owner paged.',
      },
      blocked: {
        status: `blocked · rolled back to ${suite.baseline.id}`, color: 'var(--color-accent-800)',
        note: `${suite.candidate.label} is withdrawn from the canary and ${suite.baseline.id} restored. The candidate keeps receiving shadow traffic, so the suite keeps filling with no production exposure.`,
        badge: `${n} regressions · rolled back to ${suite.baseline.id}`,
        outlook: `${suite.baseline.id} is serving production again. The candidate keeps taking shadow traffic, so the suite fills without exposure.`,
      },
    };
    const actions = [['promoted', 'Promote to 100%'], ['held', 'Hold at canary'], ['blocked', 'Block & roll back']]
      .map(([id, label]) => ({
        label, go: () => this.setState({ gate: id }),
        border: g === id ? 'var(--color-accent)' : 'var(--color-neutral-400)',
        color: g === id ? 'var(--color-accent-700)' : 'var(--color-neutral-800)',
      }));
    return { ...map[g], actions };
  }

  render() {
    const v = this.renderVals();
    const S = {
      page: css(`height:100vh;display:flex;flex-direction:column;background:var(--color-bg);font-family:var(--font-ui)`),
      head: css(`display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 20px;background:var(--color-panel);border-bottom:1px solid var(--color-border);flex:none`),
      eyebrow: css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);padding-bottom:6px`),
      h1: css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.015em;font-size:24px;margin:4px 0 0;line-height:1.2`),
      body: css(`font-size:15px;line-height:1.65;max-width:78ch;margin:11px 0 0;color:var(--color-text-2)`),
      btn: css(`font-family:var(--font-ui);font-size:13px;font-weight:500;padding:7px 14px;border:1px solid var(--color-accent);color:#fff;background:var(--color-accent);border-radius:var(--radius-md);cursor:pointer`),
      btn2: css(`font-family:var(--font-ui);font-size:13px;font-weight:500;padding:7px 14px;border:1px solid var(--color-border);color:var(--color-text);background:var(--color-panel);border-radius:var(--radius-md);cursor:pointer`),
      sel: css(`font-family:var(--font-ui);font-size:13px;padding:5px 8px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-panel);color:var(--color-text)`),
      lab: css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2)`),
      pre: css(`margin:0;font-family:var(--font-mono);font-size:12px;line-height:1.7;background:var(--color-panel-2);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:11px;white-space:pre-wrap;color:var(--color-neutral-800);overflow:auto`),
      card: css(`background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:16px`),
      // A panel is the second plane: a surface with one border, and no lines
      // between the rows inside it.
      panelRaw: `background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg)`,
      panel: css(`background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg)`),
      panelHead: css(`display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 16px;background:var(--color-panel-2);border-bottom:1px solid var(--color-border);border-radius:var(--radius-lg) var(--radius-lg) 0 0;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2)`),
      th: css(`text-align:left;padding:9px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;color:var(--color-text-2);background:var(--color-panel-2)`),
      td: css(`padding:11px 12px;border-top:1px solid var(--color-border)`),
      // Every screen opens the same way: which step it is, what it is called,
      // and one sentence saying what you do on it.
      stepTag: css(`display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--color-accent-700);background:var(--color-accent-100);border-radius:var(--radius-sm);padding:2px 8px`),
      blurb: css(`font-size:13px;line-height:1.6;color:var(--color-text-2);margin-top:6px;max-width:80ch`),
    };

    return (
      <div style={S.page}>
        <header style={S.head}>
          <div style={css(`display:flex;align-items:center;gap:10px`)}>
            {/* A real anchor rather than a click handler, so the wordmark
                behaves like a home link: keyboard-focusable, middle-clickable,
                and it creates a history entry on its own. */}
            <a href="#pipeline" aria-label="AgentGuard — back to the pipeline"
              style={css(`display:flex;align-items:center;gap:8px;color:inherit;text-decoration:none;cursor:pointer`)}>
              <span aria-hidden="true" style={css(`width:22px;height:22px;flex:none;border-radius:6px;background:var(--color-neutral-900);color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center`)}>A</span>
              <span style={css(`font-weight:600;font-size:14px;letter-spacing:-.01em`)}>AgentGuard</span>
            </a>
            {/* The environment is a chip, not a caption: it is a fact about
                where these runs executed, and it should read as one. */}
            <span style={css(`font-size:12px;color:var(--color-text-2);background:var(--color-neutral-200);border-radius:var(--radius-sm);padding:2px 8px;white-space:nowrap`)}>
              revenue-ops / staging
            </span>
          </div>

          {/* Segmented control: the group is the surface, the active tab is
              the one lifted out of it. */}
          <nav style={css(`display:flex;gap:2px;padding:2px;background:var(--color-neutral-200);border-radius:var(--radius-md)`)}>
            {v.tabs.map((t, i) => (
              <button key={i} onClick={t.go} aria-current={t.active ? 'page' : undefined}
                style={css(`display:flex;align-items:center;gap:6px;font-family:var(--font-ui);font-size:13px;font-weight:500;padding:5px 12px;border-radius:var(--radius-sm);cursor:pointer;border:0;white-space:nowrap;background:${t.bg};color:${t.color};box-shadow:${t.active ? 'var(--shadow-sm)' : 'none'}`)}>
                <span style={css(`font-size:11px;font-variant-numeric:tabular-nums;color:${t.active ? 'var(--color-accent-700)' : 'var(--color-neutral-500)'}`)}>{t.n}</span>
                {t.label}
              </button>
            ))}
          </nav>

          <div style={css(`display:flex;align-items:center;gap:8px;font-size:13px;color:var(--color-text-2)`)}>
            {/* These two re-scope every screen in the console, so they are
                labelled rather than left as two bare dropdowns. */}
            <span style={css(`font-size:12px;color:var(--color-text-2)`)}>CRM</span>
            <select value={v.crm} onChange={v.setCrm} aria-label="CRM" style={S.sel}>
              {v.crms.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <span style={css(`font-size:12px;color:var(--color-text-2);margin-left:4px`)}>Build</span>
            <select value={v.build} onChange={v.setBuild} aria-label="Agent build" style={S.sel}>
              <option value="v1.8">v1.8 — current</option>
              <option value="v1.9">v1.9 — candidate</option>
            </select>
            <span style={css(`width:6px;height:6px;border-radius:50%;background:var(--color-pass);animation:ag-pulse 2s infinite`)} />
            <span style={css(`white-space:nowrap`)}>{v.fleet}</span>
          </div>
        </header>

        {/* ---- Pipeline ---------------------------------------------------- */}
        {v.onPipeline && (
          <div style={css(`flex:1;min-height:0;overflow:auto;padding:28px 32px 48px`)}>
            <div style={css(`max-width:1280px;margin:0 auto`)}>

              {/* The run, not the architecture: what this evaluation found. */}
              <div style={css(`display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap`)}>
                <div>
                  <span style={S.stepTag}>Step {v.nav.n} of {v.nav.total}</span>
                  <h1 style={css(`font-family:var(--font-ui);font-weight:600;font-size:22px;letter-spacing:-.02em;margin:8px 0 0;line-height:1.2`)}>
                    Evaluation run {v.run.id}
                  </h1>
                  <div style={css(`font-size:13px;color:var(--color-text-2);margin-top:5px`)}>{v.run.subtitle}</div>
                  <div style={S.blurb}>{v.nav.blurb}</div>
                </div>
                <div style={css(`display:flex;align-items:center;gap:8px;font-size:13px;color:${v.run.statusTone}`)}>
                  <span style={css(`width:7px;height:7px;border-radius:50%;background:${v.run.statusTone}`)} />
                  {v.run.status}
                </div>
              </div>

              <div style={css(`font-size:15px;line-height:1.6;color:var(--color-text-2);margin-top:12px;max-width:78ch`)}>
                {v.run.summary}
              </div>

              {/* Conventional LLM evals stop at the response. The chain below is
                  what this run is actually scored on. */}
              <div style={css(`margin-top:16px;font-size:12px;color:var(--color-text-2)`)}>
                Every run below executed against a shadow account. Nothing here touched a production CRM.
              </div>

              <div style={css(`display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--color-text-2)`)}>
                {['Instruction', 'Agent decision', 'CRM tool call', 'Proposed state change', 'Policy validation', 'Failure handling', 'Final CRM state', 'Business correctness'].map((step, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span style={css(`color:var(--color-neutral-400)`)}>→</span>}
                    <span style={css(`background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:4px 8px;white-space:nowrap`)}>{step}</span>
                  </React.Fragment>
                ))}
              </div>

              {/* Tiles — one border around the group, none between. */}
              <div style={css(`display:grid;grid-template-columns:repeat(4,1fr);margin-top:22px;background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg)`)}>
                {v.run.tiles.map((t, i) => (
                  <div key={i} style={css(`padding:16px 22px;${i ? 'border-left:1px solid var(--color-border);' : ''}`)}>
                    <div style={css(`font-size:30px;line-height:1.1;color:${t.color}`)}>{t.n}</div>
                    <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);margin-top:5px`)}>{t.label}</div>
                  </div>
                ))}
              </div>

              <div style={css(`display:grid;grid-template-columns:340px 1fr;gap:22px;margin-top:22px;align-items:start`)}>

                {/* Execution path — a timeline, not an architecture diagram. */}
                <div style={S.panel}>
                  <div style={S.panelHead}>Execution path</div>
                  <div style={css(`padding:4px 22px 16px`)}>
                    {v.run.path.map((p, i) => (
                      <div key={i} style={css(`display:grid;grid-template-columns:18px 1fr;gap:11px`)}>
                        <div style={css(`display:flex;flex-direction:column;align-items:center`)}>
                          <span style={css(`font-size:12px;line-height:20px;color:${p.color}`)}>{p.glyph}</span>
                          {i < v.run.path.length - 1 && (
                            <span style={css(`flex:1;width:1px;background:var(--color-border)`)} />
                          )}
                        </div>
                        <div style={css(`padding-bottom:${i < v.run.path.length - 1 ? '16px' : '0'}`)}>
                          <div style={css(`font-size:15px;font-weight:560;line-height:20px`)}>{p.name}</div>
                          <div style={css(`font-size:12px;line-height:1.5;color:var(--color-text-2);margin-top:2px`)}>{p.note}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={css(`border-top:1px solid var(--color-border);padding:11px 22px;font-size:12px;color:var(--color-text-2);display:flex;justify-content:space-between;gap:11px`)}>
                    <span>Execution provider: {v.run.provider}</span>
                    <span>CRM adapter: {v.adapter.label}</span>
                  </div>
                </div>

                {/* The eight stages, each reporting what it actually found. */}
                <div style={S.panel}>
                  <div style={S.panelHead}>
                    <span>Evaluation pipeline</span>
                    <span style={css(`font-weight:400;letter-spacing:0;text-transform:none;color:var(--color-text-2)`)}>
                      click a row to open it
                    </span>
                  </div>
                  <div style={css(`padding:6px 0 6px`)}>
                    {v.stages.map((s, i) => (
                      <div key={i} className="hv0" onClick={s.go} role="button" tabIndex={0}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), s.go())}
                        style={css(`cursor:pointer;display:grid;grid-template-columns:34px 1fr 40px;gap:12px;align-items:baseline;padding:11px 22px`)}>
                        <span style={css(`font-family:var(--font-mono);font-size:12px;color:var(--color-text-2)`)}>
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span>
                          <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);display:block`)}>{s.name}</span>
                          <span style={css(`font-size:15px;display:block;margin-top:3px`)}>{s.headline}</span>
                          <span style={css(`font-size:12px;color:var(--color-text-2);display:block`)}>{s.detail}</span>
                        </span>
                        <span style={css(`display:flex;align-items:baseline;justify-content:flex-end;gap:8px;font-size:13px;color:${s.tone}`)}>
                          {s.glyph}<span style={css(`color:var(--color-neutral-400)`)}>→</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Reference, not part of the run — kept below the fold. */}
              <details style={css(`margin-top:24px`)}>
                <summary style={css(`cursor:pointer;font-size:13px;color:var(--color-text-2);padding:6px 0`)}>
                  CRM capabilities — where the three adapters differ
                </summary>
                <div style={css(`font-size:13px;line-height:1.6;color:var(--color-text-2);margin:8px 0 0;max-width:80ch`)}>
                  An agent that is safe on one CRM is not automatically safe on another. The policy engine and the
                  recovery planner read these differences per adapter instead of assuming them.
                </div>
                <div style={css(`${S.panelRaw};margin-top:12px;overflow:hidden`)}>
                  <table style={css(`width:100%;border-collapse:collapse;font-size:14px`)}>
                    <thead><tr>
                      {['CRM', 'Lead object', 'Delete', 'Merge', 'Stages it cannot tell apart'].map((h, i) => (
                        <th key={i} style={S.th}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {v.capabilities.map((c, i) => (
                        <tr key={i}>
                          <td style={css(`padding:11px 12px;border-top:1px solid var(--color-border);color:${c.current ? 'var(--color-accent-700)' : 'var(--color-text)'}`)}>{c.label}</td>
                          <td style={S.td}>{c.lead}</td>
                          <td style={css(`padding:11px 12px;border-top:1px solid var(--color-border);color:${c.delColor}`)}>{c.del}</td>
                          <td style={css(`padding:11px 12px;border-top:1px solid var(--color-border)`)}>{c.merge}</td>
                          <td style={S.td}>{c.collapsed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          </div>
        )}
        {/* ---- Pre-flight -------------------------------------------------- */}
        {v.onPreflight && (
          <div style={css(`flex:1;min-height:0;display:flex;flex-direction:column`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:16px 32px 12px`)}>
              <div>
                <span style={S.stepTag}>Step {v.nav.n} of {v.nav.total}</span>
                <h1 style={S.h1}>{v.actions.length} changes awaiting your review</h1>
                <div style={S.blurb}>{v.nav.blurb}</div>
                <div style={css(`font-size:13px;color:var(--color-text-2);margin-top:6px;max-width:78ch`)}>
                  <span style={css(`color:var(--color-neutral-500)`)}>The agent was asked to:</span> {GOAL}
                </div>
              </div>
              <div style={css(`display:flex;gap:12px;align-items:center`)}>
                {v.simIdle && <button className="hvp" onClick={v.runSim} style={S.btn}>Run shadow execution</button>}
                {v.simRunning && (
                  <span style={css(`font-size:14px;color:var(--color-accent-700);display:flex;align-items:center;gap:8px`)}>
                    <span style={css(`width:80px;height:2px;background:var(--color-accent-200);overflow:hidden;display:inline-block`)}>
                      <span style={css(`display:block;width:30%;height:100%;background:var(--color-accent);animation:ag-sweep 1s linear infinite`)} />
                    </span>
                    rehearsing against a shadow account…
                  </span>
                )}
                {v.simDone && (
                  <span style={css(`font-size:13px;color:var(--color-text-2)`)}>shadow run complete · no side effects</span>
                )}
              </div>
            </div>

            <div style={css(`flex:1;min-height:0;display:grid;grid-template-columns:340px 1fr 280px;border-top:1px solid var(--color-border)`)}>
              <div style={css(`border-right:1px solid var(--color-border);background:var(--color-panel-2);overflow:auto;padding:12px`)}>
                {v.actions.map((a, i) => (
                  <div key={i} className="hv0" onClick={a.select}
                    style={css(`cursor:pointer;padding:12px 12px;margin-bottom:6px;border-left:3px solid ${a.vc};border-radius:var(--radius-md);background:${a.cardBg}`)}>
                    <div style={css(`display:flex;justify-content:space-between;align-items:baseline;gap:8px`)}>
                      <span style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:17px;font-weight:600`)}>{a.op}</span>
                      <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${a.vc};white-space:nowrap`)}>{a.verdictLabel}</span>
                    </div>
                    <div style={css(`font-size:13px;line-height:1.5;color:var(--color-text-2);margin-top:2px`)}>{a.summary}</div>
                    <div style={css(`font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${a.classColor};margin-top:4px`)}>{a.reversibility}</div>
                  </div>
                ))}
                <div style={css(`font-size:12px;line-height:1.6;color:var(--color-text-2);border-top:1px solid var(--color-border);padding-top:8px;margin-top:12px`)}>
                  Every mutation proposed in one agent turn. None have run.
                </div>
              </div>

              <div style={css(`overflow:auto;padding:22px 32px`)}>
                <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:16px`)}>
                  <h2 style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.015em;font-size:28px;margin:0`)}>{v.sel.op}</h2>
                  <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${v.sel.vc};border:1px solid ${v.sel.vc};padding:3px 8px;border-radius:var(--radius-md);white-space:nowrap`)}>
                    {v.sel.verdictLabel}
                  </span>
                </div>
                <p style={css(`font-size:15px;line-height:1.7;margin:8px 0 0;max-width:64ch`)}>{v.sel.detail}</p>

                {v.hasRisk && (
                  <div style={css(`margin-top:12px;background:var(--color-accent-100);border-left:3px solid var(--color-accent);border-radius:var(--radius-md);padding:12px 16px;max-width:70ch;animation:ag-in .3s ease both`)}>
                    <div style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:19px;color:var(--color-accent-800)`)}>{v.sel.risk}</div>
                    <p style={css(`font-size:14px;line-height:1.7;margin:4px 0 0;color:var(--color-neutral-800)`)}>{v.sel.alt}</p>
                  </div>
                )}

                {v.simDone && (
                  <div style={css(`margin-top:22px`)}>
                    <div style={S.eyebrow}>State diff — predicted</div>
                    {v.selDiff.map((d, i) => (
                      <div key={i} style={css(`display:grid;grid-template-columns:200px 1fr 1fr;gap:12px;padding:8px 0;border-bottom:1px solid var(--color-border);font-size:14px;animation:ag-in .3s ease both`)}>
                        <span style={css(`color:var(--color-text-2);font-family:var(--font-mono);font-size:12px`)}>{d.field}</span>
                        <span style={css(`color:var(--color-text-2);text-decoration:line-through`)}>{d.before}</span>
                        <span style={css(`color:var(--color-accent-800)`)}>{d.after}</span>
                      </div>
                    ))}
                    <div style={css(`font-size:12px;color:var(--color-text-2);margin-top:8px`)}>{v.sel.blast}</div>
                    <div style={css(`margin-top:11px`)}>
                      <div style={S.eyebrow}>Native requests on {v.adapter.label}</div>
                      {v.sel.native.map((n, i) => (
                        <div key={i} style={css(`font-family:var(--font-mono);font-size:12px;color:var(--color-text-2);padding:5px 0`)}>{n}</div>
                      ))}
                    </div>
                  </div>
                )}
                {v.simNotDone && (
                  <div style={css(`margin-top:22px;border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:32px;text-align:center;font-size:14px;color:var(--color-text-2)`)}>
                    No diff yet. Run the shadow execution to see what would change.
                  </div>
                )}

                <div style={css(`margin-top:22px`)}>
                  <div style={S.eyebrow}>Policy verdict</div>
                  {v.selChecks.map((c, i) => (
                    <div key={i} style={css(`padding:8px 0;border-bottom:1px solid var(--color-border);font-size:14px`)}>
                      <div style={css(`display:flex;justify-content:space-between;align-items:baseline;gap:8px`)}>
                        <span style={css(`color:${c.color}`)}>{c.name}</span>
                        <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${c.color};white-space:nowrap`)}>{c.state}</span>
                      </div>
                      {c.reason && (
                        <div style={css(`font-size:12px;color:var(--color-accent-800);margin-top:2px`)}>{c.reason}</div>
                      )}
                    </div>
                  ))}
                </div>

                <div style={css(`display:flex;gap:8px;margin-top:22px;align-items:center;flex-wrap:wrap`)}>
                  <button className="hvp" onClick={v.approve} style={S.btn}>Approve &amp; execute</button>
                  <button className="hv1" onClick={v.block} style={S.btn2}>Block</button>
                  <span style={css(`font-size:13px;color:var(--color-accent-700)`)}>{v.decisionNote}</span>
                </div>
              </div>

              <div style={css(`border-left:1px solid var(--color-border);background:var(--color-panel-2);padding:22px 16px;overflow:auto`)}>
                <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);margin-bottom:11px`)}>Active policies</div>
                {v.policies.map((p, i) => (
                  <div key={i} onClick={p.toggle} style={css(`cursor:pointer;display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--color-border)`)}>
                    <span style={css(`flex:none;margin-top:4px;width:12px;height:12px;border-radius:2px;border:1px solid ${p.mark};background:${p.fill}`)} />
                    <span>
                      <span style={css(`font-size:13px;line-height:1.45;display:block;color:${p.text}`)}>{p.name}</span>
                      <span style={css(`font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-text-2)`)}>{p.mode}</span>
                    </span>
                  </div>
                ))}
                <p style={css(`font-size:12px;line-height:1.7;color:var(--color-text-2);margin-top:12px`)}>
                  Toggling a policy re-evaluates every queued mutation against the rehearsal already on file. No
                  re-run is needed; only the predicate changed.
                </p>

                <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);margin:22px 0 8px;border-top:1px solid var(--color-border);padding-top:12px`)}>
                  Invariants, if all {v.actions.length} ran
                </div>
                {v.invariants.map((i, k) => (
                  <div key={k} style={css(`padding:5px 0`)}>
                    <div style={css(`display:flex;gap:8px;align-items:baseline`)}>
                      <span style={css(`font-size:13px;color:${i.color};flex:none`)}>{i.mark}</span>
                      <span style={css(`font-family:var(--font-mono);font-size:12px;line-height:1.5;color:${i.color}`)}>{i.expr}</span>
                    </div>
                    {i.detail && <div style={css(`font-size:12px;color:var(--color-accent-800);margin-left:21px`)}>{i.detail}</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---- Live trace -------------------------------------------------- */}
        {v.onTrace && (
          <div style={css(`flex:1;min-height:0;display:flex;flex-direction:column`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;padding:16px 32px 12px`)}>
              <div>
                <span style={S.stepTag}>Step {v.nav.n} of {v.nav.total}</span>
                <h1 style={S.h1}>{v.nav.title}</h1>
                <div style={S.blurb}>{v.nav.blurb}</div>
                <div style={css(`font-size:12px;color:var(--color-text-2);margin-top:6px`)}>
                  {v.buildLabel} on {v.adapter.label} · {v.traceHeadline}
                </div>
              </div>
              <button className="hvp" onClick={v.rollback} style={S.btn}>{v.rollbackLabel}</button>
            </div>
            <div style={css(`flex:1;min-height:0;overflow:auto;border-top:1px solid var(--color-border);padding:16px 32px`)}>
              {v.spans.map((s, i) => (
                <div key={i} style={css(`border-bottom:1px solid var(--color-border)`)}>
                  <div className="hv0" onClick={s.toggle}
                    style={css(`cursor:pointer;display:grid;grid-template-columns:20px 230px 1fr 80px 110px;align-items:center;gap:12px;padding:8px 4px`)}>
                    <span style={css(`font-size:12px;color:var(--color-text-2)`)}>{s.caret}</span>
                    <span style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:16px`)}>{s.name}</span>
                    <span style={css(`height:6px;background:var(--color-neutral-200);border-radius:3px;position:relative;display:block`)}>
                      <span style={css(`position:absolute;top:0;bottom:0;left:${s.left};width:${s.width};background:${s.bar};border-radius:3px`)} />
                    </span>
                    <span style={css(`font-size:13px;text-align:right;color:var(--color-text-2)`)}>{s.ms}</span>
                    <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;text-align:right;color:${s.color}`)}>{s.status}</span>
                  </div>
                  {s.open && (
                    <div style={css(`padding:0 4px 16px 38px;animation:ag-in .25s ease both`)}>
                      {s.native && (
                        <div style={css(`display:flex;gap:12px;align-items:baseline;margin-bottom:8px`)}>
                          <span style={css(`font-family:var(--font-mono);font-size:12px;color:var(--color-accent-700)`)}>{s.native}</span>
                          <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${s.classColor}`)}>{s.cls}</span>
                        </div>
                      )}
                      <div style={css(`display:grid;grid-template-columns:1fr 1fr;gap:16px`)}>
                        <div>
                          <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);margin-bottom:6px`)}>Arguments</div>
                          <pre style={S.pre}>{s.args}</pre>
                        </div>
                        <div>
                          <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);margin-bottom:6px`)}>Result</div>
                          <pre style={S.pre}>{s.result}</pre>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {v.rolledBack && (
                <div style={css(`margin-top:16px;background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:16px;animation:ag-in .3s ease both`)}>
                  <div style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:20px;margin-bottom:4px`)}>
                    Compensating plan — rebuilt from the audit log
                  </div>
                  <p style={css(`font-size:13px;line-height:1.7;color:var(--color-text-2);margin:0 0 11px`)}>
                    {v.sagaUnrecoverable
                      ? `${v.sagaUnrecoverable} of these steps have no inverse on ${v.adapter.label}. Applying the plan is a partial rollback, not a restore — the rest needs manual repair.`
                      : `Every step has an inverse on ${v.adapter.label}. Applying this plan restores the checkpoint exactly.`}
                  </p>
                  <div style={css(`display:grid;grid-template-columns:280px 120px 1fr;gap:12px;padding-bottom:6px;border-bottom:1px solid var(--color-border);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2)`)}>
                    <span>Write</span><span>Reversibility</span><span>Compensating action</span>
                  </div>
                  {v.saga.map((g, i) => (
                    <div key={i} style={css(`display:grid;grid-template-columns:280px 120px 1fr;gap:12px;padding:8px 0;border-bottom:1px solid var(--color-border);font-size:13px;align-items:baseline`)}>
                      <span style={css(`color:${g.color};font-family:var(--font-mono);font-size:12px`)}>{g.step}</span>
                      <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${g.color}`)}>{g.state}</span>
                      <span style={css(`color:var(--color-text-2);line-height:1.5`)}>{g.undo}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---- Failure lab ------------------------------------------------- */}
        {v.onChaos && (
          <div style={css(`flex:1;min-height:0;display:flex;flex-direction:column`)}>
            <div style={css(`padding:16px 32px 12px`)}>
              <span style={S.stepTag}>Step {v.nav.n} of {v.nav.total}</span>
              <h1 style={S.h1}>{v.nav.title}</h1>
              <div style={S.blurb}>{v.nav.blurb}</div>
            </div>
            <div style={css(`flex:1;min-height:0;display:grid;grid-template-columns:320px 1fr;border-top:1px solid var(--color-border)`)}>
            <div style={css(`border-right:1px solid var(--color-border);padding:22px 16px;overflow:auto;display:flex;flex-direction:column;gap:16px`)}>
              <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2)`)}>Inject failure</div>

              <label style={css(`display:flex;flex-direction:column;gap:4px`)}>
                <span style={S.lab}>Recorded run</span>
                <select value={v.caseId} onChange={v.setCase} style={S.sel}>
                  {v.allCases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>

              <label style={css(`display:flex;flex-direction:column;gap:4px`)}>
                <span style={S.lab}>Fault</span>
                <select value={v.fault} onChange={v.setFault} style={S.sel}>
                  {v.faults.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}{f.transient ? '' : ' — permanent'}</option>
                  ))}
                </select>
              </label>

              <label style={css(`display:flex;flex-direction:column;gap:4px`)}>
                <span style={S.lab}>At operation</span>
                <select value={v.op} onChange={v.setOp} style={S.sel}>
                  {v.points.map((p) => <option key={p.op} value={p.op}>{p.label}</option>)}
                </select>
              </label>

              <div style={css(`display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--color-border);padding-top:12px`)}>
                {v.modifiers.map((m, i) => (
                  <div key={i} onClick={m.toggle} style={css(`cursor:pointer;display:flex;gap:8px;align-items:flex-start`)}>
                    <span style={css(`flex:none;margin-top:3px;width:12px;height:12px;border-radius:2px;border:1px solid ${m.mark};background:${m.fill}`)} />
                    <span style={css(`font-size:13px;line-height:1.45;color:${m.text}`)}>{m.label}</span>
                  </div>
                ))}
              </div>

              <button className="hvp" onClick={v.inject} style={S.btn}>{v.injectLabel}</button>
              <div style={css(`font-size:12px;line-height:1.7;color:var(--color-text-2);border-top:1px solid var(--color-border);padding-top:11px`)}>
                Runs against a shadow account only. No production CRM is touched.
              </div>
            </div>

            <div style={css(`padding:22px 32px;overflow:auto`)}>
              <div style={S.eyebrow}>The experiment</div>
              <p style={css(`font-size:15px;line-height:1.7;max-width:70ch;margin:0`)}>{v.experimentLine}</p>

              {v.chaosDone && (
                <div style={css(`margin-top:22px;border:1px solid ${v.verdict.border};border-radius:var(--radius-md);padding:16px;animation:ag-in .3s ease both`)}>
                  <div style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:24px;color:${v.verdict.color}`)}>{v.verdict.headline}</div>
                  <div style={css(`display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:12px`)}>
                    {v.verdict.checks.map((c, i) => (
                      <div key={i} style={css(`border-top:1px solid var(--color-border);padding-top:8px`)}>
                        <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2)`)}>{c.label}</div>
                        <div style={css(`font-size:15px;font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;color:${c.color};margin-top:3px`)}>{c.value}</div>
                        <div style={css(`font-size:12px;line-height:1.5;color:var(--color-text-2);margin-top:2px`)}>{c.note}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {v.chaosDone && v.proposal && (
                <div style={css(`margin-top:16px;border:1px solid var(--color-border);border-left:3px solid var(--color-accent);border-radius:var(--radius-md);padding:12px 16px;animation:ag-in .3s ease both`)}>
                  <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap`)}>
                    <span style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:19px`)}>
                      {v.proposal.novel ? 'This failure is not in the suite' : `Already covered by ${v.proposal.covered}`}
                    </span>
                    <button className="hv1" onClick={v.toggleSource} style={css(`font-family:var(--font-ui);font-size:13px;font-weight:500;padding:5px 12px;border:1px solid var(--color-border);color:var(--color-text);background:var(--color-panel);border-radius:var(--radius-md);cursor:pointer`)}>
                      {v.showSource ? 'Hide case' : 'Show generated case'}
                    </button>
                  </div>
                  <p style={css(`font-size:13px;line-height:1.7;color:var(--color-neutral-800);margin:4px 0 0`)}>
                    {v.proposal.why}. Minimised to {v.proposal.reduction.kept} of {v.proposal.reduction.from} records,
                    the smallest account that still reproduces it.
                  </p>
                  {v.showSource && <pre style={css(`margin:11px 0 0;font-family:var(--font-mono);font-size:12px;line-height:1.6;background:var(--color-neutral-100);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:11px;max-height:320px;overflow:auto;color:var(--color-neutral-800)`)}>{v.proposal.source}</pre>}
                </div>
              )}

              <div style={css(`margin-top:22px;border-top:1px solid var(--color-border)`)}>
                {v.chaosLog.map((l, i) => (
                  <div key={i} style={css(`display:grid;grid-template-columns:70px 1fr;gap:16px;padding:7px 0;border-bottom:1px solid var(--color-border);animation:ag-in .3s ease both`)}>
                    <span style={css(`font-size:13px;color:var(--color-text-2)`)}>{l.t}</span>
                    <span style={css(`font-size:14px;line-height:1.5;color:${l.color}`)}>{l.text}</span>
                  </div>
                ))}
              </div>

              {v.chaosIdle && (
                <div style={css(`margin-top:16px;border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:32px;text-align:center;font-size:14px;color:var(--color-text-2)`)}>
                  Pick a fault and inject it to see the recovery path.
                </div>
              )}
            </div>
            </div>
          </div>
        )}

        {/* ---- Evals ------------------------------------------------------- */}
        {v.onEvals && (
          <div style={css(`flex:1;min-height:0;overflow:auto;padding:22px 32px`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;gap:16px`)}>
              <div>
                <span style={S.stepTag}>Step {v.nav.n} of {v.nav.total}</span>
                <h1 style={S.h1}>{v.nav.title}</h1>
                <div style={S.blurb}>{v.nav.blurb}</div>
                <div style={css(`font-size:12px;color:var(--color-text-2);margin-top:6px`)}>
                  {v.cases.length} recorded cases replayed on {v.adapter.label}
                </div>
              </div>
              <span style={css(`font-size:13px;color:${v.gate.color};background:var(--color-panel);border:1px solid var(--color-border);padding:6px 12px;border-radius:var(--radius-md);white-space:nowrap`)}>
                {v.gate.badge}
              </span>
            </div>

            <div style={css(`display:grid;grid-template-columns:repeat(5,1fr);gap:0;margin-top:22px;border-top:1px solid var(--color-text)`)}>
              {v.metrics.map((m, i) => (
                <div key={i} style={css(`padding:12px 12px 12px 0;border-right:1px solid var(--color-border)`)}>
                  <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2)`)}>{m.label}</div>
                  <div style={css(`display:flex;align-items:baseline;gap:6px;margin-top:6px`)}>
                    <span style={css(`font-size:14px;color:var(--color-neutral-500);text-decoration:line-through`)}>{m.old}</span>
                    <span style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:21px;color:${m.color}`)}>{m.cand}</span>
                    <span style={css(`font-size:13px;color:var(--color-accent-800)`)}>{m.mark}</span>
                  </div>
                </div>
              ))}
            </div>
            <p style={css(`font-size:13px;line-height:1.6;color:var(--color-text-2);margin:8px 0 0`)}>
              v1.8 struck through, v1.9 in front. The candidate completes more runs because it no longer abandons them
              at the first hard failure. That same change is why it gets more of them wrong.
            </p>

            <table style={css(`width:100%;border-collapse:collapse;margin-top:22px;font-size:13.5px`)}>
              <thead><tr>
                <th style={S.th}>Recorded case</th>
                <th style={S.th}>Injected fault</th>
                <th style={css(`text-align:right;padding:8px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:15px`)}>v1.8</th>
                <th style={css(`text-align:right;padding:8px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:15px`)}>v1.9</th>
                <th style={css(`text-align:right;padding:8px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:15px`)}>Δ latency</th>
                <th style={S.th}></th>
              </tr></thead>
              <tbody>
                {v.cases.map((c, i) => (
                  <tr key={i} onClick={c.open} style={css(`cursor:pointer;background:${c.bg}`)}>
                    <td style={S.td}>{c.caret} {c.name}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-border);color:var(--color-text-2);font-size:13px`)}>{c.fault}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-border);text-align:right;color:var(--color-text-2)`)}>{c.base}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-border);text-align:right;color:${c.color}`)}>{c.cand}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-border);text-align:right;color:var(--color-text-2)`)}>{c.delta}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-border);font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:${c.tagColor}`)}>{c.tag}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {v.portability.length > 0 && (
              <div style={css(`margin-top:16px;border-left:3px solid var(--color-accent);padding:11px 16px;background:var(--color-accent-100);border-radius:var(--radius-md)`)}>
                <div style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:18px`)}>A CRM failure, not a build regression</div>
                {v.portability.map((p, i) => (
                  <p key={i} style={css(`font-size:13px;line-height:1.7;color:var(--color-neutral-800);margin:4px 0 0`)}>
                    “{p.name}” fails on {v.adapter.label} for both builds, at {p.field}. Promoting or blocking v1.9
                    changes nothing here; the pipeline mapping does.
                  </p>
                ))}
              </div>
            )}

            {v.compareOpen && (
              <div style={css(`margin-top:24px;border-top:1px solid var(--color-text);padding-top:16px;animation:ag-in .3s ease both`)}>
                <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:16px`)}>
                  <h2 style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.015em;font-size:26px;margin:0`)}>{v.compare.name}</h2>
                  <span style={css(`font-size:13px;color:var(--color-text-2)`)}>{v.compare.summary}</span>
                </div>
                <p style={css(`font-size:14px;line-height:1.7;color:var(--color-text-2);margin:4px 0 0;max-width:80ch`)}>{v.compare.note}</p>

                <div style={css(`display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:12px`)}>
                  {[['v1.8 — current', v.compare.left, 'var(--color-text-2)'], ['v1.9 — candidate', v.compare.right, 'var(--color-accent-700)']].map(([title, rows, tint], k) => (
                    <div key={k}>
                      <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${tint};border-bottom:1px solid var(--color-border);padding-bottom:6px`)}>{title}</div>
                      {rows.map((r, i) => (
                        <div key={i} style={css(`display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--color-border);color:${r.color}`)}>
                          <span style={css(`font-family:var(--font-mono);font-size:12px`)}>{r.step}</span>
                          <span style={css(`color:var(--color-text-2)`)}>{r.meta}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {v.compare.misses.length > 0 && (
                  <div style={css(`margin-top:12px`)}>
                    <div style={S.eyebrow}>Where the account ended up wrong</div>
                    {v.compare.misses.map((m, i) => (
                      <div key={i} style={css(`display:grid;grid-template-columns:240px 1fr 1fr;gap:12px;padding:7px 0;border-bottom:1px solid var(--color-border);font-size:13px`)}>
                        <span style={css(`font-family:var(--font-mono);font-size:12px;color:var(--color-text-2)`)}>{m.field}</span>
                        <span style={css(`color:var(--color-accent-800)`)}>got {m.got}</span>
                        <span style={css(`color:var(--color-text-2)`)}>want {m.want}</span>
                      </div>
                    ))}
                  </div>
                )}

                <p style={css(`font-size:14px;line-height:1.7;color:var(--color-accent-800);margin:12px 0 0;max-width:82ch`)}>{v.compare.verdict}</p>
              </div>
            )}

            <div style={css(`margin-top:24px`)}>
              <div style={S.eyebrow}>Generated regression tests</div>
              <p style={css(`font-size:14px;line-height:1.7;color:var(--color-text-2);margin:8px 0 0;max-width:80ch`)}>
                {v.proposals.length} failures analysed and minimised into candidate cases. {v.novel === 0
                  ? 'None need a new case; the suite already pins every one.'
                  : `${v.novel} are not pinned by any existing case.`} Break something new in the failure lab and a
                proposal for it appears there.
              </p>
              {v.proposals.slice(0, 4).map((p, i) => (
                <div key={i} style={css(`display:grid;grid-template-columns:100px 1fr 150px;gap:12px;padding:8px 0;border-bottom:1px solid var(--color-border);font-size:13px;align-items:baseline`)}>
                  <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${p.novel ? 'var(--color-accent-800)' : 'var(--color-text-2)'}`)}>
                    {p.novel ? 'new case' : `covered · ${p.covered}`}
                  </span>
                  <span style={css(`color:var(--color-neutral-800);line-height:1.5`)}>{p.why}</span>
                  <span style={css(`color:var(--color-text-2);text-align:right`)}>{p.reduction.kept} of {p.reduction.from} records</span>
                </div>
              ))}
            </div>

            <div style={css(`margin-top:24px;background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:16px`)}>
              <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap`)}>
                <span style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.012em;font-size:22px`)}>Deployment gate — agent {v.score.candidateLabel}</span>
                <span style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${v.gate.color}`)}>operator decision: {v.gate.status}</span>
              </div>

              {/* The gate itself is not a judgement call — it is the conjunction
                  of the thresholds below, recomputed from the suite. */}
              <div style={css(`display:grid;grid-template-columns:1fr 220px;gap:24px;margin-top:16px;align-items:start`)}>
                <div>
                  {v.score.candidate.rows.map((r, i) => (
                    <div key={i} style={css(`display:grid;grid-template-columns:1fr 90px 110px 20px;gap:11px;align-items:baseline;padding:7px 0;font-size:14px`)}>
                      <span style={css(`color:${r.critical ? 'var(--color-text)' : 'var(--color-text-2)'}`)}>
                        {r.label}{r.critical && <span style={css(`color:var(--color-text-2);font-size:12px`)}> · critical</span>}
                      </span>
                      <span style={css(`font-family:var(--font-mono);font-size:13px;text-align:right;color:${r.ok ? 'var(--color-text)' : 'var(--color-fail)'}`)}>{r.value}</span>
                      <span style={css(`font-family:var(--font-mono);font-size:13px;color:var(--color-text-2)`)}>{r.direction} {r.bar}</span>
                      <span style={css(`text-align:right;color:${r.ok ? 'var(--color-pass)' : 'var(--color-fail)'}`)}>{r.ok ? '✓' : '✕'}</span>
                    </div>
                  ))}
                </div>

                <div style={css(`background:var(--color-panel-2);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:16px;text-align:center`)}>
                  <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2)`)}>AgentGuard score</div>
                  <div style={css(`font-size:44px;line-height:1.1;margin-top:6px;color:${v.score.candidate.verdict === 'pass' ? 'var(--color-pass)' : 'var(--color-fail)'}`)}>
                    {v.score.candidate.score}
                  </div>
                  <div style={css(`font-size:13px;color:var(--color-text-2)`)}>out of 100</div>
                  <div style={css(`margin-top:11px;padding-top:11px;border-top:1px solid var(--color-border);font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:${v.score.candidate.verdict === 'pass' ? 'var(--color-pass)' : 'var(--color-fail)'}`)}>
                    {v.score.candidate.verdict === 'pass' ? 'ready for production' : 'blocked'}
                  </div>
                  <div style={css(`margin-top:8px;font-size:12px;color:var(--color-text-2)`)}>
                    {v.score.baselineLabel} scores {v.score.baseline.score}
                  </div>
                </div>
              </div>

              <p style={css(`font-size:13.5px;line-height:1.7;margin:12px 0 0;max-width:82ch;color:var(--color-text-2)`)}>
                {v.score.candidate.failed.length === 0
                  ? `Every threshold cleared. ${v.score.candidateLabel} is eligible for promotion.`
                  : `${v.score.candidate.failed.length} of ${v.score.candidate.rows.length} thresholds missed` +
                    (v.score.candidate.criticalFailures ? `, ${v.score.candidate.criticalFailures} of them critical` : '') +
                    `. ${v.score.baselineLabel} does not clear this bar either — it scores ${v.score.baseline.score} — so the gate separates the two builds by margin rather than by pass and fail.`}
              </p>
              <p style={css(`font-size:13.5px;line-height:1.75;max-width:82ch;margin:8px 0 0;color:var(--color-neutral-800)`)}>{v.gate.note}</p>
              <div style={css(`font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);margin-top:16px`)}>Operator override</div>
              <div style={css(`display:flex;gap:8px;margin-top:8px;flex-wrap:wrap`)}>
                {v.gate.actions.map((g, i) => (
                  <button key={i} className="hv0" onClick={g.go}
                    style={css(`font-family:var(--font-ui);font-size:14px;padding:8px 22px;border:1px solid ${g.border};color:${g.color};background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <p style={css(`font-size:13.5px;line-height:1.8;max-width:82ch;margin-top:22px;color:var(--color-neutral-800)`)}>
              Three changes in v1.9 account for the regressions. It writes straight from the search result instead of
              re-reading first, so an edit a rep made in between gets overwritten. It dropped the merge bar from 0.95
              to 0.90 to catch more duplicates, and records scoring in that band are mostly sparse ones that score high
              only because they have few fields to disagree on. And it retries every error rather than only transient
              ones, so a 403 is retried three times and then written past. {v.gate.outlook}
            </p>
          </div>
        )}

        {/* One fixed place that answers "where am I and what now", so the
            reader never has to work the flow out from the tab bar. */}
        <footer style={css(`flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 20px;background:var(--color-panel);border-top:1px solid var(--color-border)`)}>
          <div style={css(`flex:none;width:180px`)}>
            {v.nav.prev && (
              <button className="hv1" onClick={v.nav.prev.go}
                style={css(`font-family:var(--font-ui);font-size:13px;font-weight:500;padding:6px 12px;border:1px solid var(--color-border);color:var(--color-text);background:var(--color-panel);border-radius:var(--radius-md);cursor:pointer`)}>
                ← {v.nav.prev.label}
              </button>
            )}
          </div>

          {/* The dots are the whole flow at a glance — five screens, this one
              filled, and each one reachable directly. */}
          <div style={css(`display:flex;align-items:center;gap:8px`)}>
            {v.tabs.map((t, i) => (
              <button key={i} onClick={t.go} title={`${t.n}. ${t.label}`} aria-label={`Go to step ${t.n}: ${t.label}`}
                style={css(`width:8px;height:8px;padding:0;border-radius:50%;cursor:pointer;border:1px solid ${t.active ? 'var(--color-accent)' : 'var(--color-neutral-400)'};background:${t.active ? 'var(--color-accent)' : 'transparent'}`)} />
            ))}
            <span style={css(`font-size:12px;color:var(--color-text-2);margin-left:4px;white-space:nowrap`)}>
              Step {v.nav.n} of {v.nav.total} — {v.nav.title}
            </span>
          </div>

          <div style={css(`flex:none;width:180px;display:flex;justify-content:flex-end`)}>
            {v.nav.next && (
              <button className="hvp" onClick={v.nav.next.go}
                style={css(`font-family:var(--font-ui);font-size:13px;font-weight:500;padding:6px 14px;border:1px solid var(--color-accent);color:#fff;background:var(--color-accent);border-radius:var(--radius-md);cursor:pointer;white-space:nowrap`)}>
                {v.nav.next.cta || v.nav.next.label} →
              </button>
            )}
          </div>
        </footer>
      </div>
    );
  }
}
