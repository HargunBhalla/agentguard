import React from 'react';
import { css } from './css.js';
import {
  compareAcrossCrms, verdictFor,
  ADAPTERS, adapterById, CASES, v18, v19, METRIC_ROWS, formatMetric, isRegression,
} from './harness/index.js';
import { rehearseAll, invariantStatus } from './harness/shadow.js';
import { POLICIES } from './harness/policies.js';
import { runChaos, FAULTS, INJECTION_POINTS, MODIFIERS } from './harness/chaos.js';
import { runTrace, runSaga } from './harness/trace.js';
import { proposeFromRun, proposeTests } from './harness/testgen.js';
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

const V = { safe: 'var(--color-neutral-600)', review: 'var(--color-accent-600)', blocked: 'var(--color-accent-800)' };
const LABEL = { safe: 'safe', review: 'needs review', blocked: 'blocked' };
const CLASS_COLOR = {
  reversible: 'var(--color-neutral-600)',
  compensable: 'var(--color-neutral-800)',
  irreversible: 'var(--color-accent-800)',
};

/**
 * The eight stages of the interception path. Each opens the screen where it is
 * worked, so the diagram is a table of contents rather than a picture.
 */
const STAGE_DEFS = [
  { n: '1', name: 'Shadow execution', note: 'Proposed mutations rehearsed against an isolated copy of the account.', tab: 'preflight' },
  { n: '2', name: 'State diff', note: 'Predicted before/after on every record the run would touch.', tab: 'preflight' },
  { n: '3', name: 'Policy engine', note: 'Merges, deletes, closed deals and stale writes are judged here.', tab: 'preflight' },
  { n: '4', name: 'Failure injection', note: 'Timeouts, 403s, stale indexes and unreadable payloads replayed.', tab: 'chaos' },
  { n: '5', name: 'Safe execution', note: 'Approved calls issued through the adapter, under an idempotency key.', tab: 'trace' },
  { n: '6', name: 'Recovery', note: 'Compensating actions rebuilt from the audit log — where one exists.', tab: 'trace' },
  { n: '7', name: 'Replay & evals', note: 'Recorded cases replayed against the candidate build on every CRM.', tab: 'evals' },
  { n: '8', name: 'Regression tests', note: 'Failures minimised into cases that can be checked in.', tab: 'evals' },
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
    if (!tripped.length) return 'safe';
    if (strict) return 'blocked';
    return tripped.some((id) => POLICIES.find((p) => p.id === id).sev === 'blocked') ? 'blocked' : 'review';
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

    const tabs = [
      ['pipeline', 'Pipeline'], ['preflight', 'Pre-flight'], ['trace', 'Live trace'],
      ['chaos', 'Failure lab'], ['evals', 'Evals'],
    ].map(([id, label]) => ({
      label, go: () => this.goTab(id),
      border: st.tab === id ? 'var(--color-accent)' : 'transparent',
      color: st.tab === id ? 'var(--color-accent-700)' : 'var(--color-neutral-700)',
    }));

    // ---- pre-flight --------------------------------------------------------
    const actions = this.rehearsed.map((a) => {
      const d = st.decisions[a.id];
      const v = d === 'blocked' ? 'blocked' : d === 'approved' ? 'safe' : this.verdictOf(a);
      return {
        ...a, vc: V[v],
        verdictLabel: d === 'approved' ? 'approved' : d === 'blocked' ? 'blocked by you' : LABEL[v],
        cardBorder: st.selId === a.id ? 'var(--color-accent)' : 'var(--color-divider)',
        cardBg: st.selId === a.id ? 'var(--color-accent-100)' : 'transparent',
        classColor: CLASS_COLOR[a.reversibility],
        select: () => this.setState({ selId: a.id }),
      };
    });
    const sel = actions.find((a) => a.id === st.selId) || actions[0];

    const selChecks = POLICIES.map((p) => {
      const on = st.policyOn[p.id];
      const trips = sel.trips.includes(p.id);
      const sev = strict ? 'blocked' : p.sev;
      return {
        name: p.name, rule: p.rule,
        state: !on ? 'off' : trips ? (sev === 'blocked' ? 'violated' : 'flagged') : 'clear',
        reason: trips && on ? (sel.reasons[p.id] || []).join(' · ') : '',
        color: !on ? 'var(--color-neutral-500)' : trips ? V[sev] : 'var(--color-neutral-700)',
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
      return this.verdictOf(a) !== 'safe';
    }).length;

    // ---- trace -------------------------------------------------------------
    const t = traceFor(st.crm, st.build);
    const spans = t.spans.map((s) => ({
      ...s, left: s.left + '%', width: s.width + '%',
      bar: s.status === 'ok' ? 'var(--color-neutral-700)' : 'var(--color-accent)',
      color: s.status === 'ok' ? 'var(--color-neutral-600)' : 'var(--color-accent-700)',
      caret: st.openSpans[s.id] ? '▾' : '▸',
      open: !!st.openSpans[s.id],
      classColor: s.cls ? CLASS_COLOR[s.cls] : 'var(--color-neutral-600)',
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
      `. ${faultDef.note} The agent's own retry policy decides what happens next; AgentGuard reports whether the ` +
      `account ended up where it should have, and what a rollback could not reach.`;

    const modifiers = MODIFIERS.map((m) => ({
      label: m.label,
      mark: st.mods[m.id] ? 'var(--color-accent)' : 'var(--color-neutral-400)',
      fill: st.mods[m.id] ? 'var(--color-accent)' : 'transparent',
      text: st.mods[m.id] ? 'var(--color-text)' : 'var(--color-neutral-700)',
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
      color: r.candidate.pass ? 'var(--color-neutral-700)' : 'var(--color-accent-800)',
      tagColor: r.regressed ? 'var(--color-accent-800)' : 'var(--color-neutral-600)',
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

    return {
      tabs, adapter,
      crm: st.crm, setCrm: this.setCrm, crms: ADAPTERS,
      build: st.build, buildLabel: this.buildObj.label,
      setBuild: (e) => this.setState({ build: e.target.value, chaos: 'idle', chaosLog: [], rollback: 'none' }),
      fleet: `${actions.length} mutations proposed · ${heldCount} held`,

      onPipeline: st.tab === 'pipeline', onPreflight: st.tab === 'preflight',
      onTrace: st.tab === 'trace', onChaos: st.tab === 'chaos', onEvals: st.tab === 'evals',

      stages: STAGE_DEFS.map((s) => ({ ...s, go: () => this.goTab(s.tab) })),
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
        color: i.ok ? 'var(--color-neutral-700)' : 'var(--color-accent-800)',
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
        note: `${suite.results.length} recorded cases replayed against ${suite.candidate.label} on ${ADAPTERS.length} CRMs. ${n} regress on ${suite.adapter.label}, and every one of them writes something no rollback can reach — so the candidate stays behind the canary with every mutation still pre-flighted.`,
        badge: `${n} regressions · rollout held at 10%`,
        outlook: 'Rollout stays held until the suite is green or the merge threshold is put back.',
      },
      promoted: {
        status: 'promoted to 100%', color: 'var(--color-accent-800)',
        note: `${suite.candidate.label} is now the default build for all pipeline traffic. The ${n} failing cases were accepted with an amended policy; AgentGuard will hold any run that trips it and page the account owner.`,
        badge: `${n} regressions · rolled out to 100%`,
        outlook: 'The failures were accepted with an amended policy, so any run that trips it is held and the owner paged.',
      },
      blocked: {
        status: `blocked · rolled back to ${suite.baseline.id}`, color: 'var(--color-accent-800)',
        note: `${suite.candidate.label} is withdrawn from the canary and ${suite.baseline.id} restored. The candidate keeps receiving shadow traffic, so the suite continues to fill without any production exposure.`,
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
      page: css(`height:100vh;display:flex;flex-direction:column;background:var(--color-bg);font-family:var(--font-body)`),
      head: css(`display:flex;align-items:center;justify-content:space-between;gap:18.4px;padding:14px 27.6px;border-bottom:1px solid var(--color-divider);flex:none`),
      kicker: css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)`),
      eyebrow: css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);border-bottom:1px solid var(--color-divider);padding-bottom:6px`),
      h1: css(`font-family:var(--font-heading);font-weight:400;font-size:36px;margin:4.6px 0 0;line-height:1.1`),
      body: css(`font-size:14px;line-height:1.7;text-align:justify;max-width:66ch;margin:11px 0 0;color:var(--color-neutral-800)`),
      btn: css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-accent);color:var(--color-accent-700);background:transparent;border-radius:var(--radius-md);cursor:pointer`),
      btn2: css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-neutral-400);color:var(--color-neutral-800);background:transparent;border-radius:var(--radius-md);cursor:pointer`),
      sel: css(`font-family:var(--font-body);font-size:13px;padding:7px 9.2px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:transparent;color:var(--color-text)`),
      lab: css(`font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)`),
      pre: css(`margin:0;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.7;background:var(--color-neutral-100);border:1px solid var(--color-divider);border-radius:var(--radius-md);padding:11px;white-space:pre-wrap;color:var(--color-neutral-800);overflow:auto`),
      card: css(`border:1px solid var(--color-accent);border-radius:var(--radius-md);padding:18.4px`),
      th: css(`text-align:left;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`),
      td: css(`padding:11px 6px;border-bottom:1px solid var(--color-divider)`),
    };

    return (
      <div style={S.page}>
        <header style={S.head}>
          <div style={css(`display:flex;align-items:baseline;gap:18.4px`)}>
            {/* A real anchor rather than a click handler, so the wordmark
                behaves like a home link: keyboard-focusable, middle-clickable,
                and it creates a history entry on its own. */}
            <a href="#pipeline" aria-label="AgentGuard — back to the pipeline"
              style={css(`font-family:var(--font-heading);font-size:23px;color:inherit;text-decoration:none;cursor:pointer`)}>
              AgentGuard
            </a>
            <span style={css(`font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
              revenue-ops · {v.buildLabel} · staging
            </span>
          </div>

          <nav style={css(`display:flex;gap:4.6px`)}>
            {v.tabs.map((t, i) => (
              <button key={i} className="hv0" onClick={t.go}
                style={css(`font-family:var(--font-body);font-size:12.5px;padding:7px 13.8px;border-radius:var(--radius-md);cursor:pointer;background:transparent;border:1px solid ${t.border};color:${t.color}`)}>
                {t.label}
              </button>
            ))}
          </nav>

          <div style={css(`display:flex;align-items:center;gap:9.2px;font-size:12px;color:var(--color-neutral-700)`)}>
            <select value={v.crm} onChange={v.setCrm} aria-label="CRM" style={S.sel}>
              {v.crms.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <select value={v.build} onChange={v.setBuild} aria-label="Agent build" style={S.sel}>
              <option value="v1.8">v1.8 — current</option>
              <option value="v1.9">v1.9 — candidate</option>
            </select>
            <span style={css(`width:7px;height:7px;border-radius:50%;background:var(--color-accent);animation:ag-pulse 2s infinite`)} />
            <span style={css(`white-space:nowrap`)}>{v.fleet}</span>
          </div>
        </header>

        {/* ---- Pipeline ---------------------------------------------------- */}
        {v.onPipeline && (
          <div style={css(`flex:1;min-height:0;overflow:auto;padding:22px 27.6px 36.8px`)}>
            <div style={css(`max-width:1120px;margin:0 auto`)}>
              <div style={S.kicker}>Interception path</div>
              <h1 style={css(`font-family:var(--font-heading);font-weight:400;font-size:38px;margin:4.6px 0 0;line-height:1.1`)}>
                Nothing reaches the CRM unrehearsed.
              </h1>
              <p style={S.body}>
                AgentGuard sits between an agent's proposed mutations and the CRM that would make them real. Every
                mutation is rehearsed against an isolated copy of the account, measured as a state diff, judged against
                policy, and only then executed — under an idempotency key, with a compensating plan behind it. The
                layer speaks one normalized vocabulary, so the same workflows and the same reliability tests run
                against HubSpot, Salesforce and Attio.
              </p>

              <div style={css(`display:grid;grid-template-columns:230px 1fr;gap:27.6px;margin-top:27.6px;align-items:start`)}>
                <div style={css(`display:flex;flex-direction:column`)}>
                  {[
                    ['Upstream', 'User request', null],
                    ['Planner', 'AI agent', null],
                    ['Held at the gate', `${v.actions.length} proposed mutations`, true],
                    ['Normalized layer', 'AgentGuard', null],
                    ['Execution & auth', 'Composio', 'sessions · connections · tool calls'],
                  ].map(([kick, name, note], i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <span style={css(`height:20px;width:1px;background:var(--color-divider);margin:0 auto`)} />}
                      <div style={css(`border:1px solid ${note === true ? 'var(--color-accent)' : 'var(--color-divider)'};border-radius:var(--radius-md);padding:11px 13.8px`)}>
                        <div style={css(`font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${note === true ? 'var(--color-accent-700)' : 'var(--color-neutral-600)'}`)}>{kick}</div>
                        <div style={css(`font-family:var(--font-heading);font-size:19px;margin-top:2px`)}>{name}</div>
                        {typeof note === 'string' && (
                          <div style={css(`font-size:11.5px;line-height:1.5;color:var(--color-neutral-700);margin-top:2px`)}>{note}</div>
                        )}
                      </div>
                    </React.Fragment>
                  ))}
                  <span style={css(`height:20px;width:1px;background:var(--color-divider);margin:0 auto`)} />
                  <div style={css(`display:grid;grid-template-columns:repeat(3,1fr);gap:6px`)}>
                    {v.capabilities.map((c, i) => (
                      <div key={i} style={css(`border:1px ${c.current ? 'solid var(--color-accent)' : 'dashed var(--color-neutral-400)'};border-radius:var(--radius-md);padding:8px 4px;text-align:center;font-size:11.5px;color:var(--color-neutral-700)`)}>
                        {c.label}
                      </div>
                    ))}
                  </div>
                </div>

                <div style={S.card}>
                  <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:13.8px;border-bottom:1px solid var(--color-divider);padding-bottom:9.2px`)}>
                    <span style={css(`font-family:var(--font-heading);font-size:22px`)}>AgentGuard</span>
                    <span style={css(`font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                      {v.adapter.label} · 8 stages
                    </span>
                  </div>
                  {v.stages.map((s, i) => (
                    <div key={i} className="hv0" onClick={s.go}
                      style={css(`cursor:pointer;display:grid;grid-template-columns:30px 1fr;gap:13.8px;align-items:baseline;padding:9.2px 6px;border-bottom:1px solid var(--color-divider)`)}>
                      <span style={css(`font-family:var(--font-heading);font-size:17px;color:var(--color-accent-700)`)}>{s.n}</span>
                      <span>
                        <span style={css(`font-family:var(--font-heading);font-size:18px;display:block`)}>{s.name}</span>
                        <span style={css(`font-size:12.5px;line-height:1.5;color:var(--color-neutral-700);display:block;margin-top:1px`)}>{s.note}</span>
                      </span>
                    </div>
                  ))}
                  <div style={css(`font-size:11.5px;line-height:1.7;color:var(--color-neutral-600);padding-top:11px`)}>
                    Each stage opens the screen where it is worked. Stages 1–4 never touch a production CRM.
                  </div>
                </div>
              </div>

              <div style={css(`margin-top:27.6px`)}>
                <div style={S.eyebrow}>What the adapters disagree about</div>
                <p style={css(`font-size:13px;line-height:1.7;color:var(--color-neutral-700);margin:9.2px 0 0;max-width:80ch`)}>
                  An agent that is safe on one CRM is not automatically safe on another. These are the differences the
                  policy engine and the recovery planner read, rather than assume.
                </p>
                <table style={css(`width:100%;border-collapse:collapse;margin-top:13.8px;font-size:13px`)}>
                  <thead><tr>
                    {['CRM', 'Lead object', 'Delete', 'Merge', 'Stages it cannot tell apart'].map((h, i) => (
                      <th key={i} style={S.th}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {v.capabilities.map((c, i) => (
                      <tr key={i}>
                        <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);color:${c.current ? 'var(--color-accent-700)' : 'var(--color-text)'}`)}>{c.label}</td>
                        <td style={S.td}>{c.lead}</td>
                        <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);color:${c.delColor}`)}>{c.del}</td>
                        <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);color:var(--color-accent-800)`)}>{c.merge}</td>
                        <td style={S.td}>{c.collapsed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ---- Pre-flight -------------------------------------------------- */}
        {v.onPreflight && (
          <div style={css(`flex:1;min-height:0;display:flex;flex-direction:column`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;gap:27.6px;padding:18.4px 27.6px 13.8px`)}>
              <div>
                <div style={S.kicker}>Pre-flight review · {v.adapter.label}</div>
                <h1 style={S.h1}>“{GOAL}” became {v.actions.length} real mutations.</h1>
              </div>
              <div style={css(`display:flex;gap:13.8px;align-items:center`)}>
                {v.simIdle && <button className="hv0" onClick={v.runSim} style={S.btn}>Run shadow execution</button>}
                {v.simRunning && (
                  <span style={css(`font-size:13px;color:var(--color-accent-700);display:flex;align-items:center;gap:9.2px`)}>
                    <span style={css(`width:80px;height:2px;background:var(--color-accent-200);overflow:hidden;display:inline-block`)}>
                      <span style={css(`display:block;width:30%;height:100%;background:var(--color-accent);animation:ag-sweep 1s linear infinite`)} />
                    </span>
                    rehearsing against a shadow account…
                  </span>
                )}
                {v.simDone && (
                  <span style={css(`font-size:12.5px;color:var(--color-neutral-700)`)}>shadow run complete · no side effects</span>
                )}
              </div>
            </div>

            <div style={css(`flex:1;min-height:0;display:grid;grid-template-columns:340px 1fr 280px;border-top:1px solid var(--color-divider)`)}>
              <div style={css(`border-right:1px solid var(--color-divider);overflow:auto;padding:13.8px`)}>
                {v.actions.map((a, i) => (
                  <div key={i} className="hv0" onClick={a.select}
                    style={css(`cursor:pointer;padding:11px 13.8px;margin-bottom:9.2px;border:1px solid ${a.cardBorder};border-left:3px solid ${a.vc};border-radius:var(--radius-md);background:${a.cardBg}`)}>
                    <div style={css(`display:flex;justify-content:space-between;align-items:baseline;gap:9.2px`)}>
                      <span style={css(`font-family:var(--font-heading);font-size:17px;font-weight:600`)}>{a.op}</span>
                      <span style={css(`font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${a.vc};white-space:nowrap`)}>{a.verdictLabel}</span>
                    </div>
                    <div style={css(`font-size:12.5px;line-height:1.5;color:var(--color-neutral-700);margin-top:2px`)}>{a.summary}</div>
                    <div style={css(`font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:${a.classColor};margin-top:4px`)}>{a.reversibility}</div>
                  </div>
                ))}
                <div style={css(`font-size:11.5px;line-height:1.6;color:var(--color-neutral-600);border-top:1px solid var(--color-divider);padding-top:9.2px;margin-top:13.8px`)}>
                  Every proposed mutation from one agent turn. Nothing here has run.
                </div>
              </div>

              <div style={css(`overflow:auto;padding:22px 27.6px`)}>
                <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:18.4px`)}>
                  <h2 style={css(`font-family:var(--font-heading);font-weight:400;font-size:28px;margin:0`)}>{v.sel.op}</h2>
                  <span style={css(`font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${v.sel.vc};border:1px solid ${v.sel.vc};padding:3px 9.2px;border-radius:var(--radius-md);white-space:nowrap`)}>
                    {v.sel.verdictLabel}
                  </span>
                </div>
                <p style={css(`font-size:14px;line-height:1.7;text-align:justify;margin:9.2px 0 0;max-width:64ch`)}>{v.sel.detail}</p>

                {v.hasRisk && (
                  <div style={css(`margin-top:13.8px;border:1px solid var(--color-accent);border-left:3px solid var(--color-accent);border-radius:var(--radius-md);padding:13.8px 18.4px;max-width:64ch;animation:ag-in .3s ease both`)}>
                    <div style={css(`font-family:var(--font-heading);font-size:19px;color:var(--color-accent-800)`)}>{v.sel.risk}</div>
                    <p style={css(`font-size:13px;line-height:1.7;margin:4.6px 0 0;color:var(--color-neutral-800)`)}>{v.sel.alt}</p>
                  </div>
                )}

                {v.simDone && (
                  <div style={css(`margin-top:22px`)}>
                    <div style={S.eyebrow}>State diff — predicted</div>
                    {v.selDiff.map((d, i) => (
                      <div key={i} style={css(`display:grid;grid-template-columns:200px 1fr 1fr;gap:13.8px;padding:9.2px 0;border-bottom:1px solid var(--color-divider);font-size:13px;animation:ag-in .3s ease both`)}>
                        <span style={css(`color:var(--color-neutral-700);font-family:ui-monospace,Menlo,monospace;font-size:11.5px`)}>{d.field}</span>
                        <span style={css(`color:var(--color-neutral-600);text-decoration:line-through`)}>{d.before}</span>
                        <span style={css(`color:var(--color-accent-800)`)}>{d.after}</span>
                      </div>
                    ))}
                    <div style={css(`font-size:11.5px;color:var(--color-neutral-600);margin-top:9.2px`)}>{v.sel.blast}</div>
                    <div style={css(`margin-top:11px`)}>
                      <div style={S.eyebrow}>Native requests on {v.adapter.label}</div>
                      {v.sel.native.map((n, i) => (
                        <div key={i} style={css(`font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--color-neutral-700);padding:5px 0`)}>{n}</div>
                      ))}
                    </div>
                  </div>
                )}
                {v.simNotDone && (
                  <div style={css(`margin-top:22px;border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:36.8px;text-align:center;font-size:13px;color:var(--color-neutral-600)`)}>
                    No diff yet — run the shadow execution to predict what changes.
                  </div>
                )}

                <div style={css(`margin-top:22px`)}>
                  <div style={S.eyebrow}>Policy verdict</div>
                  {v.selChecks.map((c, i) => (
                    <div key={i} style={css(`padding:8px 0;border-bottom:1px solid var(--color-divider);font-size:13px`)}>
                      <div style={css(`display:flex;justify-content:space-between;align-items:baseline;gap:9.2px`)}>
                        <span style={css(`color:${c.color}`)}>{c.name}</span>
                        <span style={css(`font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${c.color};white-space:nowrap`)}>{c.state}</span>
                      </div>
                      {c.reason && (
                        <div style={css(`font-size:11.5px;color:var(--color-accent-800);margin-top:2px`)}>{c.reason}</div>
                      )}
                    </div>
                  ))}
                </div>

                <div style={css(`display:flex;gap:9.2px;margin-top:22px;align-items:center;flex-wrap:wrap`)}>
                  <button className="hv0" onClick={v.approve} style={S.btn}>Approve &amp; execute</button>
                  <button className="hv1" onClick={v.block} style={S.btn2}>Block</button>
                  <span style={css(`font-size:12.5px;color:var(--color-accent-700)`)}>{v.decisionNote}</span>
                </div>
              </div>

              <div style={css(`border-left:1px solid var(--color-divider);padding:22px 18.4px;overflow:auto`)}>
                <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:11px`)}>Active policies</div>
                {v.policies.map((p, i) => (
                  <div key={i} onClick={p.toggle} style={css(`cursor:pointer;display:flex;gap:9.2px;align-items:flex-start;padding:9.2px 0;border-bottom:1px solid var(--color-divider)`)}>
                    <span style={css(`flex:none;margin-top:4px;width:12px;height:12px;border-radius:2px;border:1px solid ${p.mark};background:${p.fill}`)} />
                    <span>
                      <span style={css(`font-size:12.5px;line-height:1.45;display:block;color:${p.text}`)}>{p.name}</span>
                      <span style={css(`font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)`)}>{p.mode}</span>
                    </span>
                  </div>
                ))}
                <p style={css(`font-size:11.5px;line-height:1.7;color:var(--color-neutral-600);margin-top:13.8px`)}>
                  Toggling a policy re-evaluates every queued mutation against the rehearsal it already produced — no
                  re-run needed, because nothing but the predicate was ever asserting the mutation was bad.
                </p>

                <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);margin:22px 0 9.2px;border-top:1px solid var(--color-divider);padding-top:13.8px`)}>
                  Invariants, if all {v.actions.length} ran
                </div>
                {v.invariants.map((i, k) => (
                  <div key={k} style={css(`padding:5px 0`)}>
                    <div style={css(`display:flex;gap:9.2px;align-items:baseline`)}>
                      <span style={css(`font-size:12px;color:${i.color};flex:none`)}>{i.mark}</span>
                      <span style={css(`font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;color:${i.color}`)}>{i.expr}</span>
                    </div>
                    {i.detail && <div style={css(`font-size:11px;color:var(--color-accent-800);margin-left:21px`)}>{i.detail}</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---- Live trace -------------------------------------------------- */}
        {v.onTrace && (
          <div style={css(`flex:1;min-height:0;display:flex;flex-direction:column`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;padding:18.4px 27.6px 13.8px`)}>
              <div>
                <div style={S.kicker}>Live trace · {v.buildLabel} on {v.adapter.label}</div>
                <h1 style={S.h1}>{v.traceHeadline}</h1>
              </div>
              <button className="hv0" onClick={v.rollback} style={S.btn}>{v.rollbackLabel}</button>
            </div>
            <div style={css(`flex:1;min-height:0;overflow:auto;border-top:1px solid var(--color-divider);padding:18.4px 27.6px`)}>
              {v.spans.map((s, i) => (
                <div key={i} style={css(`border-bottom:1px solid var(--color-divider)`)}>
                  <div className="hv0" onClick={s.toggle}
                    style={css(`cursor:pointer;display:grid;grid-template-columns:20px 230px 1fr 80px 110px;align-items:center;gap:13.8px;padding:9.2px 4px`)}>
                    <span style={css(`font-size:11px;color:var(--color-neutral-600)`)}>{s.caret}</span>
                    <span style={css(`font-family:var(--font-heading);font-size:16px`)}>{s.name}</span>
                    <span style={css(`height:6px;background:var(--color-neutral-200);border-radius:3px;position:relative;display:block`)}>
                      <span style={css(`position:absolute;top:0;bottom:0;left:${s.left};width:${s.width};background:${s.bar};border-radius:3px`)} />
                    </span>
                    <span style={css(`font-size:12px;text-align:right;color:var(--color-neutral-700)`)}>{s.ms}</span>
                    <span style={css(`font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;text-align:right;color:${s.color}`)}>{s.status}</span>
                  </div>
                  {s.open && (
                    <div style={css(`padding:0 4px 18.4px 38px;animation:ag-in .25s ease both`)}>
                      {s.native && (
                        <div style={css(`display:flex;gap:13.8px;align-items:baseline;margin-bottom:9.2px`)}>
                          <span style={css(`font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--color-accent-700)`)}>{s.native}</span>
                          <span style={css(`font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${s.classColor}`)}>{s.cls}</span>
                        </div>
                      )}
                      <div style={css(`display:grid;grid-template-columns:1fr 1fr;gap:18.4px`)}>
                        <div>
                          <div style={css(`font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:6px`)}>Arguments</div>
                          <pre style={S.pre}>{s.args}</pre>
                        </div>
                        <div>
                          <div style={css(`font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:6px`)}>Result</div>
                          <pre style={S.pre}>{s.result}</pre>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {v.rolledBack && (
                <div style={css(`margin-top:18.4px;border:1px solid var(--color-accent);border-radius:var(--radius-md);padding:18.4px;animation:ag-in .3s ease both`)}>
                  <div style={css(`font-family:var(--font-heading);font-size:20px;margin-bottom:4.6px`)}>
                    Compensating plan — rebuilt from the audit log
                  </div>
                  <p style={css(`font-size:12.5px;line-height:1.7;color:var(--color-neutral-700);margin:0 0 11px`)}>
                    {v.sagaUnrecoverable
                      ? `${v.sagaUnrecoverable} of these steps have no inverse on ${v.adapter.label}. Applying this plan is a partial rollback plus an incident, not a restore.`
                      : `Every step has an inverse on ${v.adapter.label}. Applying this plan restores the checkpoint exactly.`}
                  </p>
                  <div style={css(`display:grid;grid-template-columns:280px 120px 1fr;gap:13.8px;padding-bottom:6px;border-bottom:1px solid var(--color-divider);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                    <span>Write</span><span>Reversibility</span><span>Compensating action</span>
                  </div>
                  {v.saga.map((g, i) => (
                    <div key={i} style={css(`display:grid;grid-template-columns:280px 120px 1fr;gap:13.8px;padding:8px 0;border-bottom:1px solid var(--color-divider);font-size:12.5px;align-items:baseline`)}>
                      <span style={css(`color:${g.color};font-family:ui-monospace,Menlo,monospace;font-size:11.5px`)}>{g.step}</span>
                      <span style={css(`font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:${g.color}`)}>{g.state}</span>
                      <span style={css(`color:var(--color-neutral-700);line-height:1.5`)}>{g.undo}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---- Failure lab ------------------------------------------------- */}
        {v.onChaos && (
          <div style={css(`flex:1;min-height:0;display:grid;grid-template-columns:320px 1fr`)}>
            <div style={css(`border-right:1px solid var(--color-divider);padding:22px 18.4px;overflow:auto;display:flex;flex-direction:column;gap:18.4px`)}>
              <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600)`)}>Inject failure</div>

              <label style={css(`display:flex;flex-direction:column;gap:4.6px`)}>
                <span style={S.lab}>Recorded run</span>
                <select value={v.caseId} onChange={v.setCase} style={S.sel}>
                  {v.allCases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>

              <label style={css(`display:flex;flex-direction:column;gap:4.6px`)}>
                <span style={S.lab}>Fault</span>
                <select value={v.fault} onChange={v.setFault} style={S.sel}>
                  {v.faults.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}{f.transient ? '' : ' — permanent'}</option>
                  ))}
                </select>
              </label>

              <label style={css(`display:flex;flex-direction:column;gap:4.6px`)}>
                <span style={S.lab}>At operation</span>
                <select value={v.op} onChange={v.setOp} style={S.sel}>
                  {v.points.map((p) => <option key={p.op} value={p.op}>{p.label}</option>)}
                </select>
              </label>

              <div style={css(`display:flex;flex-direction:column;gap:9.2px;border-top:1px solid var(--color-divider);padding-top:13.8px`)}>
                {v.modifiers.map((m, i) => (
                  <div key={i} onClick={m.toggle} style={css(`cursor:pointer;display:flex;gap:9.2px;align-items:flex-start`)}>
                    <span style={css(`flex:none;margin-top:3px;width:12px;height:12px;border-radius:2px;border:1px solid ${m.mark};background:${m.fill}`)} />
                    <span style={css(`font-size:12.5px;line-height:1.45;color:${m.text}`)}>{m.label}</span>
                  </div>
                ))}
              </div>

              <button className="hv0" onClick={v.inject} style={S.btn}>{v.injectLabel}</button>
              <div style={css(`font-size:11.5px;line-height:1.7;color:var(--color-neutral-600);border-top:1px solid var(--color-divider);padding-top:11px`)}>
                Injected against a shadow account only. No production CRM is ever touched.
              </div>
            </div>

            <div style={css(`padding:22px 27.6px;overflow:auto`)}>
              <div style={S.kicker}>Failure lab</div>
              <h1 style={S.h1}>Break it here, not in the pipeline.</h1>
              <p style={css(`font-size:14px;line-height:1.7;max-width:66ch;margin:13.8px 0 0;text-align:justify`)}>{v.experimentLine}</p>

              {v.chaosDone && (
                <div style={css(`margin-top:22px;border:1px solid ${v.verdict.border};border-radius:var(--radius-md);padding:18.4px;animation:ag-in .3s ease both`)}>
                  <div style={css(`font-family:var(--font-heading);font-size:24px;color:${v.verdict.color}`)}>{v.verdict.headline}</div>
                  <div style={css(`display:grid;grid-template-columns:repeat(4,1fr);gap:18.4px;margin-top:13.8px`)}>
                    {v.verdict.checks.map((c, i) => (
                      <div key={i} style={css(`border-top:1px solid var(--color-divider);padding-top:9.2px`)}>
                        <div style={css(`font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>{c.label}</div>
                        <div style={css(`font-size:15px;font-family:var(--font-heading);color:${c.color};margin-top:3px`)}>{c.value}</div>
                        <div style={css(`font-size:11.5px;line-height:1.5;color:var(--color-neutral-700);margin-top:2px`)}>{c.note}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {v.chaosDone && v.proposal && (
                <div style={css(`margin-top:18.4px;border:1px solid var(--color-divider);border-left:3px solid var(--color-accent);border-radius:var(--radius-md);padding:13.8px 18.4px;animation:ag-in .3s ease both`)}>
                  <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:13.8px;flex-wrap:wrap`)}>
                    <span style={css(`font-family:var(--font-heading);font-size:19px`)}>
                      {v.proposal.novel ? 'This failure is not in the suite' : `Already covered by ${v.proposal.covered}`}
                    </span>
                    <button className="hv1" onClick={v.toggleSource} style={css(`font-family:var(--font-body);font-size:12px;padding:5px 13.8px;border:1px solid var(--color-neutral-400);color:var(--color-neutral-800);background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                      {v.showSource ? 'Hide case' : 'Show generated case'}
                    </button>
                  </div>
                  <p style={css(`font-size:12.5px;line-height:1.7;color:var(--color-neutral-800);margin:4.6px 0 0`)}>
                    {v.proposal.why}. Minimised to {v.proposal.reduction.kept} of {v.proposal.reduction.from} records —
                    the smallest account that still reproduces it.
                  </p>
                  {v.showSource && <pre style={css(`margin:11px 0 0;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;background:var(--color-neutral-100);border:1px solid var(--color-divider);border-radius:var(--radius-md);padding:11px;max-height:320px;overflow:auto;color:var(--color-neutral-800)`)}>{v.proposal.source}</pre>}
                </div>
              )}

              <div style={css(`margin-top:22px;border-top:1px solid var(--color-divider)`)}>
                {v.chaosLog.map((l, i) => (
                  <div key={i} style={css(`display:grid;grid-template-columns:70px 1fr;gap:18.4px;padding:7px 0;border-bottom:1px solid var(--color-divider);animation:ag-in .3s ease both`)}>
                    <span style={css(`font-size:12px;color:var(--color-neutral-600)`)}>{l.t}</span>
                    <span style={css(`font-size:13px;line-height:1.5;color:${l.color}`)}>{l.text}</span>
                  </div>
                ))}
              </div>

              {v.chaosIdle && (
                <div style={css(`margin-top:18.4px;border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:36.8px;text-align:center;font-size:13px;color:var(--color-neutral-600)`)}>
                  Pick a fault and inject it to watch the recovery path.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---- Evals ------------------------------------------------------- */}
        {v.onEvals && (
          <div style={css(`flex:1;min-height:0;overflow:auto;padding:22px 27.6px`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;gap:18.4px`)}>
              <div>
                <div style={S.kicker}>Replay &amp; evals · {v.adapter.label}</div>
                <h1 style={S.h1}>{v.cases.length} recorded cases, replayed against v1.9.</h1>
              </div>
              <span style={css(`font-size:12.5px;color:${v.gate.color};border:1px solid var(--color-accent);padding:6px 13.8px;border-radius:var(--radius-md);white-space:nowrap`)}>
                {v.gate.badge}
              </span>
            </div>

            <div style={css(`display:grid;grid-template-columns:repeat(5,1fr);gap:0;margin-top:22px;border-top:1px solid var(--color-text)`)}>
              {v.metrics.map((m, i) => (
                <div key={i} style={css(`padding:13.8px 13.8px 13.8px 0;border-right:1px solid var(--color-divider)`)}>
                  <div style={css(`font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>{m.label}</div>
                  <div style={css(`display:flex;align-items:baseline;gap:6px;margin-top:6px`)}>
                    <span style={css(`font-size:13px;color:var(--color-neutral-500);text-decoration:line-through`)}>{m.old}</span>
                    <span style={css(`font-family:var(--font-heading);font-size:21px;color:${m.color}`)}>{m.cand}</span>
                    <span style={css(`font-size:12px;color:var(--color-accent-800)`)}>{m.mark}</span>
                  </div>
                </div>
              ))}
            </div>
            <p style={css(`font-size:12px;line-height:1.6;color:var(--color-neutral-600);margin:9.2px 0 0`)}>
              v1.8 struck through, v1.9 in front. The candidate completes more runs than the current build — it stops
              abandoning them at the first hard failure — and that is the same change that makes it wrong more often.
            </p>

            <table style={css(`width:100%;border-collapse:collapse;margin-top:22px;font-size:13.5px`)}>
              <thead><tr>
                <th style={S.th}>Recorded case</th>
                <th style={S.th}>Injected fault</th>
                <th style={css(`text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`)}>v1.8</th>
                <th style={css(`text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`)}>v1.9</th>
                <th style={css(`text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`)}>Δ latency</th>
                <th style={S.th}></th>
              </tr></thead>
              <tbody>
                {v.cases.map((c, i) => (
                  <tr key={i} onClick={c.open} style={css(`cursor:pointer;background:${c.bg}`)}>
                    <td style={S.td}>{c.caret} {c.name}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);color:var(--color-neutral-700);font-size:12.5px`)}>{c.fault}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);text-align:right;color:var(--color-neutral-700)`)}>{c.base}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);text-align:right;color:${c.color}`)}>{c.cand}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);text-align:right;color:var(--color-neutral-700)`)}>{c.delta}</td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${c.tagColor}`)}>{c.tag}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {v.portability.length > 0 && (
              <div style={css(`margin-top:18.4px;border-left:3px solid var(--color-accent);padding:11px 18.4px;background:var(--color-accent-100);border-radius:var(--radius-md)`)}>
                <div style={css(`font-family:var(--font-heading);font-size:18px`)}>Not a build regression — a CRM one</div>
                {v.portability.map((p, i) => (
                  <p key={i} style={css(`font-size:12.5px;line-height:1.7;color:var(--color-neutral-800);margin:4.6px 0 0`)}>
                    “{p.name}” fails on {v.adapter.label} for both builds, at {p.field}. Promoting or blocking v1.9
                    changes nothing here; the pipeline mapping does.
                  </p>
                ))}
              </div>
            )}

            {v.compareOpen && (
              <div style={css(`margin-top:27.6px;border-top:1px solid var(--color-text);padding-top:18.4px;animation:ag-in .3s ease both`)}>
                <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:18.4px`)}>
                  <h2 style={css(`font-family:var(--font-heading);font-weight:400;font-size:26px;margin:0`)}>{v.compare.name}</h2>
                  <span style={css(`font-size:12px;color:var(--color-neutral-700)`)}>{v.compare.summary}</span>
                </div>
                <p style={css(`font-size:13px;line-height:1.7;color:var(--color-neutral-700);margin:4.6px 0 0;max-width:80ch`)}>{v.compare.note}</p>

                <div style={css(`display:grid;grid-template-columns:1fr 1fr;gap:27.6px;margin-top:13.8px`)}>
                  {[['v1.8 — current', v.compare.left, 'var(--color-neutral-600)'], ['v1.9 — candidate', v.compare.right, 'var(--color-accent-700)']].map(([title, rows, tint], k) => (
                    <div key={k}>
                      <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:${tint};border-bottom:1px solid var(--color-divider);padding-bottom:6px`)}>{title}</div>
                      {rows.map((r, i) => (
                        <div key={i} style={css(`display:flex;justify-content:space-between;gap:9.2px;font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--color-divider);color:${r.color}`)}>
                          <span style={css(`font-family:ui-monospace,Menlo,monospace;font-size:11.5px`)}>{r.step}</span>
                          <span style={css(`color:var(--color-neutral-600)`)}>{r.meta}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {v.compare.misses.length > 0 && (
                  <div style={css(`margin-top:13.8px`)}>
                    <div style={S.eyebrow}>Where the account ended up wrong</div>
                    {v.compare.misses.map((m, i) => (
                      <div key={i} style={css(`display:grid;grid-template-columns:240px 1fr 1fr;gap:13.8px;padding:7px 0;border-bottom:1px solid var(--color-divider);font-size:12.5px`)}>
                        <span style={css(`font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--color-neutral-700)`)}>{m.field}</span>
                        <span style={css(`color:var(--color-accent-800)`)}>got {m.got}</span>
                        <span style={css(`color:var(--color-neutral-600)`)}>want {m.want}</span>
                      </div>
                    ))}
                  </div>
                )}

                <p style={css(`font-size:13px;line-height:1.7;color:var(--color-accent-800);margin:13.8px 0 0;max-width:82ch`)}>{v.compare.verdict}</p>
              </div>
            )}

            <div style={css(`margin-top:27.6px`)}>
              <div style={S.eyebrow}>Generated regression tests</div>
              <p style={css(`font-size:13px;line-height:1.7;color:var(--color-neutral-700);margin:9.2px 0 0;max-width:80ch`)}>
                {v.proposals.length} failures analysed and minimised into candidate cases. {v.novel === 0
                  ? 'None of them need a new case — the suite already pins every one, which is the answer a generator should give when it is true.'
                  : `${v.novel} are not pinned by any existing case.`} Break something new in the failure lab and a
                proposal for it appears there.
              </p>
              {v.proposals.slice(0, 4).map((p, i) => (
                <div key={i} style={css(`display:grid;grid-template-columns:100px 1fr 150px;gap:13.8px;padding:9.2px 0;border-bottom:1px solid var(--color-divider);font-size:12.5px;align-items:baseline`)}>
                  <span style={css(`font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:${p.novel ? 'var(--color-accent-800)' : 'var(--color-neutral-600)'}`)}>
                    {p.novel ? 'new case' : `covered · ${p.covered}`}
                  </span>
                  <span style={css(`color:var(--color-neutral-800);line-height:1.5`)}>{p.why}</span>
                  <span style={css(`color:var(--color-neutral-600);text-align:right`)}>{p.reduction.kept} of {p.reduction.from} records</span>
                </div>
              ))}
            </div>

            <div style={css(`margin-top:27.6px;border:1px solid var(--color-accent);border-radius:var(--radius-md);padding:18.4px`)}>
              <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:18.4px;flex-wrap:wrap`)}>
                <span style={css(`font-family:var(--font-heading);font-size:22px`)}>Deployment gate — agent v1.9</span>
                <span style={css(`font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${v.gate.color}`)}>{v.gate.status}</span>
              </div>
              <p style={css(`font-size:13.5px;line-height:1.75;text-align:justify;max-width:82ch;margin:9.2px 0 0;color:var(--color-neutral-800)`)}>{v.gate.note}</p>
              <div style={css(`display:flex;gap:9.2px;margin-top:13.8px;flex-wrap:wrap`)}>
                {v.gate.actions.map((g, i) => (
                  <button key={i} className="hv0" onClick={g.go}
                    style={css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid ${g.border};color:${g.color};background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <p style={css(`font-size:13.5px;line-height:1.8;text-align:justify;max-width:82ch;margin-top:22px;color:var(--color-neutral-800)`)}>
              The regressions come from three changes that all read as improvements: v1.9 writes straight from the
              search result instead of re-reading first, so an edit a rep made in between is overwritten; it dropped the
              merge bar from 0.95 to 0.90 to catch more duplicates, and the records that score in that band are the thin
              ones where the score is high because there is nothing there to disagree; and it retries every error rather
              than only the ones that clear, so a 403 is hammered three times and then written past. {v.gate.outlook}
            </p>
          </div>
        )}
      </div>
    );
  }
}
