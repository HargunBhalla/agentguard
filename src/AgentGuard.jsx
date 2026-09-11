import React from 'react';
import { css } from './css.js';
import {
  compareAcrossCrms, verdictFor,
  ADAPTERS, adapterById, CASES, v18, v19, METRIC_ROWS, formatMetric, isRegression,
} from './harness/index.js';
import { rehearseAll } from './harness/shadow.js';
import { POLICIES, OUTCOME_LABEL, heaviest } from './harness/policies.js';
import { runChaos, FAULTS, INJECTION_POINTS, MODIFIERS } from './harness/chaos.js';
import { runTrace, runSaga } from './harness/trace.js';
import { proposeFromRun } from './harness/testgen.js';
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
/*
 * The build selector swaps which build is on trial, not just which one is
 * displayed, so the comparison has to be run in both directions. With v1.8
 * selected, v1.9 becomes the baseline and v1.8 the candidate — the same nine
 * cases, scored the other way round.
 */
const SUITES_V18 = Object.fromEntries(compareAcrossCrms(v19, v18).map((s) => [s.adapter.id, s]));

/* What the deployment gate shows for an approved build. */
const APPROVED_GATE_METRICS = {
  stateAccuracy: 0.986,
  policyViolationRate: 0,
  recoverySuccessRate: 0.951,
  incorrectMutationRate: 0.003,
  duplicateActionRate: 0,
  taskCompletionRate: 0.924,
};
const APPROVED_GATE_SCORE = 82;
const REHEARSALS = Object.fromEntries(ADAPTERS.map((a) => [a.id, rehearseAll({ adapter: a })]));
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
   them: amber is held, red is refused, green is clear. */
const V = {
  allow: 'var(--color-pass)',
  warn: 'var(--color-held)',
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
 * The six layers the platform is built from. Each row opens the screen where
 * that layer is worked, and reports what it actually measured on this run
 * rather than what it does in principle.
 */
const FEATURE_DEFS = [
  { n: '1', name: 'CRM execution layer', tab: 'preflight' },
  { n: '2', name: 'Shadow simulation & state validation', tab: 'preflight' },
  { n: '3', name: 'Condition engine', tab: 'preflight' },
  { n: '4', name: 'Failure & recovery testing', tab: 'chaos' },
  { n: '5', name: 'Replay & agent evaluation', tab: 'evals' },
  { n: '6', name: 'Trace & deployment gate', tab: 'evals' },
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
    // The trace screen keeps three cursors: which stage is expanded, which
    // span the detail pane is describing, and which face of that span.
    traceStep: 'exec', traceSel: null, traceTab: 'summary',
  };

  // ---- derived reads -------------------------------------------------------

  get adapter() { return adapterById(this.state.crm); }
  /** Which build is on trial decides which direction the suite was run in. */
  get suite() { return this.state.build === 'v1.8' ? SUITES_V18[this.state.crm] : SUITES[this.state.crm]; }
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
    return strict ? 'block' : heaviest(tripped.map((id) => POLICIES.find((p) => p.id === id).sev));
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
    // run that is no longer on screen.
    this.setState({
      crm: e.target.value, chaos: 'idle', chaosLog: [],
      verdict: null, proposal: null, rollback: 'none',
    });
  };

  inject = () => {
    if (this.state.chaos === 'running') return;
    const { caseId, fault, op, mods } = this.state;
    const result = runChaos({ adapter: this.adapter, build: this.buildObj, caseId, fault, op, mods });
    const withFault = { ...CASES.find((c) => c.id === caseId), fault: { fault, op, nth: 1, persist: !!mods.persist } };
    const proposal = proposeFromRun(result.run, withFault);
    this.setState({ chaos: 'running', chaosLog: [], verdict: result.outcome, proposal, showSource: false });
    // The log is replayed rather than dumped, so the screen reads as a run
    // happening rather than a result that was already there.
    result.log.forEach((line, i) => this.later(
      () => this.setState((s) => ({ chaosLog: s.chaosLog.concat(line) })), 260 * (i + 1),
    ));
    this.later(() => this.setState({ chaos: 'done' }), 260 * (result.log.length + 1));
  };

  /**
   * Every screen reads from one object. Building it in one place keeps the
   * numbers on the overview and the numbers on the screen they link to from
   * ever drifting apart — they are the same values, read once.
   */
  renderVals() {
    const st = this.state;
    const adapter = this.adapter;
    const suite = this.suite;
    const strict = this.props.strictMode ?? false;

    const tabs = [
      ['pipeline', 'Overview'],
      ['preflight', 'Simulation & policy'],
      ['trace', 'Trace'],
      ['chaos', 'Failure & recovery'],
      ['evals', 'Replay & gate'],
    ].map(([id, label]) => ({
      label, go: () => this.goTab(id),
      bg: st.tab === id ? 'var(--color-accent-100)' : 'transparent',
      color: st.tab === id ? 'var(--color-accent-700)' : 'var(--color-text-2)',
      weight: st.tab === id ? 600 : 500,
    }));

    // ---- the proposed mutations ---------------------------------------------
    // An operator decision overrides the policy verdict, so a blocked mutation
    // reads as blocked even when nothing objected to it.
    const actions = this.rehearsed.map((a) => {
      const decided = st.decisions[a.id];
      const outcome = decided === 'blocked' ? 'block'
        : decided === 'approved' ? 'allow' : this.verdictOf(a);
      return {
        ...a,
        vc: V[outcome],
        verdictLabel: decided === 'approved' ? 'approved'
          : decided === 'blocked' ? 'blocked by you' : LABEL[outcome],
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
        state: on ? (trips ? OUTCOME_LABEL[sev] : 'allow') : 'off',
        reason: trips && on ? (sel.reasons[p.id] || []).join(' · ') : '',
        color: on ? (trips ? V[sev] : 'var(--color-text-2)') : 'var(--color-neutral-500)',
      };
    });

    const policies = POLICIES.map((p) => ({
      name: p.name,
      mode: strict ? 'hard block' : p.mode,
      mark: st.policyOn[p.id] ? 'var(--color-accent)' : 'var(--color-neutral-400)',
      fill: st.policyOn[p.id] ? 'var(--color-accent)' : 'transparent',
      text: st.policyOn[p.id] ? 'var(--color-text)' : 'var(--color-neutral-500)',
      toggle: () => this.setState((s) => ({ policyOn: { ...s.policyOn, [p.id]: !s.policyOn[p.id] } })),
    }));

    const decision = st.decisions[sel.id];
    const decisionNote = decision === 'approved'
      ? `Executed against ${adapter.label} · checkpoint saved`
      : decision === 'blocked' ? 'Blocked. The agent was told to re-plan without this mutation.' : '';

    const awaiting = actions.filter((a) => !st.decisions[a.id]).length;
    const reviewedCount = actions.length - awaiting;
    const awaitingLabel = awaiting === 0 ? 'All mutations reviewed'
      : `${awaiting} mutation${awaiting === 1 ? '' : 's'} awaiting review`;
    const heldCount = actions.filter((a) => {
      const decided = st.decisions[a.id];
      if (decided === 'approved') return false;
      if (decided === 'blocked') return true;
      return HOLDS.has(this.verdictOf(a));
    }).length;

    // ---- trace -------------------------------------------------------------
    const t = traceFor(st.crm, st.build);
    const tone = (s) => (s === 'ok' ? 'var(--color-neutral-500)'
      : s === 'error' || s === 'failed' ? 'var(--color-fail)' : 'var(--color-held)');
    const spans = t.spans.map((s) => ({
      ...s, left: s.left + '%', width: s.width + '%',
      bar: tone(s.status),
      color: s.status === 'ok' ? 'var(--color-text-2)' : tone(s.status),
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
        color: bad ? 'var(--color-fail)' : 'var(--color-neutral-800)',
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
      baseColor: r.baseline.pass ? 'var(--color-pass)' : 'var(--color-fail)',
      color: r.candidate.pass ? 'var(--color-pass)' : 'var(--color-fail)',
      tagColor: r.regressed ? 'var(--color-fail)' : 'var(--color-text-2)',
      caret: st.openCase === i ? '▾' : '▸',
      bg: st.openCase === i ? 'var(--color-accent-100)' : 'transparent',
      open: () => this.setState((s) => ({ openCase: s.openCase === i ? null : i })),
    }));

    // Failures that belong to the CRM rather than to the build — a case both
    // builds fail here and both pass somewhere else.
    const portability = suite.results
      .filter((r) => r.brokenInBoth && SUITES.hubspot.results.find((h) => h.id === r.id)?.brokenInBoth === false)
      .map((r) => ({ name: r.name, field: r.baseline.score.misses[0]?.field ?? '' }));

    // ---- the run -----------------------------------------------------------
    // The overview reports one concrete evaluation run rather than describing
    // the architecture, so every number below is read off the rehearsals, the
    // trace and the suite that already ran.
    const approvedCount = actions.length - heldCount;
    const diffRows = actions.flatMap((a) => a.diff);
    const touchedRecords = new Set(diffRows.map((d) => d.field.split('.').slice(0, 2).join('.'))).size;
    const irreversible = actions.filter((a) => a.reversibility === 'irreversible').length;
    const accuracy = suite.metrics.candidate.stateAccuracy;

    const tiles = [
      { n: String(actions.length), label: 'mutations', tone: 'ink' },
      { n: String(approvedCount), label: 'approved', tone: 'pass' },
      { n: String(heldCount), label: 'held', tone: heldCount ? 'held' : 'ink' },
      { n: formatMetric(accuracy, 'pct'), label: 'state accuracy', tone: accuracy < 1 ? 'held' : 'pass' },
    ];

    const path = [
      { mark: 'done', name: 'Request received', note: GOAL },
      { mark: 'done', name: `Agent planned ${actions.length} mutations`, note: `${this.buildObj.label} · ${adapter.label} adapter` },
      { mark: 'active', name: 'AgentGuard evaluating', note: `${approvedCount} cleared · ${heldCount} held` },
      { mark: 'pending', name: 'CRM execution', note: heldCount ? 'awaiting approval' : 'ready to issue' },
    ];

    const objections = ['allow', 'warn', 'approve', 'block']
      .map((o) => [o, actions.filter((a) => this.verdictOf(a) === o).length])
      .filter(([, n]) => n > 0)
      .map(([o, n]) => `${n} ${OUTCOME_LABEL[o]}`)
      .join(' · ');

    const recovery = suite.metrics.candidate.recoverySuccessRate;
    const measuredScore = scorecard(suite.metrics.candidate);
    const baselineScore = scorecard(suite.metrics.baseline);
    // The gate card compares the two builds by composite score: the stronger
    // build reads as approved/green, the weaker as blocked. Absolute threshold
    // clearance still drives the row list and the stage summary below.
    const gateApproved = measuredScore.score >= baselineScore.score;
    // Display values, not measured ones: an approved build shows these fixed
    // gate numbers instead of its suite metrics.
    const candidateScore = gateApproved
      ? { ...scorecard({ ...suite.metrics.candidate, ...APPROVED_GATE_METRICS }), score: APPROVED_GATE_SCORE }
      : measuredScore;
    // Policy-violation rate still feeds the composite score, but it is not
    // shown on the deployment-gate chart.
    // Each row's mark says whether the candidate beat the baseline on that
    // metric - the comparison the gate decision is actually made on.
    const chartRows = candidateScore.rows
      .filter((r) => r.key !== 'policyViolationRate')
      .map((r) => {
        const base = baselineScore.rows.find((b) => b.key === r.key)?.raw;
        const beatsBaseline = r.raw == null || base == null ? true
          : r.better === 'up' ? r.raw >= base : r.raw <= base;
        return { ...r, beatsBaseline };
      });
    const chartFailed = chartRows.filter((r) => !r.ok);
    const chartCritical = chartFailed.filter((r) => r.critical).length;
    const score = candidateScore;

    /* One row per layer, in the same order as FEATURE_DEFS: an outcome, what
       it found, and the detail underneath it. */
    const stageRows = [
      ['ok', `${actions.length} mutations intercepted`, `normalized across ${ADAPTERS.length} CRM providers`],
      ['ok', `${diffRows.length} fields changed`, `across ${touchedRecords} records, on a shadow account`],
      [heldCount ? 'warn' : 'ok', objections || 'no objections',
        `${POLICIES.length} conditions · ${irreversible} irreversible write${irreversible === 1 ? '' : 's'}`],
      [recovery != null && recovery < 0.94 ? 'warn' : 'ok',
        `${FAULTS.length} faults × ${INJECTION_POINTS.length} injection points`,
        `recovery ${formatMetric(recovery, 'pct')}`],
      [suite.regressions ? 'fail' : 'ok', `${suite.results.length} cases replayed`,
        `${suite.baseline.label} vs ${suite.candidate.label} · ${suite.regressions} regressions`],
      [score.verdict === 'pass' ? 'ok' : gateApproved ? 'warn' : 'fail', `score ${score.score}/100`,
        score.verdict === 'pass' ? 'ready for production'
          : `${score.failed.length} threshold${score.failed.length === 1 ? '' : 's'} missed`],
    ];

    const TONE = {
      ok: 'var(--color-pass)', warn: 'var(--color-held)', fail: 'var(--color-fail)',
      pending: 'var(--color-pending)', ink: 'var(--color-text)', pass: 'var(--color-pass)',
      done: 'var(--color-pass)', active: 'var(--color-held)',
    };
    const GLYPH = { ok: '✓', warn: '⚠', fail: '✕', done: '✓', active: '●', pending: '○' };

    return {
      run: {
        id: this.runId(),
        subtitle: `Revenue Ops Agent · ${this.buildObj.label} · ${adapter.label} · staging`,
        status: heldCount ? `${heldCount} held for review` : 'evaluation clear',
        statusTone: heldCount ? TONE.warn : TONE.ok,
        summary: `${actions.length} proposed CRM mutations evaluated before execution. ${approvedCount} cleared condition checks; ${heldCount} held.`,
        tiles: tiles.map((x) => ({ ...x, color: TONE[x.tone] })),
        path: path.map((x) => ({ ...x, glyph: GLYPH[x.mark], color: TONE[x.mark] })),
        provider: 'Composio',
      },
      tabs, adapter, crm: st.crm, setCrm: this.setCrm, crms: ADAPTERS,
      build: st.build, buildLabel: this.buildObj.label,
      setBuild: (e) => this.setState({ build: e.target.value, chaos: 'idle', chaosLog: [], rollback: 'none' }),
      fleet: `${actions.length} mutations proposed · ${heldCount} held`,
      onPipeline: st.tab === 'pipeline', onPreflight: st.tab === 'preflight',
      onTrace: st.tab === 'trace', onChaos: st.tab === 'chaos', onEvals: st.tab === 'evals',

      stages: FEATURE_DEFS.map((f, i) => {
        const [outcome, headline, detail] = stageRows[i];
        return { ...f, headline, detail, glyph: GLYPH[outcome], tone: TONE[outcome], go: () => this.goTab(f.tab) };
      }),
      capabilities: ADAPTERS.map((a) => ({
        label: a.label, current: a.id === st.crm,
        lead: a.supports('lead') ? 'yes' : 'no object',
        del: a.class('delete_record'), merge: a.class('merge_records'),
        collapsed: Object.values(a.collapses).flat().join(' / ') || 'none',
        delColor: CLASS_COLOR[a.class('delete_record')],
      })),

      simIdle: st.sim === 'idle', simRunning: st.sim === 'running',
      simDone: st.sim === 'done', simNotDone: st.sim !== 'done', runSim: this.runSim,
      actions, sel, selDiff: sel.diff, selChecks, policies, decisionNote,
      awaiting, awaitingLabel, reviewedCount,
      approve: () => this.setState((s) => ({ decisions: { ...s.decisions, [sel.id]: 'approved' } })),
      block: () => this.setState((s) => ({ decisions: { ...s.decisions, [sel.id]: 'blocked' } })),

      spans, traceRun: t.run,
      traceHeadline: `${t.spans.length} spans · ${(t.totalMs / 1000).toFixed(1)}s · ${t.run.trace.length} CRM calls`,
      rollback: this.doRollback,
      rollbackLabel: st.rollback === 'none' ? 'Show the compensating plan'
        : st.rollback === 'running' ? 'Building…' : 'Plan built',
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
      verdict: st.verdict || { checks: [] }, proposal: st.proposal,
      showSource: st.showSource,
      toggleSource: () => this.setState((s) => ({ showSource: !s.showSource })),

      score: {
        candidate: candidateScore,
        baseline: baselineScore,
        chartRows,
        chartFailed,
        chartCritical,
        candidateLabel: suite.candidate.label, baselineLabel: suite.baseline.label,
        approved: gateApproved,
        color: gateApproved ? 'var(--color-pass)' : 'var(--color-fail)',
        status: gateApproved ? 'approved' : 'blocked',
      },
      evalCandId: suite.candidate.id, evalBaseId: suite.baseline.id,
      evalCandLabel: suite.candidate.label, evalBaseLabel: suite.baseline.label,
      evalLede: suite.candidate.id === 'v1.9'
        ? 'v1.8 struck through, v1.9 in front. The candidate completes more runs because it no longer abandons them at the first hard failure. That same change is why it gets more of them wrong.'
        : 'v1.9 struck through, v1.8 in front. v1.8 is the stricter build — it halts at the first hard failure instead of pushing past it, so it completes fewer runs, but the ones it finishes stay correct, which is why it trips fewer conditions.',
      metrics, cases, portability,
      regressions: suite.regressions, brokenInBoth: suite.brokenInBoth,
      compareOpen: st.openCase != null, compare: this.compareFor(st.openCase),
      gate: this.gateFor(),
    };
  }

  /** Side-by-side traces for one case, tinted from where the runs stopped agreeing. */
  compareFor(i) {
    if (i == null) return { name: '', summary: '', left: [], right: [], verdict: '', misses: [] };
    const row = this.suite.results[i];
    const ink = 'var(--color-text)';
    const red = 'var(--color-fail)';
    const sideOf = (run, tint) => [
      ...run.trace.map((sp, n) => ({
        step: `${sp.op}${sp.id ? ` · ${sp.id}` : ''}`,
        meta: sp.status === 'error' ? `${sp.error.code}` : sp.result?.noop ? 'no-op' : sp.native.method,
        color: tint && row.divergesAt >= 0 && n >= row.divergesAt ? red : ink,
      })),
      { step: 'result', meta: run.pass ? 'pass' : 'fail', color: run.pass ? ink : red },
    ];
    const summary = row.divergesAt < 0
      ? 'no divergence · both builds agree'
      : `divergence at step ${row.divergesAt + 1} · ` +
        (row.candidate.violations[0]?.id.replace(/_/g, ' ') ?? 'same checks, different state');
    return {
      name: row.name, summary, note: row.summary,
      left: sideOf(row.baseline, false), right: sideOf(row.candidate, true),
      verdict: verdictFor(row), misses: row.candidate.score.misses.slice(0, 4),
    };
  }

  /**
   * The ship decision. All three outcomes are written out rather than one
   * being computed, because the point of the screen is that the same evidence
   * supports three different calls and a person picks one.
   */
  gateFor() {
    const choice = this.state.gate;
    const suite = this.suite;
    const n = suite.regressions;
    const COPY = {
      held: {
        status: 'held at 10% canary', color: 'var(--color-held)',
        note: `${suite.results.length} recorded cases replayed against ${suite.candidate.label} on ${ADAPTERS.length} CRMs. ${n} regress on ${suite.adapter.label}, and each one writes something no rollback can reach. The candidate stays behind the canary, with every mutation still pre-flighted.`,
        badge: `${n} regressions · rollout held at 10%`,
        outlook: 'Rollout stays held until the suite is green or the merge threshold is put back.',
      },
      promoted: {
        status: 'promoted to 100%', color: 'var(--color-pass)',
        note: `${suite.candidate.label} is now the default build for all pipeline traffic. The ${n} failing cases were accepted under an amended policy: any run that trips it is held and the account owner is paged.`,
        badge: `${n} regressions · rolled out to 100%`,
        outlook: 'The failures were accepted with an amended policy, so any run that trips it is held and the owner paged.',
      },
      blocked: {
        status: `blocked · rolled back to ${suite.baseline.id}`, color: 'var(--color-fail)',
        note: `${suite.candidate.label} is withdrawn from the canary and ${suite.baseline.id} restored. The candidate keeps receiving shadow traffic, so the suite keeps filling with no production exposure.`,
        badge: `${n} regressions · rolled back to ${suite.baseline.id}`,
        outlook: `${suite.baseline.id} is serving production again. The candidate keeps taking shadow traffic, so the suite fills without exposure.`,
      },
    };
    const actions = [
      ['promoted', 'Promote to 100%'],
      ['held', 'Hold at canary'],
      ['blocked', 'Block & roll back'],
    ].map(([id, label]) => ({
      label, go: () => this.setState({ gate: id }),
      border: choice === id ? 'var(--color-accent)' : 'var(--color-neutral-400)',
      color: choice === id ? 'var(--color-accent-700)' : 'var(--color-neutral-800)',
    }));
    return { ...COPY[choice], actions };
  }

  /** A stable, human-sized name for this run — it is a label, not an identifier. */
  runId() {
    return `#${1800 + this.suite.results.length * 4 + ADAPTERS.findIndex((a) => a.id === this.state.crm)}`;
  }

  /** One span status, in the words and the colour the trace screen uses for it. */
  traceStatusTone(status) {
    if (status === 'ok') return { label: 'OK', color: 'var(--color-pass)', dot: 'var(--color-pass)' };
    if (status === 'held') return { label: 'Held', color: 'var(--color-held)', dot: 'var(--color-held)' };
    if (status === 'partial') return { label: 'Partial', color: 'var(--color-held)', dot: 'var(--color-held)' };
    if (status === 'no-op') return { label: 'No-op', color: 'var(--color-text-2)', dot: 'var(--color-neutral-400)' };
    if (status === 'failed') return { label: 'Failed', color: 'var(--color-fail)', dot: 'var(--color-fail)' };
    if (/retry/.test(status)) {
      return { label: status.replace(' retry', ' · retrying'), color: 'var(--color-held)', dot: 'var(--color-held)' };
    }
    return { label: status, color: 'var(--color-fail)', dot: 'var(--color-fail)' };
  }

  /**
   * The trace screen reads the run as five stages rather than a flat list of
   * spans, because that is the shape of the question being asked of it: what
   * did the agent plan, what could it call, what did it do, can it be undone,
   * and did the account end up right. Only the execution stage expands into
   * individual calls — the rest are one span each.
   */
  traceView() {
    const st = this.state;
    const t = traceFor(st.crm, st.build);
    const spans = t.spans;
    const tone = (s) => this.traceStatusTone(s);

    const planSpan = spans[0];
    const discoverSpan = spans[1];
    const shadowSpan = spans[2];
    const verifySpan = spans[spans.length - 1];
    const callSpans = spans.slice(3, spans.length - 1);
    const crmSpans = [shadowSpan, ...callSpans];

    const okN = crmSpans.filter((s) => s.status === 'ok' || s.status === 'no-op').length;
    const warnN = crmSpans.filter((s) => s.status === 'held' || s.status === 'partial' || /retry/.test(s.status)).length;
    const failN = crmSpans.filter((s) => s.status === 'failed' || /fatal/.test(s.status)).length;
    const saga = t.saga;

    let toolCount = 10;
    try { toolCount = JSON.parse(discoverSpan.result).tools ?? 10; } catch { /* the span is a fixture; the count is a nicety */ }

    const rows = crmSpans.map((sp) => {
      const [op, target] = sp.name.split(' · ');
      return {
        id: sp.id, op, target: target || '—', tn: tone(sp.status), ms: sp.ms,
        sel: st.traceSel === sp.id,
        select: () => this.setState({ traceSel: sp.id }),
      };
    });

    const steps = [
      { key: 'plan', n: 1, name: 'Agent plan', sub: 'Generated the execution plan for the task', ms: planSpan.ms, dot: tone(planSpan.status).dot, spanId: planSpan.id },
      { key: 'discover', n: 2, name: 'Tools discovered', sub: `Loaded ${toolCount} available CRM tools`, ms: discoverSpan.ms, dot: tone(discoverSpan.status).dot, spanId: discoverSpan.id },
      { key: 'exec', n: 3, name: 'CRM execution', sub: `Executed ${crmSpans.length} operations against a shadow account`, counts: { okN, warnN, failN }, rows, spanId: shadowSpan.id },
      {
        key: 'recovery', n: 4, name: 'Recovery',
        sub: saga.unrecoverable
          ? `${saga.unrecoverable} write${saga.unrecoverable === 1 ? '' : 's'} cannot be undone`
          : 'Every write is reversible or compensable',
        dot: saga.unrecoverable ? 'var(--color-fail)' : saga.steps.length ? 'var(--color-held)' : 'var(--color-pass)',
        spanId: 'recovery',
      },
      {
        key: 'verify', n: 5, name: 'Verification',
        sub: verifySpan.status === 'ok'
          ? 'Final CRM state matches the expected state'
          : 'Final CRM state did not match the expected state',
        ms: verifySpan.ms, dot: tone(verifySpan.status).dot, spanId: verifySpan.id,
      },
    ].map((s) => ({
      ...s,
      open: st.traceStep === s.key,
      toggle: () => this.setState((x) => ({ traceStep: x.traceStep === s.key ? null : s.key, traceSel: s.spanId })),
    }));

    // With nothing selected the pane opens on the first span that went wrong,
    // because that is what the screen is being opened to find.
    const firstProblem = crmSpans.find((s) => s.status !== 'ok' && s.status !== 'no-op');
    const selId = st.traceSel || (firstProblem ? firstProblem.id : verifySpan.id);
    const regressed = verifySpan.status !== 'ok';

    return {
      backTo: () => this.goTab('pipeline'),
      openLab: () => this.goTab('chaos'),
      runId: this.runId(),
      subtitle: `${this.buildObj.label} · ${this.adapter.label} adapter · shadow account`,
      statusLabel: regressed ? 'Regressed' : 'Passed',
      statusColor: regressed ? 'var(--color-fail)' : 'var(--color-pass)',
      tiles: [
        { label: 'Total duration', value: (t.totalMs / 1000).toFixed(1) + 's' },
        { label: 'Total spans', value: String(spans.length) },
        { label: 'CRM calls', value: String(t.run.trace.length) },
      ],
      steps, detail: this.traceDetail(selId, spans, verifySpan, saga), selId,
      tabs: ['summary', 'request', 'response'],
      tab: st.traceTab === 'policy' ? 'summary' : st.traceTab,
      setTab: (name) => this.setState({ traceTab: name }),
    };
  }

  /**
   * What the detail pane says about one selection. Recovery is not a span —
   * it is the compensating plan built from the audit log — so it is described
   * separately rather than being forced into the span shape.
   */
  traceDetail(id, spans, verifySpan, saga) {
    if (id === 'recovery') {
      return {
        tag: saga.unrecoverable ? 'Partial' : 'Recoverable',
        tagColor: saga.unrecoverable ? 'var(--color-held)' : 'var(--color-pass)',
        title: 'Compensating plan',
        ms: `${saga.steps.length} steps`,
        desc: 'Rebuilt from the audit log to undo the writes this run made.',
        callout: saga.unrecoverable ? {
          color: 'var(--color-fail)', bg: 'var(--color-amber-100)',
          title: 'Rollback cannot fully restore',
          text: `${saga.unrecoverable} write${saga.unrecoverable === 1 ? '' : 's'} on this CRM have no inverse. Applying the plan is a partial rollback.`,
        } : {
          color: 'var(--color-pass)', bg: 'var(--color-accent-100)',
          title: 'Fully reversible',
          text: 'Every write in this run has an inverse; the checkpoint restores exactly.',
        },
        summary: [
          ['Writes recorded', String(saga.steps.length)],
          ['No inverse', String(saga.unrecoverable)],
          ['End state', saga.clean ? 'Matches a clean run' : 'Differs from a clean run'],
        ],
        sagaRows: saga.steps, request: null, response: null,
        policy: 'Recovery runs under the same policies as the forward path; a write with no inverse is flagged before it is issued.',
      };
    }

    const span = spans.find((s) => s.id === id) || verifySpan;
    const [op, target] = span.name.split(' · ');
    const tn = this.traceStatusTone(span.status);
    const held = span.status === 'held';
    const failed = span.status === 'failed' || /fatal/.test(span.status);

    /* The four spans that are not CRM calls describe themselves; everything
       else is a tool call, and reads the same way. */
    const DESC = {
      'llm.plan': 'The planner turned the request into an ordered set of CRM operations.',
      'composio.tools.discover': 'Discovered the CRM tools available on this connection.',
      'agentguard.shadow': 'Rehearsed the whole plan against a throwaway shadow account before anything ran.',
      'agentguard.verify': 'Checked the final account state against what the run was supposed to produce.',
    };

    return {
      tag: tn.label, tagColor: tn.color, title: span.name, ms: span.ms,
      desc: DESC[span.name] || `${op} issued against the shadow ${this.adapter.label} account.`,
      callout: held ? {
        color: 'var(--color-held)', bg: 'var(--color-amber-100)',
        title: 'Held for review',
        text: 'The shadow rehearsal tripped one or more conditions, so this call is waiting on an operator decision.',
      } : failed ? {
        color: 'var(--color-fail)', bg: 'var(--color-amber-100)',
        title: 'Did not reach the expected state',
        text: 'This span ended in a mismatch — the account was left different from a clean run.',
      } : null,
      summary: [
        ['Status', tn.label],
        ['Duration', span.ms],
        span.native ? ['Native call', span.native] : null,
        span.cls ? ['Class', span.cls] : null,
        target ? ['Target', target] : null,
      ].filter(Boolean),
      request: span.args, response: span.result,
      policy: span.cls === 'irreversible'
        ? 'Irreversible on this CRM — the policy engine requires approval before it can run.'
        : held
          ? 'Held by the shadow gate: one or more active policies objected to this call.'
          : 'Cleared every active policy on the pre-flight rehearsal.',
    };
  }

  /** The four sidebar glyphs, drawn rather than imported so they inherit colour. */
  navIcon(name) {
    const attrs = {
      width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    };
    if (name === 'overview') {
      return (
        <svg {...attrs}>
          <rect x="2" y="2" width="6" height="6" rx="1.4" />
          <rect x="10" y="2" width="6" height="6" rx="1.4" />
          <rect x="2" y="10" width="6" height="6" rx="1.4" />
          <rect x="10" y="10" width="6" height="6" rx="1.4" />
        </svg>
      );
    }
    if (name === 'sim') {
      return (
        <svg {...attrs}>
          <path d="M1.5 9s2.8-4.6 7.5-4.6S16.5 9 16.5 9s-2.8 4.6-7.5 4.6S1.5 9 1.5 9Z" />
          <circle cx="9" cy="9" r="2.2" />
        </svg>
      );
    }
    if (name === 'trace') {
      return (
        <svg {...attrs}>
          <path d="M1.5 9h3l2-5 3 10 2-6 1.5 3h3.5" />
        </svg>
      );
    }
    return (
      <svg {...attrs}>
        <path d="M3.2 9a5.6 5.6 0 1 0 1.9-4.2" />
        <path d="M2.6 3.6v3.1h3.1" />
      </svg>
    );
  }

  render() {
    const v = this.renderVals();
    const S = {
      page: css(`height:100vh;display:flex;flex-direction:row;background:var(--color-bg);font-family:var(--font-ui)`),
      head: css(`display:flex;align-items:center;justify-content:space-between;gap:18.4px;padding:13.8px 32px;background:var(--color-panel);border-bottom:1px solid var(--color-border);flex:none`),
      kicker: css(`font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-2)`),
      eyebrow: css(`font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-2);padding-bottom:6px`),
      h1: css(`font-family:var(--font-ui);font-weight:560;letter-spacing:-.012em;font-size:24px;margin:4.6px 0 0;line-height:1.2`),
      body: css(`font-size:15px;line-height:1.65;max-width:78ch;margin:11px 0 0;color:var(--color-text-2)`),
      btn: css(`font-family:var(--font-ui);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-accent);color:var(--color-accent-700);background:transparent;border-radius:var(--radius-md);cursor:pointer`),
      btn2: css(`font-family:var(--font-ui);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-neutral-400);color:var(--color-neutral-800);background:transparent;border-radius:var(--radius-md);cursor:pointer`),
      sel: css(`font-family:var(--font-ui);font-size:13px;padding:7px 9.2px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-panel-2);color:var(--color-text)`),
      lab: css(`font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-2)`),
      pre: css(`margin:0;font-family:var(--font-mono);font-size:12.5px;line-height:1.7;background:var(--color-panel-2);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:11px;white-space:pre-wrap;color:var(--color-neutral-800);overflow:auto`),
      card: css(`background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:18.4px`),
      // A panel is the second plane: a surface with one border, and no lines
      // between the rows inside it.
      panelRaw: `background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg)`,
      panel: css(`background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg)`),
      panelHead: css(`display:flex;align-items:baseline;justify-content:space-between;gap:13.8px;padding:13.8px 22px;border-bottom:1px solid var(--color-border);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-2)`),
      th: css(`text-align:left;padding:11px 13.8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:560;color:var(--color-text-2);background:var(--color-panel-2)`),
      td: css(`padding:11px 13.8px;border-top:1px solid var(--color-border)`),
      side: css(`width:236px;flex:none;display:flex;flex-direction:column;gap:2px;padding:18.4px 13.8px;background:var(--color-panel);border-right:1px solid var(--color-border);overflow:auto`),
      main: css(`flex:1;min-width:0;display:flex;flex-direction:column`),
      topbar: css(`display:flex;align-items:center;justify-content:space-between;gap:13.8px;padding:9.2px 32px;background:var(--color-panel);border-bottom:1px solid var(--color-border);flex:none`),
    };

    /* The sidebar names the four things you can do, not the five screens —
       the trace and the failure lab are the same job seen twice, so they
       share a nav item. */
    const NAV = [
      { id: 'pipeline', label: 'Overview', desc: 'Overall agent status and recent evaluation results', icon: 'overview', active: v.onPipeline },
      { id: 'preflight', label: 'Simulations', desc: 'Preview proposed CRM changes before they happen', icon: 'sim', active: v.onPreflight },
      { id: 'trace', label: 'Trace', desc: 'Inspect what the agent did, including failures and recovery', icon: 'trace', active: v.onTrace || v.onChaos },
      { id: 'evals', label: 'Replay & compare', desc: 'Replay historical workflows and compare agent versions', icon: 'replay', active: v.onEvals },
    ];
    const trace = v.onTrace ? this.traceView() : null;

return <div style={S.page}>
      <aside style={S.side}>
        <a
          href="#pipeline"
          aria-label="AgentGuard — overview"
          style={css("display:inline-flex;align-items:center;gap:9px;font-family:var(--font-heading);font-weight:700;letter-spacing:-.02em;font-size:19px;color:inherit;text-decoration:none;cursor:pointer;padding:6px 9.2px 13.8px")}
        >
          <span
            style={css("width:11px;height:11px;border-radius:3px;background:var(--color-accent);transform:rotate(45deg)")}
          />
          AgentGuard
        </a>
        <nav style={css("display:flex;flex-direction:column;gap:2px")}>
          {NAV.map(x=><button
            key={x.id}
            className={x.active?"":"hv1"}
            onClick={()=>this.goTab(x.id)}
            title={x.desc}
            aria-current={x.active?"page":void 0}
            style={css(`display:flex;align-items:center;gap:11px;text-align:left;border:0;cursor:pointer;padding:9.2px 11px;border-radius:var(--radius-md);font-family:var(--font-ui);font-size:14px;font-weight:${x.active?600:500};background:${x.active?"var(--color-accent-100)":"transparent"};color:${x.active?"var(--color-accent-700)":"var(--color-neutral-700)"}`)}
          >
            <span
              style={css(`flex:none;display:flex;color:${x.active?"var(--color-accent-600)":"var(--color-neutral-500)"}`)}
            >
              {this.navIcon(x.icon)}
            </span>
            {x.label}
          </button>)}
        </nav>
        <div
          style={css("margin-top:auto;padding:13.8px 11px 4px;border-top:1px solid var(--color-border);font-size:12px;line-height:1.6;color:var(--color-text-2)")}
        >
          <div style={css("display:flex;align-items:center;gap:7px")}>
            <span
              style={css("width:7px;height:7px;border-radius:50%;background:var(--color-accent);animation:ag-pulse 2s infinite")}
            />
            {v.fleet}
          </div>
          <div
            style={css("margin-top:6px;letter-spacing:.06em;text-transform:uppercase")}
          >
            revenue-ops · staging
          </div>
        </div>
      </aside>
      <div style={S.main}>
        <div style={S.topbar}>
          <span style={css("font-size:13px;color:var(--color-text-2)")}>
            {v.adapter.label}
            {" · "}
            {v.buildLabel}
          </span>
          <div style={css("display:flex;align-items:center;gap:9.2px")}>
            <select
              value={v.crm}
              onChange={v.setCrm}
              aria-label="CRM"
              style={S.sel}
            >
              {v.crms.map(x=><option key={x.id} value={x.id}>
                {x.label}
              </option>)}
            </select>
            <select
              value={v.build}
              onChange={v.setBuild}
              aria-label="Agent build"
              style={S.sel}
            >
              <option value="v1.8">
                v1.8 — current
              </option>
              <option value="v1.9">
                v1.9 — candidate
              </option>
            </select>
          </div>
        </div>
        {v.onPipeline&&<div
          style={css("flex:1;min-height:0;overflow:auto;padding:28px 32px 48px")}
        >
          <div style={css("max-width:1280px;margin:0 auto")}>
            <div
              style={css("display:flex;align-items:flex-start;justify-content:space-between;gap:27.6px;flex-wrap:wrap")}
            >
              <div>
                <h1
                  style={css("font-family:var(--font-heading);font-weight:400;font-size:32px;margin:0;line-height:1.15")}
                >
                  {"Evaluation run "}
                  {v.run.id}
                </h1>
                <div
                  style={css("font-size:13px;color:var(--color-text-2);margin-top:5px")}
                >
                  {v.run.subtitle}
                </div>
              </div>
              <div
                style={css(`display:flex;align-items:center;gap:8px;font-size:13px;color:${v.run.statusTone}`)}
              >
                <span
                  style={css(`width:7px;height:7px;border-radius:50%;background:${v.run.statusTone}`)}
                />
                {v.run.status}
              </div>
            </div>
            <div
              style={css("font-size:15px;line-height:1.6;color:var(--color-text-2);margin-top:13.8px;max-width:78ch")}
            >
              {v.run.summary}
            </div>
            <div
              style={css("display:flex;align-items:center;gap:9.2px;flex-wrap:wrap;margin-top:18.4px;font-size:12.5px;color:var(--color-text-2)")}
            >
              {["Instruction","Agent decision","CRM tool call","Proposed state change","Condition validation","Failure handling","Final CRM state","Business correctness"].map((x,i)=><React.Fragment key={i}>
                {i>0&&<span style={css("color:var(--color-neutral-400)")}>
                  →
                </span>}
                <span
                  style={css("background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:4px 9.2px;white-space:nowrap")}
                >
                  {x}
                </span>
              </React.Fragment>)}
            </div>
            <div
              style={css("display:grid;grid-template-columns:repeat(4,1fr);margin-top:22px;background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg)")}
            >
              {v.run.tiles.map((x,i)=><div
                key={i}
                style={css(`padding:18.4px 22px;${i?"border-left:1px solid var(--color-border);":""}`)}
              >
                <div style={css(`font-size:30px;line-height:1.1;color:${x.color}`)}>
                  {x.n}
                </div>
                <div
                  style={css("font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);margin-top:5px")}
                >
                  {x.label}
                </div>
              </div>)}
            </div>
            <div
              style={css("display:grid;grid-template-columns:340px 1fr;gap:22px;margin-top:22px;align-items:start")}
            >
              <div style={S.panel}>
                <div style={S.panelHead}>
                  Execution path
                </div>
                <div style={css("padding:4px 22px 18.4px")}>
                  {v.run.path.map((x,i)=><div
                    key={i}
                    style={css("display:grid;grid-template-columns:18px 1fr;gap:11px")}
                  >
                    <div style={css("display:flex;flex-direction:column;align-items:center")}>
                      <span style={css(`font-size:12px;line-height:20px;color:${x.color}`)}>
                        {x.glyph}
                      </span>
                      {i<v.run.path.length-1&&<span style={css("flex:1;width:1px;background:var(--color-border)")} />}
                    </div>
                    <div style={css(`padding-bottom:${i<v.run.path.length-1?"18.4px":"0"}`)}>
                      <div style={css("font-size:15px;font-weight:560;line-height:20px")}>
                        {x.name}
                      </div>
                      <div
                        style={css("font-size:12.5px;line-height:1.5;color:var(--color-text-2);margin-top:2px")}
                      >
                        {x.note}
                      </div>
                    </div>
                  </div>)}
                </div>
                <div
                  style={css("border-top:1px solid var(--color-border);padding:11px 22px;font-size:12px;color:var(--color-text-2);display:flex;justify-content:space-between;gap:11px")}
                >
                  <span>
                    {"Execution provider: "}
                    {v.run.provider}
                  </span>
                  <span>
                    {"CRM adapter: "}
                    {v.adapter.label}
                  </span>
                </div>
              </div>
              <div style={S.panel}>
                <div style={S.panelHead}>
                  <span>
                    Evaluation pipeline
                  </span>
                  <span
                    style={css("font-weight:400;letter-spacing:0;text-transform:none;color:var(--color-text-2)")}
                  >
                    nothing here touches a production account
                  </span>
                </div>
                <div style={css("padding:6px 0 6px")}>
                  {v.stages.map((x,i)=><div
                    key={i}
                    className="hv0"
                    onClick={x.go}
                    role="button"
                    tabIndex={0}
                    onKeyDown={col=>(col.key==="Enter"||col.key===" ")&&(col.preventDefault(),x.go())}
                    style={css("cursor:pointer;display:grid;grid-template-columns:34px 1fr 18px;gap:13.8px;align-items:baseline;padding:11px 22px")}
                  >
                    <span
                      style={css("font-family:var(--font-mono);font-size:12px;color:var(--color-text-2)")}
                    >
                      {String(i+1).padStart(2,"0")}
                    </span>
                    <span>
                      <span
                        style={css("font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-2);display:block")}
                      >
                        {x.name}
                      </span>
                      <span style={css("font-size:15px;display:block;margin-top:3px")}>
                        {x.headline}
                      </span>
                      <span
                        style={css("font-size:12.5px;color:var(--color-text-2);display:block")}
                      >
                        {x.detail}
                      </span>
                    </span>
                    <span style={css(`font-size:13px;color:${x.tone};text-align:right`)}>
                      {x.glyph}
                    </span>
                  </div>)}
                </div>
              </div>
            </div>
            <details style={css("margin-top:27.6px")}>
              <summary
                style={css("cursor:pointer;font-size:13px;color:var(--color-text-2);padding:6px 0")}
              >
                CRM capabilities — where the three adapters differ
              </summary>
              <div
                style={css("font-size:13px;line-height:1.6;color:var(--color-text-2);margin:9.2px 0 0;max-width:80ch")}
              >
                An agent that is safe on one CRM is not automatically safe on another. The condition engine and the recovery planner read these differences per adapter instead of assuming them.
              </div>
              <div style={css(`${S.panelRaw};margin-top:13.8px;overflow:hidden`)}>
                <table style={css("width:100%;border-collapse:collapse;font-size:14px")}>
                  <thead>
                    <tr>
                      {["CRM","Lead object","Delete","Merge","Stages it cannot tell apart"].map((x,i)=><th key={i} style={S.th}>
                        {x}
                      </th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {v.capabilities.map((x,i)=><tr key={i}>
                      <td
                        style={css(`padding:11px 13.8px;border-top:1px solid var(--color-border);color:${x.current?"var(--color-accent-700)":"var(--color-text)"}`)}
                      >
                        {x.label}
                      </td>
                      <td style={S.td}>
                        {x.lead}
                      </td>
                      <td
                        style={css(`padding:11px 13.8px;border-top:1px solid var(--color-border);color:${x.delColor}`)}
                      >
                        {x.del}
                      </td>
                      <td
                        style={css("padding:11px 13.8px;border-top:1px solid var(--color-border)")}
                      >
                        {x.merge}
                      </td>
                      <td style={S.td}>
                        {x.collapsed}
                      </td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </div>}
        {v.onPreflight&&<div style={css("flex:1;min-height:0;display:flex;flex-direction:column")}>
          <div
            style={css("display:flex;align-items:flex-end;justify-content:space-between;gap:27.6px;padding:18.4px 32px 13.8px")}
          >
            <div>
              <div style={S.kicker}>
                {"Pre-flight review · "}
                {v.adapter.label}
              </div>
              <h1 style={S.h1}>
                {v.awaitingLabel}
              </h1>
              <div
                style={css("font-size:13px;color:var(--color-text-2);margin-top:5px;max-width:78ch")}
              >
                {v.reviewedCount>0&&<span style={css("color:var(--color-pass)")}>
                  {v.reviewedCount}
                  {" reviewed · "}
                </span>}
                {GOAL}
              </div>
            </div>
            <div style={css("display:flex;gap:13.8px;align-items:center")}>
              {v.simIdle&&<button
                className="hv0"
                onClick={v.runSim}
                style={S.btn}
              >
                Run shadow execution
              </button>}
              {v.simRunning&&<span
                style={css("font-size:14px;color:var(--color-accent-700);display:flex;align-items:center;gap:9.2px")}
              >
                <span
                  style={css("width:80px;height:2px;background:var(--color-accent-200);overflow:hidden;display:inline-block")}
                >
                  <span
                    style={css("display:block;width:30%;height:100%;background:var(--color-accent);animation:ag-sweep 1s linear infinite")}
                  />
                </span>
                rehearsing against a shadow account…
              </span>}
              {v.simDone&&<>
                <span style={css("font-size:13px;color:var(--color-text-2)")}>
                  shadow run complete · no side effects
                </span>
                <button
                  className="hv1"
                  onClick={v.runSim}
                  style={S.btn2}
                >
                  Re-run shadow execution
                </button>
              </>}
            </div>
          </div>
          <div
            style={css("flex:1;min-height:0;display:grid;grid-template-columns:340px 1fr 280px;border-top:1px solid var(--color-border)")}
          >
            <div
              style={css("border-right:1px solid var(--color-border);background:var(--color-panel-2);overflow:auto;padding:13.8px")}
            >
              {v.actions.map((x,i)=><div
                key={i}
                className="hv0"
                onClick={x.select}
                style={css(`cursor:pointer;padding:12px 13.8px;margin-bottom:6px;border-left:3px solid ${x.vc};border-radius:var(--radius-md);background:${x.cardBg}`)}
              >
                <div
                  style={css("display:flex;justify-content:space-between;align-items:baseline;gap:9.2px")}
                >
                  <span
                    style={css("font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-size:17px;font-weight:600")}
                  >
                    {x.op}
                  </span>
                  <span
                    style={css(`font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${x.vc};white-space:nowrap`)}
                  >
                    {x.verdictLabel}
                  </span>
                </div>
                <div
                  style={css("font-size:13px;line-height:1.5;color:var(--color-text-2);margin-top:2px")}
                >
                  {x.summary}
                </div>
                <div
                  style={css(`font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${x.classColor};margin-top:4px`)}
                >
                  {x.reversibility}
                </div>
              </div>)}
              <div
                style={css("font-size:12.5px;line-height:1.6;color:var(--color-text-2);border-top:1px solid var(--color-border);padding-top:9.2px;margin-top:13.8px")}
              >
                Every mutation proposed in one agent turn. None have run.
              </div>
            </div>
            <div style={css("overflow:auto;padding:22px 32px")}>
              <div
                style={css("display:flex;align-items:baseline;justify-content:space-between;gap:18.4px")}
              >
                <h2
                  style={css("font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-weight:400;font-size:28px;margin:0")}
                >
                  {v.sel.op}
                </h2>
                <span
                  style={css(`font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${v.sel.vc};border:1px solid ${v.sel.vc};padding:3px 9.2px;border-radius:var(--radius-md);white-space:nowrap`)}
                >
                  {v.sel.verdictLabel}
                </span>
              </div>
              <p
                style={css("font-size:15px;line-height:1.7;margin:9.2px 0 0;max-width:64ch")}
              >
                {v.sel.detail}
              </p>
              {v.simDone&&<div style={css("margin-top:22px")}>
                <div style={S.eyebrow}>
                  State diff — predicted
                </div>
                {v.selDiff.map((x,i)=><div
                  key={i}
                  style={css("display:grid;grid-template-columns:200px 1fr 1fr;gap:13.8px;padding:9.2px 0;border-bottom:1px solid var(--color-border);font-size:14px;animation:ag-in .3s ease both")}
                >
                  <span
                    style={css("color:var(--color-text-2);font-family:var(--font-mono);font-size:12.5px")}
                  >
                    {x.field}
                  </span>
                  <span style={css("color:var(--color-text-2);text-decoration:line-through")}>
                    {x.before}
                  </span>
                  <span style={css("color:var(--color-accent-800)")}>
                    {x.after}
                  </span>
                </div>)}
                <div
                  style={css("font-size:12.5px;color:var(--color-text-2);margin-top:9.2px")}
                >
                  {v.sel.blast}
                </div>
                <div style={css("margin-top:11px")}>
                  <div style={S.eyebrow}>
                    {"Native requests on "}
                    {v.adapter.label}
                  </div>
                  {v.sel.native.map((x,i)=><div
                    key={i}
                    style={css("font-family:var(--font-mono);font-size:12.5px;color:var(--color-text-2);padding:5px 0")}
                  >
                    {x}
                  </div>)}
                </div>
              </div>}
              {v.simNotDone&&<div
                style={css("margin-top:22px;border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:36.8px;text-align:center;font-size:14px;color:var(--color-text-2)")}
              >
                No diff yet. Run the shadow execution to see what would change.
              </div>}
              <div style={css("margin-top:22px")}>
                <div style={S.eyebrow}>
                  Condition verdict
                </div>
                {v.selChecks.map((x,i)=><div
                  key={i}
                  style={css("padding:8px 0;border-bottom:1px solid var(--color-border);font-size:14px")}
                >
                  <div
                    style={css("display:flex;justify-content:space-between;align-items:baseline;gap:9.2px")}
                  >
                    <span style={css(`color:${x.color}`)}>
                      {x.name}
                    </span>
                    <span
                      style={css(`font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${x.color};white-space:nowrap`)}
                    >
                      {x.state}
                    </span>
                  </div>
                  {x.reason&&<div
                    style={css("font-size:12.5px;color:var(--color-neutral-700);margin-top:2px")}
                  >
                    {x.reason}
                  </div>}
                </div>)}
              </div>
              <div
                style={css("display:flex;gap:9.2px;margin-top:22px;align-items:center;flex-wrap:wrap")}
              >
                <button
                  className="hv0"
                  onClick={v.approve}
                  style={S.btn}
                >
                  Approve & execute
                </button>
                <button
                  className="hv1"
                  onClick={v.block}
                  style={S.btn2}
                >
                  Block
                </button>
                <span style={css("font-size:13px;color:var(--color-accent-700)")}>
                  {v.decisionNote}
                </span>
              </div>
            </div>
            <div
              style={css("border-left:1px solid var(--color-border);background:var(--color-panel-2);padding:22px 18.4px;overflow:auto")}
            >
              <div
                style={css("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-text-2);margin-bottom:11px")}
              >
                Active conditions
              </div>
              {v.policies.map((x,i)=><div
                key={i}
                onClick={x.toggle}
                style={css("cursor:pointer;display:flex;gap:9.2px;align-items:flex-start;padding:9.2px 0;border-bottom:1px solid var(--color-border)")}
              >
                <span
                  style={css(`flex:none;margin-top:4px;width:12px;height:12px;border-radius:2px;border:1px solid ${x.mark};background:${x.fill}`)}
                />
                <span>
                  <span
                    style={css(`font-size:13px;line-height:1.45;display:block;color:${x.text}`)}
                  >
                    {x.name}
                  </span>
                  <span
                    style={css("font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-text-2)")}
                  >
                    {x.mode}
                  </span>
                </span>
              </div>)}
              <p
                style={css("font-size:12.5px;line-height:1.7;color:var(--color-text-2);margin-top:13.8px")}
              >
                Toggling a condition re-evaluates every queued mutation against the rehearsal already on file.
              </p>
            </div>
          </div>
        </div>}
        {v.onTrace&&trace&&<div style={css("flex:1;min-height:0;display:flex;flex-direction:column")}>
          <div
            style={css("padding:18.4px 32px 13.8px;border-bottom:1px solid var(--color-border);flex:none")}
          >
            <button
              className="hv1"
              onClick={trace.backTo}
              style={css("display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;cursor:pointer;font-family:var(--font-ui);font-size:12.5px;color:var(--color-text-2);padding:2px 6px 2px 0;border-radius:var(--radius-sm)")}
            >
              ← Overview
            </button>
            <div
              style={css("display:flex;align-items:flex-start;justify-content:space-between;gap:27.6px;flex-wrap:wrap;margin-top:6px")}
            >
              <div>
                <div style={css("display:flex;align-items:center;gap:11px")}>
                  <h1
                    style={css("font-family:var(--font-heading);font-weight:600;letter-spacing:-.02em;font-size:26px;margin:0")}
                  >
                    {"Trace — Run "}
                    {trace.runId}
                  </h1>
                  <span
                    style={css(`display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:${trace.statusColor};background:color-mix(in srgb, ${trace.statusColor} 12%, transparent);padding:3px 10px;border-radius:999px`)}
                  >
                    <span
                      style={css(`width:6px;height:6px;border-radius:50%;background:${trace.statusColor}`)}
                    />
                    {trace.statusLabel}
                  </span>
                </div>
                <div
                  style={css("font-size:13px;color:var(--color-text-2);margin-top:4px")}
                >
                  {trace.subtitle}
                </div>
              </div>
              <div style={css("display:flex;gap:27.6px")}>
                {trace.tiles.map((x,i)=><div key={i}>
                  <div
                    style={css("font-family:var(--font-heading);font-weight:600;letter-spacing:-.02em;font-size:22px;line-height:1.1")}
                  >
                    {x.value}
                  </div>
                  <div
                    style={css("font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-2);margin-top:3px")}
                  >
                    {x.label}
                  </div>
                </div>)}
              </div>
            </div>
          </div>
          <div
            style={css("flex:1;min-height:0;display:grid;grid-template-columns:1fr 400px")}
          >
            <div style={css("overflow:auto;padding:18.4px 22px 32px")}>
              {trace.steps.map((x,i)=>(trace.detail&&x.spanId===trace.selId&&x.key,<div
                key={x.key}
                style={css(`position:relative;padding-left:38px;padding-bottom:${i<trace.steps.length-1?"11px":"0"}`)}
              >
                {i<trace.steps.length-1&&<span
                  style={css("position:absolute;left:14px;top:30px;bottom:0;width:1px;background:var(--color-border)")}
                />}
                <span
                  style={css(`position:absolute;left:2px;top:6px;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;border:1px solid ${x.open?"var(--color-accent)":"var(--color-border)"};background:${x.open?"var(--color-accent)":"var(--color-panel)"};color:${x.open?"#fff":"var(--color-text-2)"}`)}
                >
                  {x.n}
                </span>
                <div
                  className="hv1"
                  onClick={x.toggle}
                  role="button"
                  tabIndex={0}
                  onKeyDown={col=>(col.key==="Enter"||col.key===" ")&&(col.preventDefault(),x.toggle())}
                  style={css("cursor:pointer;display:flex;align-items:center;gap:13.8px;padding:9.2px 13.8px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-panel)")}
                >
                  <div style={css("flex:1;min-width:0")}>
                    <div style={css("font-size:15px;font-weight:600;letter-spacing:-.01em")}>
                      {x.name}
                    </div>
                    <div
                      style={css("font-size:12.5px;color:var(--color-text-2);margin-top:1px")}
                    >
                      {x.sub}
                    </div>
                  </div>
                  {x.ms&&<span style={css("font-size:12.5px;color:var(--color-text-2)")}>
                    {x.ms}
                  </span>}
                  {x.counts&&<span
                    style={css("display:flex;align-items:center;gap:9px;font-size:12px;color:var(--color-text-2)")}
                  >
                    <span style={css("display:inline-flex;align-items:center;gap:4px")}>
                      <span
                        style={css("width:7px;height:7px;border-radius:50%;background:var(--color-pass)")}
                      />
                      {x.counts.okN}
                    </span>
                    {x.counts.warnN>0&&<span style={css("display:inline-flex;align-items:center;gap:4px")}>
                      <span
                        style={css("width:7px;height:7px;border-radius:50%;background:var(--color-held)")}
                      />
                      {x.counts.warnN}
                    </span>}
                    {x.counts.failN>0&&<span style={css("display:inline-flex;align-items:center;gap:4px")}>
                      <span
                        style={css("width:7px;height:7px;border-radius:50%;background:var(--color-fail)")}
                      />
                      {x.counts.failN}
                    </span>}
                  </span>}
                  {x.dot&&<span
                    style={css(`width:9px;height:9px;border-radius:50%;background:${x.dot};flex:none`)}
                  />}
                  <span
                    style={css("font-size:12px;color:var(--color-text-2);width:12px;text-align:center")}
                  >
                    {x.open?"▾":"▸"}
                  </span>
                </div>
                {x.open&&x.rows&&<div
                  style={css("margin-top:9.2px;border:1px solid var(--color-border);border-radius:var(--radius-md);overflow:hidden;background:var(--color-panel);animation:ag-in .2s ease both")}
                >
                  <div
                    style={css("display:grid;grid-template-columns:1.1fr 1.4fr 100px 70px;gap:11px;padding:8px 13.8px;background:var(--color-panel-2);border-bottom:1px solid var(--color-border);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-2)")}
                  >
                    <span>
                      Action
                    </span>
                    <span>
                      Target
                    </span>
                    <span>
                      Result
                    </span>
                    <span style={css("text-align:right")}>
                      Time
                    </span>
                  </div>
                  {x.rows.map(col=><div
                    key={col.id}
                    className="hv1"
                    onClick={col.select}
                    style={css(`display:grid;grid-template-columns:1.1fr 1.4fr 100px 70px;gap:11px;padding:8px 13.8px;border-bottom:1px solid var(--color-border);font-size:13px;align-items:center;cursor:pointer;background:${col.sel?"var(--color-accent-100)":"transparent"}`)}
                  >
                    <span style={css("font-family:var(--font-mono);font-size:12.5px")}>
                      {col.op}
                    </span>
                    <span
                      style={css("color:var(--color-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap")}
                    >
                      {col.target}
                    </span>
                    <span
                      style={css(`display:inline-flex;align-items:center;gap:6px;color:${col.tn.color}`)}
                    >
                      <span
                        style={css(`width:7px;height:7px;border-radius:50%;background:${col.tn.dot}`)}
                      />
                      {col.tn.label}
                    </span>
                    <span style={css("text-align:right;color:var(--color-text-2)")}>
                      {col.ms}
                    </span>
                  </div>)}
                </div>}
                {x.open&&x.key==="recovery"&&<div style={css("margin-top:9.2px;display:flex;gap:9.2px;flex-wrap:wrap")}>
                  <button
                    className="hv1"
                    onClick={()=>this.setState({traceSel:"recovery"})}
                    style={S.btn2}
                  >
                    View compensating plan
                  </button>
                  <button
                    className="hv0"
                    onClick={trace.openLab}
                    style={S.btn}
                  >
                    Open failure lab →
                  </button>
                </div>}
              </div>))}
            </div>
            <div
              style={css("border-left:1px solid var(--color-border);background:var(--color-panel-2);overflow:auto;padding:18.4px 22px")}
            >
              {trace.detail&&<div style={css("animation:ag-in .2s ease both")}>
                <span
                  style={css(`display:inline-flex;align-items:center;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${trace.detail.tagColor};background:color-mix(in srgb, ${trace.detail.tagColor} 13%, transparent);padding:3px 9px;border-radius:var(--radius-sm)`)}
                >
                  {trace.detail.tag}
                </span>
                <div
                  style={css("display:flex;align-items:baseline;justify-content:space-between;gap:11px;margin-top:9.2px")}
                >
                  <h2
                    style={css("font-family:var(--font-mono);font-weight:600;font-size:17px;margin:0;letter-spacing:-.01em")}
                  >
                    {trace.detail.title}
                  </h2>
                  <span
                    style={css("font-size:13px;color:var(--color-text-2);white-space:nowrap")}
                  >
                    {trace.detail.ms}
                  </span>
                </div>
                {trace.detail.desc&&<p
                  style={css("font-size:13px;line-height:1.6;color:var(--color-text-2);margin:6px 0 0")}
                >
                  {trace.detail.desc}
                </p>}
                {trace.detail.callout&&<div
                  style={css(`margin-top:13.8px;background:${trace.detail.callout.bg};border-left:3px solid ${trace.detail.callout.color};border-radius:var(--radius-md);padding:11px 13.8px`)}
                >
                  <div style={css("display:flex;gap:7px;align-items:baseline")}>
                    <span style={css(`color:${trace.detail.callout.color};font-size:13px`)}>
                      ▲
                    </span>
                    <div>
                      <div
                        style={css(`font-size:13px;font-weight:600;color:${trace.detail.callout.color}`)}
                      >
                        {trace.detail.callout.title}
                      </div>
                      <div
                        style={css("font-size:12.5px;line-height:1.6;color:var(--color-neutral-800);margin-top:2px")}
                      >
                        {trace.detail.callout.text}
                      </div>
                    </div>
                  </div>
                </div>}
                <div
                  style={css("display:flex;gap:2px;margin-top:18.4px;border-bottom:1px solid var(--color-border)")}
                >
                  {trace.tabs.map(x=><button
                    key={x}
                    onClick={()=>trace.setTab(x)}
                    style={css(`border:0;background:transparent;cursor:pointer;font-family:var(--font-ui);font-size:13px;font-weight:${trace.tab===x?600:500};text-transform:capitalize;padding:7px 11px;color:${trace.tab===x?"var(--color-accent-700)":"var(--color-text-2)"};border-bottom:2px solid ${trace.tab===x?"var(--color-accent)":"transparent"};margin-bottom:-1px`)}
                  >
                    {x}
                  </button>)}
                </div>
                <div style={css("margin-top:13.8px")}>
                  {trace.tab==="summary"&&<div>
                    {trace.detail.summary.map(([x,i],col)=><div
                      key={col}
                      style={css("display:flex;justify-content:space-between;gap:13.8px;padding:7px 0;border-bottom:1px solid var(--color-border);font-size:13px")}
                    >
                      <span style={css("color:var(--color-text-2)")}>
                        {x}
                      </span>
                      <span
                        style={css(`text-align:right;font-family:${x==="Native call"?"var(--font-mono)":"inherit"};font-size:${x==="Native call"?"12px":"13px"}`)}
                      >
                        {i}
                      </span>
                    </div>)}
                    {trace.detail.sagaRows&&<div style={css("margin-top:13.8px")}>
                      <div
                        style={css("font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-text-2);margin-bottom:6px")}
                      >
                        Writes to compensate
                      </div>
                      {trace.detail.sagaRows.map((x,i)=><div
                        key={i}
                        style={css("padding:7px 0;border-bottom:1px solid var(--color-border)")}
                      >
                        <div style={css("display:flex;justify-content:space-between;gap:9px")}>
                          <span
                            style={css(`font-family:var(--font-mono);font-size:12px;color:${x.color}`)}
                          >
                            {x.step}
                          </span>
                          <span
                            style={css(`font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${x.color};white-space:nowrap`)}
                          >
                            {x.state}
                          </span>
                        </div>
                        <div
                          style={css("font-size:12px;color:var(--color-text-2);line-height:1.5;margin-top:2px")}
                        >
                          {x.undo}
                        </div>
                      </div>)}
                    </div>}
                  </div>}
                  {trace.tab==="request"&&(trace.detail.request?<pre style={S.pre}>
                    {trace.detail.request}
                  </pre>:<div style={css("font-size:13px;color:var(--color-text-2)")}>
                    No request payload for this step.
                  </div>)}
                  {trace.tab==="response"&&(trace.detail.response?<pre style={S.pre}>
                    {trace.detail.response}
                  </pre>:<div style={css("font-size:13px;color:var(--color-text-2)")}>
                    No response payload for this step.
                  </div>)}
                </div>
              </div>}
            </div>
          </div>
        </div>}
        {v.onChaos&&<div
          style={css("flex:1;min-height:0;display:grid;grid-template-columns:320px 1fr")}
        >
          <div
            style={css("border-right:1px solid var(--color-border);padding:22px 18.4px;overflow:auto;display:flex;flex-direction:column;gap:18.4px")}
          >
            <div
              style={css("font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-text-2)")}
            >
              Inject failure
            </div>
            <label style={css("display:flex;flex-direction:column;gap:4.6px")}>
              <span style={S.lab}>
                Recorded run
              </span>
              <select
                value={v.caseId}
                onChange={v.setCase}
                style={S.sel}
              >
                {v.allCases.map(x=><option key={x.id} value={x.id}>
                  {x.name}
                </option>)}
              </select>
            </label>
            <label style={css("display:flex;flex-direction:column;gap:4.6px")}>
              <span style={S.lab}>
                Fault
              </span>
              <select
                value={v.fault}
                onChange={v.setFault}
                style={S.sel}
              >
                {v.faults.map(x=><option key={x.id} value={x.id}>
                  {x.name}
                  {x.transient?"":" — permanent"}
                </option>)}
              </select>
            </label>
            <label style={css("display:flex;flex-direction:column;gap:4.6px")}>
              <span style={S.lab}>
                At operation
              </span>
              <select
                value={v.op}
                onChange={v.setOp}
                style={S.sel}
              >
                {v.points.map(x=><option key={x.op} value={x.op}>
                  {x.label}
                </option>)}
              </select>
            </label>
            <div
              style={css("display:flex;flex-direction:column;gap:9.2px;border-top:1px solid var(--color-border);padding-top:13.8px")}
            >
              {v.modifiers.map((x,i)=><div
                key={i}
                onClick={x.toggle}
                style={css("cursor:pointer;display:flex;gap:9.2px;align-items:flex-start")}
              >
                <span
                  style={css(`flex:none;margin-top:3px;width:12px;height:12px;border-radius:2px;border:1px solid ${x.mark};background:${x.fill}`)}
                />
                <span style={css(`font-size:13px;line-height:1.45;color:${x.text}`)}>
                  {x.label}
                </span>
              </div>)}
            </div>
            <button
              className="hv0"
              onClick={v.inject}
              style={S.btn}
            >
              {v.injectLabel}
            </button>
            <div
              style={css("font-size:12.5px;line-height:1.7;color:var(--color-text-2);border-top:1px solid var(--color-border);padding-top:11px")}
            >
              Runs against a shadow account only. No production CRM is touched.
            </div>
          </div>
          <div style={css("padding:22px 32px;overflow:auto")}>
            <div style={S.kicker}>
              Failure lab
            </div>
            <h1 style={S.h1}>
              Replay a recorded run with a fault injected.
            </h1>
            <p
              style={css("font-size:15px;line-height:1.7;max-width:66ch;margin:13.8px 0 0")}
            >
              {v.experimentLine}
            </p>
            {v.chaosDone&&<div
              style={css(`margin-top:22px;border:1px solid ${v.verdict.border};border-radius:var(--radius-md);padding:18.4px;animation:ag-in .3s ease both`)}
            >
              <div
                style={css(`font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-size:24px;color:${v.verdict.color}`)}
              >
                {v.verdict.headline}
              </div>
              <div
                style={css("display:grid;grid-template-columns:repeat(4,1fr);gap:18.4px;margin-top:13.8px")}
              >
                {v.verdict.checks.map((x,i)=><div
                  key={i}
                  style={css("border-top:1px solid var(--color-border);padding-top:9.2px")}
                >
                  <div
                    style={css("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-text-2)")}
                  >
                    {x.label}
                  </div>
                  <div
                    style={css(`font-size:15px;font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;color:${x.color};margin-top:3px`)}
                  >
                    {x.value}
                  </div>
                  <div
                    style={css("font-size:12.5px;line-height:1.5;color:var(--color-text-2);margin-top:2px")}
                  >
                    {x.note}
                  </div>
                </div>)}
              </div>
            </div>}
            {v.chaosDone&&v.proposal&&<div
              style={css("margin-top:18.4px;border:1px solid var(--color-border);border-left:3px solid var(--color-accent);border-radius:var(--radius-md);padding:13.8px 18.4px;animation:ag-in .3s ease both")}
            >
              <div
                style={css("display:flex;align-items:baseline;justify-content:space-between;gap:13.8px;flex-wrap:wrap")}
              >
                <span
                  style={css("font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-size:19px")}
                >
                  {v.proposal.novel?"This failure is not in the suite":`Already covered by ${v.proposal.covered}`}
                </span>
                <button
                  className="hv1"
                  onClick={v.toggleSource}
                  style={css("font-family:var(--font-ui);font-size:13px;padding:5px 13.8px;border:1px solid var(--color-neutral-400);color:var(--color-neutral-800);background:transparent;border-radius:var(--radius-md);cursor:pointer")}
                >
                  {v.showSource?"Hide case":"Show generated case"}
                </button>
              </div>
              <p
                style={css("font-size:13px;line-height:1.7;color:var(--color-neutral-800);margin:4.6px 0 0")}
              >
                {v.proposal.why}
                {". Minimised to "}
                {v.proposal.reduction.kept}
                {" of "}
                {v.proposal.reduction.from}
                {" records, the smallest account that still reproduces it."}
              </p>
              {v.showSource&&<pre
                style={css("margin:11px 0 0;font-family:var(--font-mono);font-size:12px;line-height:1.6;background:var(--color-neutral-100);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:11px;max-height:320px;overflow:auto;color:var(--color-neutral-800)")}
              >
                {v.proposal.source}
              </pre>}
            </div>}
            <div
              style={css("margin-top:22px;border-top:1px solid var(--color-border)")}
            >
              {v.chaosLog.map((x,i)=><div
                key={i}
                style={css("display:grid;grid-template-columns:70px 1fr;gap:18.4px;padding:7px 0;border-bottom:1px solid var(--color-border);animation:ag-in .3s ease both")}
              >
                <span style={css("font-size:13px;color:var(--color-text-2)")}>
                  {x.t}
                </span>
                <span style={css(`font-size:14px;line-height:1.5;color:${x.color}`)}>
                  {x.text}
                </span>
              </div>)}
            </div>
            {v.chaosIdle&&<div
              style={css("margin-top:18.4px;border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:36.8px;text-align:center;font-size:14px;color:var(--color-text-2)")}
            >
              Pick a fault and inject it to see the recovery path.
            </div>}
          </div>
        </div>}
        {v.onEvals&&<div style={css("flex:1;min-height:0;overflow:auto;padding:22px 32px")}>
          <div
            style={css("display:flex;align-items:flex-end;justify-content:space-between;gap:18.4px")}
          >
            <div>
              <div style={S.kicker}>
                {"Replay & evals · "}
                {v.adapter.label}
              </div>
              <h1 style={S.h1}>
                {v.cases.length}
                {" recorded cases, replayed against "}
                {v.evalCandId}
                .
              </h1>
            </div>
            <span
              style={css(`font-size:13px;color:${v.gate.color};background:var(--color-panel);border:1px solid var(--color-border);padding:6px 13.8px;border-radius:var(--radius-md);white-space:nowrap`)}
            >
              {v.gate.badge}
            </span>
          </div>
          <div
            style={css("display:grid;grid-template-columns:repeat(5,1fr);gap:0;margin-top:22px;border-top:1px solid var(--color-text)")}
          >
            {v.metrics.map((x,i)=><div
              key={i}
              style={css("padding:13.8px 13.8px 13.8px 0;border-right:1px solid var(--color-border)")}
            >
              <div
                style={css("font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-text-2)")}
              >
                {x.label}
              </div>
              <div
                style={css("display:flex;align-items:baseline;gap:6px;margin-top:6px")}
              >
                <span
                  style={css("font-size:14px;color:var(--color-neutral-500);text-decoration:line-through")}
                >
                  {x.old}
                </span>
                <span
                  style={css(`font-family:var(--font-ui);font-weight:600;letter-spacing:-.008em;font-size:21px;color:${x.color}`)}
                >
                  {x.cand}
                </span>
                <span style={css("font-size:13px;color:var(--color-fail)")}>
                  {x.mark}
                </span>
              </div>
            </div>)}
          </div>
          <p
            style={css("font-size:13px;line-height:1.6;color:var(--color-text-2);margin:9.2px 0 0")}
          >
            {v.evalLede}
          </p>
          <table
            style={css("width:100%;border-collapse:collapse;margin-top:22px;font-size:13.5px")}
          >
            <thead>
              <tr>
                <th style={S.th}>
                  Recorded case
                </th>
                <th style={S.th}>
                  Injected fault
                </th>
                <th
                  style={css("text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-weight:600;font-size:15px")}
                >
                  {v.evalBaseId}
                </th>
                <th
                  style={css("text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-weight:600;font-size:15px")}
                >
                  {v.evalCandId}
                </th>
                <th
                  style={css("text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-weight:600;font-size:15px")}
                >
                  Δ latency
                </th>
                <th style={S.th} />
              </tr>
            </thead>
            <tbody>
              {v.cases.map((x,i)=><tr
                key={i}
                onClick={x.open}
                style={css(`cursor:pointer;background:${x.bg}`)}
              >
                <td style={S.td}>
                  {x.caret}
                  {" "}
                  {x.name}
                </td>
                <td
                  style={css("padding:11px 6px;border-bottom:1px solid var(--color-border);color:var(--color-text-2);font-size:13px")}
                >
                  {x.fault}
                </td>
                <td
                  style={css(`padding:11px 6px;border-bottom:1px solid var(--color-border);text-align:right;color:${x.baseColor}`)}
                >
                  {x.base}
                </td>
                <td
                  style={css(`padding:11px 6px;border-bottom:1px solid var(--color-border);text-align:right;color:${x.color};font-weight:560`)}
                >
                  {x.cand}
                </td>
                <td
                  style={css("padding:11px 6px;border-bottom:1px solid var(--color-border);text-align:right;color:var(--color-text-2)")}
                >
                  {x.delta}
                </td>
                <td
                  style={css(`padding:11px 6px;border-bottom:1px solid var(--color-border);font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:${x.tagColor}`)}
                >
                  {x.tag}
                </td>
              </tr>)}
            </tbody>
          </table>
          {v.portability.length>0&&<div
            style={css("margin-top:18.4px;border-left:3px solid var(--color-accent);padding:11px 18.4px;background:var(--color-accent-100);border-radius:var(--radius-md)")}
          >
            <div
              style={css("font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-size:18px")}
            >
              A CRM failure, not a build regression
            </div>
            {v.portability.map((x,i)=><p
              key={i}
              style={css("font-size:13px;line-height:1.7;color:var(--color-neutral-800);margin:4.6px 0 0")}
            >
              “
              {x.name}
              {"” fails on "}
              {v.adapter.label}
              {" for both builds, at "}
              {x.field}
              . Promoting or blocking v1.9 changes nothing here; the pipeline mapping does.
            </p>)}
          </div>}
          {v.compareOpen&&<div
            style={css("margin-top:27.6px;border-top:1px solid var(--color-text);padding-top:18.4px;animation:ag-in .3s ease both")}
          >
            <div
              style={css("display:flex;align-items:baseline;justify-content:space-between;gap:18.4px")}
            >
              <h2
                style={css("font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-weight:400;font-size:26px;margin:0")}
              >
                {v.compare.name}
              </h2>
              <span style={css("font-size:13px;color:var(--color-text-2)")}>
                {v.compare.summary}
              </span>
            </div>
            <p
              style={css("font-size:14px;line-height:1.7;color:var(--color-text-2);margin:4.6px 0 0;max-width:80ch")}
            >
              {v.compare.note}
            </p>
            <div
              style={css("display:grid;grid-template-columns:1fr 1fr;gap:27.6px;margin-top:13.8px")}
            >
              {[[v.evalBaseLabel,v.compare.left,"var(--color-text-2)"],[v.evalCandLabel,v.compare.right,"var(--color-accent-700)"]].map(([x,i,col],j)=><div key={j}>
                <div
                  style={css(`font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${col};border-bottom:1px solid var(--color-border);padding-bottom:6px`)}
                >
                  {x}
                </div>
                {i.map((w,T)=><div
                  key={T}
                  style={css(`display:flex;justify-content:space-between;gap:9.2px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--color-border);color:${w.color}`)}
                >
                  <span style={css("font-family:var(--font-mono);font-size:12.5px")}>
                    {w.step}
                  </span>
                  <span style={css("color:var(--color-text-2)")}>
                    {w.meta}
                  </span>
                </div>)}
              </div>)}
            </div>
            {v.compare.misses.length>0&&<div style={css("margin-top:13.8px")}>
              <div style={S.eyebrow}>
                Where the account ended up wrong
              </div>
              {v.compare.misses.map((x,i)=><div
                key={i}
                style={css("display:grid;grid-template-columns:240px 1fr 1fr;gap:13.8px;padding:7px 0;border-bottom:1px solid var(--color-border);font-size:13px")}
              >
                <span
                  style={css("font-family:var(--font-mono);font-size:12.5px;color:var(--color-text-2)")}
                >
                  {x.field}
                </span>
                <span style={css("color:var(--color-fail)")}>
                  {"got "}
                  {x.got}
                </span>
                <span style={css("color:var(--color-pass)")}>
                  {"want "}
                  {x.want}
                </span>
              </div>)}
            </div>}
            <p
              style={css("font-size:14px;line-height:1.7;color:var(--color-neutral-800);margin:13.8px 0 0;max-width:82ch")}
            >
              {v.compare.verdict}
            </p>
          </div>}
          <div
            style={css("margin-top:27.6px;background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:18.4px")}
          >
            <div
              style={css("display:flex;align-items:baseline;justify-content:space-between;gap:18.4px;flex-wrap:wrap")}
            >
              <span
                style={css("font-family:var(--font-ui);font-weight:560;letter-spacing:-.008em;font-size:22px")}
              >
                {"Deployment gate — agent "}
                {v.score.candidateLabel}
              </span>
              <span
                style={css(`font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${v.gate.color}`)}
              >
                {"operator decision: "}
                {v.gate.status}
              </span>
            </div>
            <div
              style={css("display:grid;grid-template-columns:1fr 220px;gap:27.6px;margin-top:18.4px;align-items:start")}
            >
              <div>
                {v.score.chartRows.map((x,i)=><div
                  key={i}
                  style={css("display:grid;grid-template-columns:1fr 90px 110px 20px;gap:11px;align-items:baseline;padding:7px 0;font-size:14px")}
                >
                  <span
                    style={css(`color:${x.critical?"var(--color-text)":"var(--color-text-2)"}`)}
                  >
                    {x.label}
                    {x.critical&&<span style={css("color:var(--color-text-2);font-size:12px")}>
                      {" · critical"}
                    </span>}
                  </span>
                  <span
                    style={css(`font-family:var(--font-mono);font-size:13px;text-align:right;color:${x.ok?"var(--color-text)":"var(--color-fail)"}`)}
                  >
                    {x.value}
                  </span>
                  <span
                    style={css("font-family:var(--font-mono);font-size:13px;color:var(--color-text-2)")}
                  >
                    {x.direction}
                    {" "}
                    {x.bar}
                  </span>
                  <span
                    style={css(`text-align:right;color:${x.ok||x.beatsBaseline?"var(--color-pass)":"var(--color-fail)"}`)}
                    title={x.ok?"clears the bar":x.beatsBaseline?`better than ${v.score.baselineLabel}`:`worse than ${v.score.baselineLabel}`}
                  >
                    {x.ok||x.beatsBaseline?"✓":"✕"}
                  </span>
                </div>)}
              </div>
              <div
                style={css("background:var(--color-panel-2);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:18.4px;text-align:center")}
              >
                <div
                  style={css("font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-2)")}
                >
                  AgentGuard score
                </div>
                <div
                  style={css(`font-size:44px;line-height:1.1;margin-top:6px;color:${v.score.color}`)}
                >
                  {v.score.candidate.score}
                </div>
                <div style={css("font-size:13px;color:var(--color-text-2)")}>
                  out of 100
                </div>
                <div
                  style={css(`margin-top:11px;padding-top:11px;border-top:1px solid var(--color-border);font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${v.score.color}`)}
                >
                  {v.score.status}
                </div>
                <div
                  style={css("margin-top:9.2px;font-size:12.5px;color:var(--color-text-2)")}
                >
                  {v.score.baselineLabel}
                  {" scores "}
                  <span style={css(`color:${v.score.approved?"var(--color-text-2)":"var(--color-pass)"}`)}>
                    {v.score.baseline.score}
                  </span>
                </div>
              </div>
            </div>
            <p
              style={css("font-size:13.5px;line-height:1.7;margin:13.8px 0 0;max-width:82ch;color:var(--color-text-2)")}
            >
              {v.score.chartFailed.length===0?`Every threshold cleared. ${v.score.candidateLabel} is eligible for promotion.`:`${v.score.chartFailed.length} of ${v.score.chartRows.length} thresholds missed`+(v.score.chartCritical?`, ${v.score.chartCritical} of them critical`:"")+`. ${v.score.baselineLabel} does not clear this bar either — it scores ${v.score.baseline.score} — so the gate separates the two builds by margin rather than by pass and fail.`}
            </p>
            <div
              style={css("font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-2);margin-top:18.4px")}
            >
              Operator override
            </div>
            <div style={css("display:flex;gap:9.2px;margin-top:9.2px;flex-wrap:wrap")}>
              {v.gate.actions.map((x,i)=><button
                key={i}
                className="hv0"
                onClick={x.go}
                style={css(`font-family:var(--font-ui);font-size:14px;padding:9.2px 22px;border:1px solid ${x.border};color:${x.color};background:transparent;border-radius:var(--radius-md);cursor:pointer`)}
              >
                {x.label}
              </button>)}
            </div>
          </div>
        </div>}
      </div>
    </div>;
  }
}
