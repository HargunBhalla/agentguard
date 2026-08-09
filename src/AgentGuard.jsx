import React from 'react';
import { css } from './css.js';
import { compareSuites, verdictFor } from './harness/index.js';
import { rehearseAll, POLICIES, invariantStatus } from './harness/shadow.js';
import { runChaos, FAULTS, MODIFIERS } from './harness/chaos.js';
import { runTrace, runSaga } from './harness/trace.js';

/*
 * The replay suite is executed once, at module load. Every planner runs against
 * a fresh shadow world and every tool cost is fixed, so the result is
 * deterministic — the same six cases, the same two regressions, every reload.
 */
const SUITE = compareSuites();

/*
 * The pre-flight gate's five proposed calls, rehearsed against the shadow
 * world. Their diffs, blast radii and policy verdicts are read back off the
 * rehearsal rather than written down here.
 */
const REHEARSED = rehearseAll();

/*
 * AgentGuard — ported from the design prototype.
 *
 * The prototype split itself in two: a logic class that derived a flat bag of
 * view values, and a template that bound to them. That split is preserved
 * here — renderVals() below is the original logic verbatim, and render()
 * binds its output to JSX translated from the template.
 */

const V = { safe: 'var(--color-neutral-600)', review: 'var(--color-accent-600)', blocked: 'var(--color-accent-800)' };
const LABEL = { safe: 'safe', review: 'needs review', blocked: 'blocked' };

export default class AgentGuard extends React.Component {
  stageDefs = [
    { n: '1', name: 'Shadow simulation', note: 'Proposed calls rehearsed against a sandbox copy of every app.', tab: 'preflight', status: 'complete · 2.41s', tone: 'ink' },
    { n: '2', name: 'State diff', note: 'Predicted before/after across CRM, calendar, inventory and Gmail.', tab: 'preflight', status: '5 diffs', tone: 'ink' },
    { n: '3', name: 'Policy & invariants', note: 'Double bookings, bulk sends and destructive writes caught here.', tab: 'preflight', status: '1 violation', tone: 'gold' },
    { n: '4', name: 'Failure injection', note: 'Timeouts, 500s, expired auth and malformed payloads replayed.', tab: 'chaos', status: 'ready', tone: 'ink' },
    { n: '5', name: 'Safe execution — via Composio', note: 'Approved calls issued through Composio sessions with a checkpoint.', tab: 'preflight', status: '2 of 5 approved', tone: 'gold' },
    { n: '6', name: 'Recovery & rollback', note: 'Retry, then saga-style compensating actions to the last clean state.', tab: 'trace', status: 'armed', tone: 'ink' },
    { n: '7', name: 'Tracing, replay & evals', note: 'Spans recorded and replayed against the candidate planner.', tab: 'replay', status: `${SUITE.regressions} regressions`, tone: 'gold' }
  ];

  state = { tab: 'pipeline', sim: 'idle', selId: 'a1', decisions: {},
    policyOn: { p1: true, p2: true, p3: true, p4: false },
    openSpans: { s5: true }, rollback: 'none', chaos: 'idle', chaosLog: [], openCase: null,
    connector: 'gmail', fault: 'f1', stepId: 'gmail.send', mods: {} };

  policyDefs = POLICIES;

  actionDefs = REHEARSED;

  spanDefs = runTrace();

  faultDefs = FAULTS;

  invariantDefs = invariantStatus();

  sagaDefs = runSaga().steps;

  get canaryDefs() {
    const m = SUITE.metrics;
    const pct = n => Math.round((n / m.cases) * 100) + '%';
    const per = n => (n / m.cases).toFixed(1);
    const secs = n => (n / 1000).toFixed(2) + 's';
    return [
      { metric: 'Cases passed', old: pct(m.baselinePassed), cand: pct(m.candidatePassed),
        good: m.candidatePassed >= m.baselinePassed },
      { metric: 'Tool calls per run', old: per(m.baselineCalls), cand: per(m.candidateCalls),
        good: m.candidateCalls <= m.baselineCalls },
      { metric: 'Latency per run', old: secs(m.baselineMs / m.cases), cand: secs(m.candidateMs / m.cases),
        good: m.candidateMs <= m.baselineMs },
      { metric: 'Invariant violations', old: '0', cand: String(m.violations), good: m.violations === 0 },
      { metric: 'Regressions', old: '0', cand: String(SUITE.regressions), good: SUITE.regressions === 0 }
    ];
  }

  connectorDefs = [
    { id: 'gmail', label: 'Gmail' },
    { id: 'crm', label: 'Rental CRM / inventory' },
    { id: 'calendar', label: 'Google Calendar' }
  ];

  stepDefs = {
    gmail: [{ id: 'gmail.send', label: 'gmail.send — step 7' }],
    crm: [{ id: 'crm.query', label: 'crm.query — step 3' }, { id: 'inventory.reserve', label: 'inventory.reserve — step 4' }, { id: 'crm.update', label: 'crm.update — step 6' }],
    calendar: [{ id: 'calendar.update', label: 'calendar.update — step 5' }]
  };

  modifierDefs = MODIFIERS;

  get caseDefs() {
    return SUITE.results.map(r => ({
      name: r.name, actions: r.actions,
      v14: r.baseline.pass ? 'pass' : 'fail',
      v15: r.candidate.pass ? 'pass' : 'fail',
      delta: r.deltaLabel
    }));
  }

  /**
   * Build the side-by-side panel from the two recorded traces. Rows are tinted
   * from the step the runs stopped agreeing at onward, which is where a reader
   * needs to look.
   */
  compareFor(i) {
    if (i == null) return { name: '', summary: '', left: [], right: [], verdict: '' };
    const r = SUITE.results[i];
    const ink = 'var(--color-text)', flag = 'var(--color-accent-800)';

    const rows = (run, tint) => [
      ...run.trace.map((sp, n) => ({
        step: sp.tool, meta: sp.meta,
        color: tint && r.divergesAt >= 0 && n >= r.divergesAt ? flag : ink
      })),
      { step: 'result', meta: run.pass ? 'pass' : 'fail — rolled back',
        color: run.pass ? ink : flag }
    ];

    const summary = r.divergesAt < 0
      ? 'no divergence · both planners agree'
      : `divergence at step ${r.divergesAt + 1} · ` +
        (r.regressed ? r.candidate.violations[0].id.replace(/_/g, ' ') : 'same final state');

    return { name: r.name, summary, left: rows(r.baseline, false),
      right: rows(r.candidate, true), verdict: verdictFor(r) };
  }

  componentWillUnmount() { (this._t || []).forEach(clearTimeout); }
  later(fn, ms) { (this._t = this._t || []).push(setTimeout(fn, ms)); }

  verdictOf(a) {
    const strict = this.props.strictMode ?? false;
    const tripped = a.trips.filter(id => this.state.policyOn[id]);
    if (!tripped.length) return 'safe';
    if (strict) return 'blocked';
    return tripped.some(id => this.policyDefs.find(p => p.id === id).sev === 'blocked') ? 'blocked' : 'review';
  }

  runSim = () => {
    this.setState({ sim: 'running' });
    this.later(() => this.setState({ sim: 'done' }), this.props.simMs ?? 1500);
  };

  doRollback = () => {
    if (this.state.rollback !== 'none') return;
    this.setState({ rollback: 'running' });
    this.later(() => this.setState({ rollback: 'done' }), 1100);
  };

  /** Replay the approved plan with the selected fault actually injected. */
  experiment() {
    const st = this.state;
    const list = this.stepDefs[st.connector || 'gmail'];
    const step = (list.find(x => x.id === st.stepId) || list[0]).id;
    return runChaos({ fault: st.fault, stepId: step, mods: st.mods || {} });
  }

  inject = () => {
    if (this.state.chaos === 'running') return;
    const { log, outcome } = this.experiment();
    this.setState({ chaos: 'running', chaosLog: [], verdict: outcome });
    log.forEach((line, i) => this.later(() => this.setState(s => ({
      chaosLog: s.chaosLog.concat(line)
    })), 450 * (i + 1)));
    this.later(() => this.setState({ chaos: 'done' }), 450 * (log.length + 1));
  };

  renderVals() {
    const st = this.state;
    const tabs = [['pipeline', 'Pipeline'], ['preflight', 'Pre-flight'], ['trace', 'Live trace'], ['chaos', 'Chaos lab'], ['replay', 'Replay']].map(([id, label]) => ({
      label, go: () => this.setState({ tab: id }),
      border: st.tab === id ? 'var(--color-accent)' : 'transparent',
      color: st.tab === id ? 'var(--color-accent-700)' : 'var(--color-neutral-700)'
    }));

    const actions = this.actionDefs.map(a => {
      const d = st.decisions[a.id];
      const v = d === 'blocked' ? 'blocked' : d === 'approved' ? 'safe' : this.verdictOf(a);
      return { ...a, vc: V[v],
        verdictLabel: d === 'approved' ? 'approved' : d === 'blocked' ? 'blocked by you' : LABEL[v],
        cardBorder: st.selId === a.id ? 'var(--color-accent)' : 'var(--color-divider)',
        cardBg: st.selId === a.id ? 'var(--color-accent-100)' : 'transparent',
        select: () => this.setState({ selId: a.id }) };
    });
    const sel = actions.find(a => a.id === st.selId) || actions[0];
    const selDef = this.actionDefs.find(a => a.id === sel.id);
    const selChecks = this.policyDefs.map(p => {
      const on = st.policyOn[p.id], trips = selDef.trips.includes(p.id);
      const sev = (this.props.strictMode ?? false) ? 'blocked' : p.sev;
      return { name: p.name,
        state: !on ? 'off' : trips ? (sev === 'blocked' ? 'violated' : 'flagged') : 'clear',
        color: !on ? 'var(--color-neutral-500)' : trips ? V[sev] : 'var(--color-neutral-700)' };
    });

    const policies = this.policyDefs.map(p => ({
      name: p.name, mode: (this.props.strictMode ?? false) ? 'hard block' : p.mode,
      mark: st.policyOn[p.id] ? 'var(--color-accent)' : 'var(--color-neutral-400)',
      fill: st.policyOn[p.id] ? 'var(--color-accent)' : 'transparent',
      text: st.policyOn[p.id] ? 'var(--color-text)' : 'var(--color-neutral-500)',
      toggle: () => this.setState(s => ({ policyOn: { ...s.policyOn, [p.id]: !s.policyOn[p.id] } }))
    }));

    const dec = st.decisions[sel.id];
    const decisionNote = dec === 'approved'
      ? 'Executed at 14:02 · checkpoint ck-8812-03 saved · undo available for 24h'
      : dec === 'blocked' ? 'Blocked. The agent was told to re-plan without this tool call.' : '';

    const spans = this.spanDefs.map(s => ({ ...s,
      left: s.left + '%', width: s.width + '%',
      bar: s.status === 'ok' ? 'var(--color-neutral-700)' : 'var(--color-accent)',
      color: s.status === 'ok' ? 'var(--color-neutral-600)' : 'var(--color-accent-700)',
      caret: st.openSpans[s.id] ? '▾' : '▸',
      open: !!st.openSpans[s.id],
      toggle: () => this.setState(x => ({ openSpans: { ...x.openSpans, [s.id]: !x.openSpans[s.id] } }))
    }));

    const mods = st.mods || {};
    const steps = this.stepDefs[st.connector || 'gmail'];
    const faultName = (this.faultDefs.find(f => f.id === st.fault) || this.faultDefs[0]).name;
    const stepLabel = (steps.find(s => s.id === st.stepId) || steps[0]).label.split(' — ')[0];
    const modNames = this.modifierDefs.filter(m => mods[m.id]).map(m => m.label.split(' (')[0].toLowerCase());
    const experimentLine = 'Injecting ' + faultName + ' into ' + stepLabel + ' on the recorded run'
      + (modNames.length ? ', with ' + modNames.join(' and ') + '' : '')
      + '. Recovery policy in force: retry ×3 with exponential backoff, then compensating rollback. AgentGuard reports whether the agent got through without duplicate or inconsistent actions.';
    const modifiers = this.modifierDefs.map(m => ({ label: m.label,
      mark: mods[m.id] ? 'var(--color-accent)' : 'var(--color-neutral-400)',
      fill: mods[m.id] ? 'var(--color-accent)' : 'transparent',
      text: mods[m.id] ? 'var(--color-text)' : 'var(--color-neutral-700)',
      toggle: () => this.setState(s => ({ mods: { ...(s.mods || {}), [m.id]: !(s.mods || {})[m.id] }, chaos: 'idle', chaosLog: [] })) }));

    return {
      tabs,
      stages: this.stageDefs.map(s => ({ n: s.n, name: s.name, note: s.note, status: s.status,
        color: s.tone === 'gold' ? 'var(--color-accent-700)' : 'var(--color-neutral-600)',
        go: () => this.setState({ tab: s.tab }) })),
      onPipeline: st.tab === 'pipeline',
      onPreflight: st.tab === 'preflight', onTrace: st.tab === 'trace',
      onChaos: st.tab === 'chaos', onReplay: st.tab === 'replay',
      simIdle: st.sim === 'idle', simRunning: st.sim === 'running',
      simDone: st.sim === 'done', simNotDone: st.sim !== 'done',
      runSim: this.runSim,
      actions, sel, selDiff: selDef.diff, selChecks, policies, decisionNote,
      hasRisk: !!(selDef.risk && this.verdictOf(selDef) !== 'safe'),
      invariants: this.invariantDefs.map(i => ({ expr: i.expr,
        mark: i.ok ? '✓' : '✗',
        color: i.ok ? 'var(--color-neutral-700)' : 'var(--color-accent-800)' })),
      saga: this.sagaDefs.map(s => ({ ...s,
        color: s.state === 'committed' ? 'var(--color-neutral-700)' : s.state === 'failed' ? 'var(--color-accent-800)' : 'var(--color-neutral-500)' })),
      canary: this.canaryDefs.map(c => ({ ...c,
        color: c.good ? 'var(--color-neutral-800)' : 'var(--color-accent-800)' })),
      approve: () => this.setState(s => ({ decisions: { ...s.decisions, [sel.id]: 'approved' } })),
      block: () => this.setState(s => ({ decisions: { ...s.decisions, [sel.id]: 'blocked' } })),
      spans,
      rollback: this.doRollback,
      rollbackLabel: st.rollback === 'none' ? 'Roll back this run' : st.rollback === 'running' ? 'Rolling back…' : 'Rolled back',
      rolledBack: st.rollback === 'done',
      faults: this.faultDefs, connectors: this.connectorDefs, steps, modifiers, experimentLine,
      connector: st.connector || 'gmail', fault: st.fault || 'f1', stepId: (steps.find(s => s.id === st.stepId) || steps[0]).id,
      isGmail: (st.connector || 'gmail') === 'gmail', isCrm: st.connector === 'crm', isCalendar: st.connector === 'calendar',
      setConnector: e => { const c = e.target.value; this.setState({ connector: c, stepId: this.stepDefs[c][0].id, chaos: 'idle', chaosLog: [] }); },
      setFault: e => this.setState({ fault: e.target.value, chaos: 'idle', chaosLog: [] }),
      setStep: e => this.setState({ stepId: e.target.value, chaos: 'idle', chaosLog: [] }),
      verdict: st.verdict || { checks: [] }, chaosDone: st.chaos === 'done',
      chaosLog: st.chaosLog, chaosIdle: st.chaos === 'idle',
      inject: this.inject,
      injectLabel: st.chaos === 'running' ? 'Injecting…' : st.chaos === 'done' ? 'Run again' : 'Inject & replay',
      cases: this.caseDefs.map((c, i) => ({ ...c,
        color: c.v15 === 'fail' ? 'var(--color-accent-800)' : 'var(--color-neutral-700)',
        caret: st.openCase === i ? '▾' : '▸',
        bg: st.openCase === i ? 'var(--color-accent-100)' : 'transparent',
        open: () => this.setState(s => ({ openCase: s.openCase === i ? null : i })) })),
      compareOpen: st.openCase != null,
      compare: this.compareFor(st.openCase),
      gate: (() => {
        const g = st.gate || 'held';
        // badge and outlook feed the two lines outside this card — the header
        // pill and the closing paragraph. They live here so a gate decision
        // cannot leave the page asserting two different rollout states.
        const map = {
          held: { status: 'held at 10% canary', color: 'var(--color-accent-700)',
            note: `${SUITE.metrics.cases} recorded cases replayed against v15. ${SUITE.regressions} regress, so the candidate stays behind the canary — 10% of live rental traffic, every action still pre-flighted.`,
            badge: `${SUITE.regressions} regressions · rollout held at 10%`,
            outlook: 'Rollout stays held until the replay suite is green or the check is restored.' },
          promoted: { status: 'promoted to 100%', color: 'var(--color-accent-800)',
            note: `v15 is now the default planner for all rental traffic. The ${SUITE.regressions} failing cases were accepted with an amended invariant; AgentGuard will hold any run that trips it and page the on-call owner.`,
            badge: `${SUITE.regressions} regressions · rolled out to 100%`,
            outlook: 'Both cases were accepted with an amended invariant, so the rollout went ahead — any run that trips the amended check is held and the on-call owner paged.' },
          blocked: { status: 'blocked · rolled back to v14', color: 'var(--color-accent-800)',
            note: 'v15 is withdrawn from the canary and v14 restored. The candidate keeps receiving shadow traffic, so the replay suite continues to fill without any production exposure.',
            badge: `${SUITE.regressions} regressions · rolled back to v14`,
            outlook: 'v14 is serving production again. v15 keeps taking shadow traffic, so the replay suite fills without exposure while the check is restored.' }
        };
        const acts = [['promote', 'Promote to 100%'], ['held', 'Hold at canary'], ['blocked', 'Block & roll back']]
          .map(([id, label]) => {
            const key = id === 'promote' ? 'promoted' : id;
            const on = g === key;
            return { label, go: () => this.setState({ gate: key }),
              border: on ? 'var(--color-accent)' : 'var(--color-neutral-400)',
              color: on ? 'var(--color-accent-700)' : 'var(--color-neutral-800)' };
          });
        return { ...map[g], actions: acts };
      })()
    };
  }

  render() {
    const {
      tabs, stages, onPipeline, onPreflight, onTrace, onChaos, onReplay, simIdle,
      simRunning, simDone, simNotDone, runSim, actions, sel, selDiff, selChecks, policies,
      decisionNote, hasRisk, invariants, saga, canary, approve, block, spans, rollback,
      rollbackLabel, rolledBack, faults, connectors, steps, modifiers, experimentLine,
      connector, fault, stepId, isGmail, isCrm, isCalendar, setConnector, setFault,
      setStep, verdict, chaosDone, chaosLog, chaosIdle, inject, injectLabel, cases,
      compareOpen, compare, gate
    } = this.renderVals();

    return (
      <div style={css(`height:100vh;display:flex;flex-direction:column;background:var(--color-bg);font-family:var(--font-body)`)}>
        <header style={css(`display:flex;align-items:center;justify-content:space-between;padding:14px 27.6px;border-bottom:1px solid var(--color-divider);flex:none`)}>
          <div style={css(`display:flex;align-items:baseline;gap:18.4px`)}>
            <span style={css(`font-family:var(--font-heading);font-size:23px`)}>
              AgentGuard
            </span>
            <span style={css(`font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);font-feature-settings:'tnum'`)}>
              rental-ops · planner v15 · staging
            </span>
          </div>
          <nav style={css(`display:flex;gap:4.6px`)}>
            {(tabs).map((t, _i) => (
              <React.Fragment key={_i}>
              <button className="hv0" onClick={t.go} style={css(`font-family:var(--font-body);font-size:12.5px;padding:7px 13.8px;border-radius:var(--radius-md);cursor:pointer;background:transparent;border:1px solid ${t.border};color:${t.color}`)}>
                {t.label}
              </button>
              </React.Fragment>
            ))}
          </nav>
          <div style={css(`display:flex;align-items:center;gap:9.2px;font-size:12px;color:var(--color-neutral-700)`)}>
            <span style={css(`width:7px;height:7px;border-radius:50%;background:var(--color-accent);animation:ag-pulse 2s infinite`)}></span>
            <span>
              4 agents live · 1 held
            </span>
          </div>
        </header>
        {(onPipeline) ? (
          <>
          <div style={css(`flex:1;min-height:0;overflow:auto;padding:22px 27.6px 36.8px`)}>
            <div style={css(`max-width:1080px;margin:0 auto`)}>
              <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)`)}>
                Interception path
              </div>
              <h1 style={css(`font-family:var(--font-heading);font-weight:400;font-size:38px;margin:4.6px 0 0;line-height:1.1`)}>
                Nothing reaches Gmail, the calendar, the CRM or the yard unrehearsed.
              </h1>
              <p style={css(`font-size:14px;line-height:1.7;text-align:justify;max-width:66ch;margin:11px 0 0;color:var(--color-neutral-800)`)}>
                AgentGuard sits between the agent's proposed tool calls and the connectors that make them real. Every call is rehearsed against a shadow copy, measured as a state diff, judged against policy, and only then executed — with a checkpoint behind it.
              </p>
              <div style={css(`display:grid;grid-template-columns:210px 1fr;gap:27.6px;margin-top:27.6px;align-items:start`)}>
                <div style={css(`display:flex;flex-direction:column;gap:0`)}>
                  <div style={css(`border:1px solid var(--color-divider);border-radius:var(--radius-md);padding:11px 13.8px`)}>
                    <div style={css(`font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                      Upstream
                    </div>
                    <div style={css(`font-family:var(--font-heading);font-size:19px;margin-top:2px`)}>
                      User request
                    </div>
                  </div>
                  <span style={css(`height:22px;width:1px;background:var(--color-divider);margin:0 auto`)}></span>
                  <div style={css(`border:1px solid var(--color-divider);border-radius:var(--radius-md);padding:11px 13.8px`)}>
                    <div style={css(`font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                      Planner
                    </div>
                    <div style={css(`font-family:var(--font-heading);font-size:19px;margin-top:2px`)}>
                      AI agent
                    </div>
                  </div>
                  <span style={css(`height:22px;width:1px;background:var(--color-divider);margin:0 auto`)}></span>
                  <div style={css(`border:1px solid var(--color-accent);border-radius:var(--radius-md);padding:11px 13.8px`)}>
                    <div style={css(`font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent-700)`)}>
                      Held at the gate
                    </div>
                    <div style={css(`font-family:var(--font-heading);font-size:19px;margin-top:2px`)}>
                      5 proposed calls
                    </div>
                  </div>
                  <span style={css(`height:22px;width:1px;background:var(--color-accent-300);margin:0 auto`)}></span>
                  <div style={css(`border:1px solid var(--color-divider);border-radius:var(--radius-md);padding:11px 13.8px`)}>
                    <div style={css(`font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                      Execution
                      &amp;
                      auth
                    </div>
                    <div style={css(`font-family:var(--font-heading);font-size:19px;margin-top:2px`)}>
                      Composio
                    </div>
                    <div style={css(`font-size:11.5px;line-height:1.5;color:var(--color-neutral-700);margin-top:2px`)}>
                      sessions · connections · tool calls
                    </div>
                  </div>
                  <span style={css(`height:22px;width:1px;background:var(--color-divider);margin:0 auto`)}></span>
                  <div style={css(`border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:11px 13.8px;text-align:center`)}>
                    <div style={css(`font-size:12.5px;line-height:1.5;color:var(--color-neutral-700)`)}>
                      Gmail · Calendar · CRM · Inventory
                    </div>
                    <div style={css(`font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);margin-top:4px`)}>
                      Real world
                    </div>
                  </div>
                </div>
                <div style={css(`border:1px solid var(--color-accent);border-radius:var(--radius-md);padding:18.4px`)}>
                  <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:13.8px;border-bottom:1px solid var(--color-divider);padding-bottom:9.2px`)}>
                    <span style={css(`font-family:var(--font-heading);font-size:22px`)}>
                      AgentGuard
                    </span>
                    <span style={css(`font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);font-feature-settings:'tnum'`)}>
                      run 8812 · 7 stages
                    </span>
                  </div>
                  {(stages).map((s, _i) => (
                    <React.Fragment key={_i}>
                    <div className="hv0" onClick={s.go} style={css(`cursor:pointer;display:grid;grid-template-columns:34px 1fr 150px;gap:13.8px;align-items:baseline;padding:11px 6px;border-bottom:1px solid var(--color-divider)`)}>
                      <span style={css(`font-family:var(--font-heading);font-size:17px;color:var(--color-accent-700);font-feature-settings:'tnum'`)}>
                        {s.n}
                      </span>
                      <span>
                        <span style={css(`font-family:var(--font-heading);font-size:18px;display:block`)}>
                          {s.name}
                        </span>
                        <span style={css(`font-size:12.5px;line-height:1.5;color:var(--color-neutral-700);display:block;margin-top:1px`)}>
                          {s.note}
                        </span>
                      </span>
                      <span style={css(`font-size:11px;letter-spacing:.12em;text-transform:uppercase;text-align:right;color:${s.color}`)}>
                        {s.status}
                      </span>
                    </div>
                    </React.Fragment>
                  ))}
                  <div style={css(`font-size:11.5px;line-height:1.7;color:var(--color-neutral-600);padding-top:11px`)}>
                    Each stage opens the screen where it is worked. Stages 1–4 never touch a production connector.
                  </div>
                </div>
              </div>
            </div>
          </div>
          </>
        ) : null}
        {(onPreflight) ? (
          <>
          <div style={css(`flex:1;min-height:0;display:flex;flex-direction:column`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;gap:27.6px;padding:18.4px 27.6px 13.8px`)}>
              <div>
                <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700);font-feature-settings:'tnum'`)}>
                  Pre-flight review · run 8812 · ABC Construction
                </div>
                <h1 style={css(`font-family:var(--font-heading);font-weight:400;font-size:36px;margin:4.6px 0 0;line-height:1.1`)}>
                  “Move the excavator to Friday” became five real actions.
                </h1>
              </div>
              <div style={css(`display:flex;gap:13.8px;align-items:center`)}>
                {(simIdle) ? (
                  <>
                  <button className="hv0" onClick={runSim} style={css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-accent);color:var(--color-accent-700);background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                    Run shadow simulation
                  </button>
                  </>
                ) : null}
                {(simRunning) ? (
                  <>
                  <span style={css(`font-size:13px;color:var(--color-accent-700);display:flex;align-items:center;gap:9.2px`)}>
                    <span style={css(`width:80px;height:2px;background:var(--color-accent-200);overflow:hidden;display:inline-block`)}>
                      <span style={css(`display:block;width:30%;height:100%;background:var(--color-accent);animation:ag-sweep 1s linear infinite`)}></span>
                    </span>
                    simulating in shadow…
                  </span>
                  </>
                ) : null}
                {(simDone) ? (
                  <>
                  <span style={css(`font-size:12.5px;color:var(--color-neutral-700);font-feature-settings:'tnum'`)}>
                    shadow run complete · 2.41s · no side effects
                  </span>
                  </>
                ) : null}
              </div>
            </div>
            <div style={css(`flex:1;min-height:0;display:grid;grid-template-columns:330px 1fr 265px;border-top:1px solid var(--color-divider)`)}>
              <div style={css(`border-right:1px solid var(--color-divider);overflow:auto;padding:13.8px`)}>
                {(actions).map((a, _i) => (
                  <React.Fragment key={_i}>
                  <div className="hv0" onClick={a.select} style={css(`cursor:pointer;padding:11px 13.8px;margin-bottom:9.2px;border:1px solid ${a.cardBorder};border-left:3px solid ${a.vc};border-radius:var(--radius-md);background:${a.cardBg}`)}>
                    <div style={css(`display:flex;justify-content:space-between;align-items:baseline;gap:9.2px`)}>
                      <span style={css(`font-family:var(--font-heading);font-size:17px;font-weight:600`)}>
                        {a.tool}
                      </span>
                      <span style={css(`font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${a.vc};white-space:nowrap`)}>
                        {a.verdictLabel}
                      </span>
                    </div>
                    <div style={css(`font-size:12.5px;line-height:1.5;color:var(--color-neutral-700);margin-top:2px`)}>
                      {a.summary}
                    </div>
                  </div>
                  </React.Fragment>
                ))}
                <div style={css(`font-size:11.5px;line-height:1.6;color:var(--color-neutral-600);border-top:1px solid var(--color-divider);padding-top:9.2px;margin-top:13.8px`)}>
                  Every proposed tool call from one agent turn. Nothing here has run.
                </div>
              </div>
              <div style={css(`overflow:auto;padding:22px 27.6px`)}>
                <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:18.4px`)}>
                  <h2 style={css(`font-family:var(--font-heading);font-weight:400;font-size:28px;margin:0`)}>
                    {sel.tool}
                  </h2>
                  <span style={css(`font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${sel.vc};border:1px solid ${sel.vc};padding:3px 9.2px;border-radius:var(--radius-md);white-space:nowrap`)}>
                    {sel.verdictLabel}
                  </span>
                </div>
                <p style={css(`font-size:14px;line-height:1.7;text-align:justify;margin:9.2px 0 0;max-width:64ch`)}>
                  {sel.detail}
                </p>
                {(hasRisk) ? (
                  <>
                  <div style={css(`margin-top:13.8px;border:1px solid var(--color-accent);border-left:3px solid var(--color-accent);border-radius:var(--radius-md);padding:13.8px 18.4px;max-width:64ch;animation:ag-in .3s ease both`)}>
                    <div style={css(`font-family:var(--font-heading);font-size:19px;color:var(--color-accent-800)`)}>
                      {sel.risk}
                    </div>
                    <p style={css(`font-size:13px;line-height:1.7;margin:4.6px 0 0;color:var(--color-neutral-800)`)}>
                      {sel.alt}
                    </p>
                  </div>
                  </>
                ) : null}
                {(simDone) ? (
                  <>
                  <div style={css(`margin-top:22px`)}>
                    <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);border-bottom:1px solid var(--color-divider);padding-bottom:6px`)}>
                      State diff — predicted
                    </div>
                    {(selDiff).map((d, _i) => (
                      <React.Fragment key={_i}>
                      <div style={css(`display:grid;grid-template-columns:170px 1fr 1fr;gap:13.8px;padding:9.2px 0;border-bottom:1px solid var(--color-divider);font-size:13px;animation:ag-in .3s ease both`)}>
                        <span style={css(`color:var(--color-neutral-700)`)}>
                          {d.field}
                        </span>
                        <span style={css(`color:var(--color-neutral-600);text-decoration:line-through;font-feature-settings:'tnum'`)}>
                          {d.before}
                        </span>
                        <span style={css(`color:var(--color-accent-800);font-feature-settings:'tnum'`)}>
                          {d.after}
                        </span>
                      </div>
                      </React.Fragment>
                    ))}
                    <div style={css(`font-size:11.5px;color:var(--color-neutral-600);margin-top:9.2px`)}>
                      {sel.blast}
                    </div>
                  </div>
                  </>
                ) : null}
                {(simNotDone) ? (
                  <>
                  <div style={css(`margin-top:22px;border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:36.8px;text-align:center;font-size:13px;color:var(--color-neutral-600)`)}>
                    No diff yet — run the shadow simulation to predict what changes.
                  </div>
                  </>
                ) : null}
                <div style={css(`margin-top:22px`)}>
                  <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);border-bottom:1px solid var(--color-divider);padding-bottom:6px`)}>
                    Policy verdict
                  </div>
                  {(selChecks).map((c, _i) => (
                    <React.Fragment key={_i}>
                    <div style={css(`display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--color-divider);font-size:13px`)}>
                      <span style={css(`color:${c.color}`)}>
                        {c.name}
                      </span>
                      <span style={css(`font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${c.color}`)}>
                        {c.state}
                      </span>
                    </div>
                    </React.Fragment>
                  ))}
                </div>
                <div style={css(`display:flex;gap:9.2px;margin-top:22px;align-items:center;flex-wrap:wrap`)}>
                  <button className="hv0" onClick={approve} style={css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-accent);color:var(--color-accent-700);background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                    Approve
                    &amp;
                    execute
                  </button>
                  <button className="hv1" onClick={block} style={css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-neutral-400);color:var(--color-neutral-800);background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                    Block
                  </button>
                  <span style={css(`font-size:12.5px;color:var(--color-accent-700)`)}>
                    {decisionNote}
                  </span>
                </div>
              </div>
              <div style={css(`border-left:1px solid var(--color-divider);padding:22px 18.4px;overflow:auto`)}>
                <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:11px`)}>
                  Active policies
                </div>
                {(policies).map((p, _i) => (
                  <React.Fragment key={_i}>
                  <div onClick={p.toggle} style={css(`cursor:pointer;display:flex;gap:9.2px;align-items:flex-start;padding:9.2px 0;border-bottom:1px solid var(--color-divider)`)}>
                    <span style={css(`flex:none;margin-top:4px;width:12px;height:12px;border-radius:2px;border:1px solid ${p.mark};background:${p.fill}`)}></span>
                    <span>
                      <span style={css(`font-size:12.5px;line-height:1.45;display:block;color:${p.text}`)}>
                        {p.name}
                      </span>
                      <span style={css(`font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                        {p.mode}
                      </span>
                    </span>
                  </div>
                  </React.Fragment>
                ))}
                <p style={css(`font-size:11.5px;line-height:1.7;color:var(--color-neutral-600);margin-top:13.8px`)}>
                  Toggling a policy re-evaluates every queued action against the shadow result — no re-run needed.
                </p>
                <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);margin:22px 0 9.2px;border-top:1px solid var(--color-divider);padding-top:13.8px`)}>
                  Invariants
                </div>
                {(invariants).map((i, _i) => (
                  <React.Fragment key={_i}>
                  <div style={css(`display:flex;gap:9.2px;align-items:baseline;padding:5px 0`)}>
                    <span style={css(`font-size:12px;color:${i.color};flex:none`)}>
                      {i.mark}
                    </span>
                    <span style={css(`font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.5;color:${i.color}`)}>
                      {i.expr}
                    </span>
                  </div>
                  </React.Fragment>
                ))}
                <p style={css(`font-size:11.5px;line-height:1.7;color:var(--color-neutral-600);margin-top:11px`)}>
                  Evaluated against the predicted state, not the current one. Both failures belong to the same proposed run.
                </p>
              </div>
            </div>
          </div>
          </>
        ) : null}
        {(onTrace) ? (
          <>
          <div style={css(`flex:1;min-height:0;display:flex;flex-direction:column`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;padding:18.4px 27.6px 13.8px`)}>
              <div>
                <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)`)}>
                  Live trace
                </div>
                <h1 style={css(`font-family:var(--font-heading);font-weight:400;font-size:36px;margin:4.6px 0 0`)}>
                  Run 8812 · 7 spans · 4.2s
                </h1>
              </div>
              <button className="hv0" onClick={rollback} style={css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-accent);color:var(--color-accent-700);background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                {rollbackLabel}
              </button>
            </div>
            <div style={css(`flex:1;min-height:0;overflow:auto;border-top:1px solid var(--color-divider);padding:18.4px 27.6px`)}>
              {(spans).map((s, _i) => (
                <React.Fragment key={_i}>
                <div style={css(`border-bottom:1px solid var(--color-divider)`)}>
                  <div className="hv0" onClick={s.toggle} style={css(`cursor:pointer;display:grid;grid-template-columns:20px 210px 1fr 90px 110px;align-items:center;gap:13.8px;padding:11px 4px`)}>
                    <span style={css(`font-size:11px;color:var(--color-neutral-600)`)}>
                      {s.caret}
                    </span>
                    <span style={css(`font-family:var(--font-heading);font-size:17px`)}>
                      {s.name}
                    </span>
                    <span style={css(`height:6px;background:var(--color-neutral-200);border-radius:3px;position:relative;display:block`)}>
                      <span style={css(`position:absolute;top:0;bottom:0;left:${s.left};width:${s.width};background:${s.bar};border-radius:3px`)}></span>
                    </span>
                    <span style={css(`font-size:12px;text-align:right;font-feature-settings:'tnum';color:var(--color-neutral-700)`)}>
                      {s.ms}
                    </span>
                    <span style={css(`font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;text-align:right;color:${s.color}`)}>
                      {s.status}
                    </span>
                  </div>
                  {(s.open) ? (
                    <>
                    <div style={css(`display:grid;grid-template-columns:1fr 1fr;gap:18.4px;padding:0 4px 18.4px 38px;animation:ag-in .25s ease both`)}>
                      <div>
                        <div style={css(`font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:6px`)}>
                          Arguments
                        </div>
                        <pre style={css(`margin:0;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.7;background:var(--color-neutral-100);border:1px solid var(--color-divider);border-radius:var(--radius-md);padding:11px;white-space:pre-wrap;color:var(--color-neutral-800)`)}>
                          {s.args}
                        </pre>
                      </div>
                      <div>
                        <div style={css(`font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:6px`)}>
                          Result
                        </div>
                        <pre style={css(`margin:0;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.7;background:var(--color-neutral-100);border:1px solid var(--color-divider);border-radius:var(--radius-md);padding:11px;white-space:pre-wrap;color:var(--color-neutral-800)`)}>
                          {s.result}
                        </pre>
                      </div>
                    </div>
                    </>
                  ) : null}
                </div>
                </React.Fragment>
              ))}
              {(rolledBack) ? (
                <>
                <div style={css(`margin-top:18.4px;border:1px solid var(--color-accent);border-radius:var(--radius-md);padding:18.4px;animation:ag-in .3s ease both`)}>
                  <div style={css(`font-family:var(--font-heading);font-size:20px;margin-bottom:9.2px`)}>
                    Compensating saga — rolled back to ck-8812-03
                  </div>
                  <div style={css(`display:grid;grid-template-columns:260px 110px 1fr;gap:13.8px;padding-bottom:6px;border-bottom:1px solid var(--color-divider);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                    <span>
                      Step
                    </span>
                    <span>
                      In the run
                    </span>
                    <span>
                      Compensating action
                    </span>
                  </div>
                  {(saga).map((g, _i) => (
                    <React.Fragment key={_i}>
                    <div style={css(`display:grid;grid-template-columns:260px 110px 1fr;gap:13.8px;padding:8px 0;border-bottom:1px solid var(--color-divider);font-size:13px;align-items:baseline`)}>
                      <span style={css(`color:${g.color}`)}>
                        {g.step}
                      </span>
                      <span style={css(`font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${g.color}`)}>
                        {g.state}
                      </span>
                      <span style={css(`color:var(--color-neutral-700);line-height:1.5`)}>
                        {g.undo}
                      </span>
                    </div>
                    </React.Fragment>
                  ))}
                  <div style={css(`font-size:12.5px;line-height:1.8;color:var(--color-neutral-700);margin-top:9.2px`)}>
                    Agent notified; run marked non-retryable pending review.
                  </div>
                  <div style={css(`font-size:12.5px;line-height:1.7;color:var(--color-accent-800)`)}>
                    Environment restored. No duplicate reservation, no partial notice.
                  </div>
                </div>
                </>
              ) : null}
            </div>
          </div>
          </>
        ) : null}
        {(onChaos) ? (
          <>
          <div style={css(`flex:1;min-height:0;display:grid;grid-template-columns:300px 1fr`)}>
            <div style={css(`border-right:1px solid var(--color-divider);padding:22px 18.4px;overflow:auto;display:flex;flex-direction:column;gap:18.4px`)}>
              <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                Inject failure
              </div>
              <label style={css(`display:flex;flex-direction:column;gap:4.6px`)}>
                <span style={css(`font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                  Connector
                </span>
                <select value={connector} onChange={setConnector} style={css(`font-family:var(--font-body);font-size:13px;padding:7px 9.2px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:transparent;color:var(--color-text)`)}>
                  <option value="gmail">
                    Gmail
                  </option>
                  <option value="crm">
                    CRM (Salesforce)
                  </option>
                  <option value="calendar">
                    Google Calendar
                  </option>
                </select>
              </label>
              <label style={css(`display:flex;flex-direction:column;gap:4.6px`)}>
                <span style={css(`font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                  Fault
                </span>
                <select value={fault} onChange={setFault} style={css(`font-family:var(--font-body);font-size:13px;padding:7px 9.2px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:transparent;color:var(--color-text)`)}>
                  <option value="f1">
                    429 rate limit
                  </option>
                  <option value="f2">
                    Timeout
                  </option>
                  <option value="f3">
                    Auth token expired
                  </option>
                  <option value="f4">
                    Partial write
                  </option>
                  <option value="f5">
                    500 from provider
                  </option>
                </select>
              </label>
              <label style={css(`display:flex;flex-direction:column;gap:4.6px`)}>
                <span style={css(`font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                  At step
                </span>
                <select value={stepId} onChange={setStep} style={css(`font-family:var(--font-body);font-size:13px;padding:7px 9.2px;border:1px solid var(--color-divider);border-radius:var(--radius-md);background:transparent;color:var(--color-text)`)}>
                  {(isGmail) ? (
                    <>
                    <option value="gmail.send">
                      gmail.send — step 7
                    </option>
                    </>
                  ) : null}
                  {(isCrm) ? (
                    <>
                    <option value="crm.query">
                      crm.query — step 3
                    </option>
                    <option value="inventory.reserve">
                      inventory.reserve — step 4
                    </option>
                    <option value="crm.update">
                      crm.update — step 6
                    </option>
                    </>
                  ) : null}
                  {(isCalendar) ? (
                    <>
                    <option value="calendar.update">
                      calendar.update — step 5
                    </option>
                    </>
                  ) : null}
                </select>
              </label>
              <div style={css(`display:flex;flex-direction:column;gap:9.2px;border-top:1px solid var(--color-divider);padding-top:13.8px`)}>
                {(modifiers).map((m, _i) => (
                  <React.Fragment key={_i}>
                  <div onClick={m.toggle} style={css(`cursor:pointer;display:flex;gap:9.2px;align-items:flex-start`)}>
                    <span style={css(`flex:none;margin-top:3px;width:12px;height:12px;border-radius:2px;border:1px solid ${m.mark};background:${m.fill}`)}></span>
                    <span style={css(`font-size:12.5px;line-height:1.45;color:${m.text}`)}>
                      {m.label}
                    </span>
                  </div>
                  </React.Fragment>
                ))}
              </div>
              <button className="hv0" onClick={inject} style={css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid var(--color-accent);color:var(--color-accent-700);background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                {injectLabel}
              </button>
              <div style={css(`font-size:11.5px;line-height:1.7;color:var(--color-neutral-600);border-top:1px solid var(--color-divider);padding-top:11px`)}>
                Injected against the shadow copy only. Production connectors are never touched.
              </div>
            </div>
            <div style={css(`padding:22px 27.6px;overflow:auto`)}>
              <div>
                <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)`)}>
                  Chaos lab
                </div>
                <h1 style={css(`font-family:var(--font-heading);font-weight:400;font-size:36px;margin:4.6px 0 0`)}>
                  Break it here, not in the yard.
                </h1>
              </div>
              <p style={css(`font-size:14px;line-height:1.7;max-width:62ch;margin:13.8px 0 0;text-align:justify`)}>
                {experimentLine}
              </p>
              {(chaosDone) ? (
                <>
                <div style={css(`margin-top:22px;border:1px solid ${verdict.border};border-radius:var(--radius-md);padding:18.4px;animation:ag-in .3s ease both`)}>
                  <div style={css(`font-family:var(--font-heading);font-size:24px;color:${verdict.color}`)}>
                    {verdict.headline}
                  </div>
                  <div style={css(`display:grid;grid-template-columns:repeat(3,1fr);gap:18.4px;margin-top:13.8px`)}>
                    {(verdict.checks).map((v, _i) => (
                      <React.Fragment key={_i}>
                      <div style={css(`border-top:1px solid var(--color-divider);padding-top:9.2px`)}>
                        <div style={css(`font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                          {v.label}
                        </div>
                        <div style={css(`font-size:15px;font-family:var(--font-heading);color:${v.color};margin-top:3px`)}>
                          {v.value}
                        </div>
                        <div style={css(`font-size:12px;line-height:1.5;color:var(--color-neutral-700);margin-top:2px`)}>
                          {v.note}
                        </div>
                      </div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
                </>
              ) : null}
              <div style={css(`margin-top:22px;border-top:1px solid var(--color-divider)`)}>
                {(chaosLog).map((l, _i) => (
                  <React.Fragment key={_i}>
                  <div style={css(`display:grid;grid-template-columns:80px 1fr;gap:18.4px;padding:9.2px 0;border-bottom:1px solid var(--color-divider);animation:ag-in .3s ease both`)}>
                    <span style={css(`font-size:12px;font-feature-settings:'tnum';color:var(--color-neutral-600)`)}>
                      {l.t}
                    </span>
                    <span style={css(`font-size:13.5px;line-height:1.5;color:${l.color}`)}>
                      {l.text}
                    </span>
                  </div>
                  </React.Fragment>
                ))}
              </div>
              {(chaosIdle) ? (
                <>
                <div style={css(`margin-top:18.4px;border:1px dashed var(--color-neutral-400);border-radius:var(--radius-md);padding:36.8px;text-align:center;font-size:13px;color:var(--color-neutral-600)`)}>
                  Pick a fault and inject it to watch the recovery path.
                </div>
                </>
              ) : null}
            </div>
          </div>
          </>
        ) : null}
        {(onReplay) ? (
          <>
          <div style={css(`flex:1;min-height:0;overflow:auto;padding:22px 27.6px`)}>
            <div style={css(`display:flex;align-items:flex-end;justify-content:space-between;gap:18.4px`)}>
              <div>
                <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700)`)}>
                  Replay
                  &amp;
                  canary
                </div>
                <h1 style={css(`font-family:var(--font-heading);font-weight:400;font-size:36px;margin:4.6px 0 0`)}>
                  {SUITE.metrics.cases} recorded cases, replayed against v15.
                </h1>
              </div>
              <span style={css(`font-size:12.5px;color:${gate.color};border:1px solid var(--color-accent);padding:6px 13.8px;border-radius:var(--radius-md);white-space:nowrap`)}>
                {gate.badge}
              </span>
            </div>
            <div style={css(`display:grid;grid-template-columns:repeat(6,1fr);gap:0;margin-top:22px;border-top:1px solid var(--color-text)`)}>
              {(canary).map((m, _i) => (
                <React.Fragment key={_i}>
                <div style={css(`padding:13.8px 13.8px 13.8px 0;border-right:1px solid var(--color-divider)`)}>
                  <div style={css(`font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600)`)}>
                    {m.metric}
                  </div>
                  <div style={css(`display:flex;align-items:baseline;gap:6px;margin-top:6px`)}>
                    <span style={css(`font-size:14px;color:var(--color-neutral-500);text-decoration:line-through;font-feature-settings:'tnum'`)}>
                      {m.old}
                    </span>
                    <span style={css(`font-family:var(--font-heading);font-size:23px;color:${m.color};font-feature-settings:'tnum'`)}>
                      {m.cand}
                    </span>
                  </div>
                </div>
                </React.Fragment>
              ))}
            </div>
            <p style={css(`font-size:12px;line-height:1.6;color:var(--color-neutral-600);margin:9.2px 0 0`)}>
              Shadow canary — the candidate ran the same 42 requests against shadow connectors while v14 served production.
            </p>
            <table style={css(`width:100%;border-collapse:collapse;margin-top:22px;font-size:13.5px`)}>
              <thead>
                <tr>
                  <th style={css(`text-align:left;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`)}>
                    Recorded case
                  </th>
                  <th style={css(`text-align:left;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`)}>
                    Actions
                  </th>
                  <th style={css(`text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`)}>
                    v14
                  </th>
                  <th style={css(`text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`)}>
                    v15
                  </th>
                  <th style={css(`text-align:right;padding:9.2px 6px;border-bottom:1px solid var(--color-text);font-family:var(--font-heading);font-weight:600;font-size:15px`)}>
                    Δ latency
                  </th>
                </tr>
              </thead>
              <tbody>
                {(cases).map((c, _i) => (
                  <React.Fragment key={_i}>
                  <tr onClick={c.open} style={css(`cursor:pointer;background:${c.bg}`)}>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider)`)}>
                      {c.caret} {c.name}
                    </td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);color:var(--color-neutral-700);font-size:12.5px`)}>
                      {c.actions}
                    </td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);text-align:right;font-feature-settings:'tnum';color:var(--color-neutral-700)`)}>
                      {c.v14}
                    </td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);text-align:right;font-feature-settings:'tnum';color:${c.color}`)}>
                      {c.v15}
                    </td>
                    <td style={css(`padding:11px 6px;border-bottom:1px solid var(--color-divider);text-align:right;font-feature-settings:'tnum';color:var(--color-neutral-700)`)}>
                      {c.delta}
                    </td>
                  </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            {(compareOpen) ? (
              <>
              <div style={css(`margin-top:27.6px;border-top:1px solid var(--color-text);padding-top:18.4px;animation:ag-in .3s ease both`)}>
                <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:18.4px`)}>
                  <h2 style={css(`font-family:var(--font-heading);font-weight:400;font-size:26px;margin:0`)}>
                    {compare.name}
                  </h2>
                  <span style={css(`font-size:12px;color:var(--color-neutral-700)`)}>
                    {compare.summary}
                  </span>
                </div>
                <div style={css(`display:grid;grid-template-columns:1fr 1fr;gap:27.6px;margin-top:13.8px`)}>
                  <div>
                    <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-neutral-600);border-bottom:1px solid var(--color-divider);padding-bottom:6px`)}>
                      v14 — baseline
                    </div>
                    {(compare.left).map((r, _i) => (
                      <React.Fragment key={_i}>
                      <div style={css(`display:flex;justify-content:space-between;gap:9.2px;font-size:13px;padding:8px 0;border-bottom:1px solid var(--color-divider);color:${r.color}`)}>
                        <span>
                          {r.step}
                        </span>
                        <span style={css(`font-feature-settings:'tnum';color:var(--color-neutral-600)`)}>
                          {r.meta}
                        </span>
                      </div>
                      </React.Fragment>
                    ))}
                  </div>
                  <div>
                    <div style={css(`font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent-700);border-bottom:1px solid var(--color-divider);padding-bottom:6px`)}>
                      v15 — candidate
                    </div>
                    {(compare.right).map((r, _i) => (
                      <React.Fragment key={_i}>
                      <div style={css(`display:flex;justify-content:space-between;gap:9.2px;font-size:13px;padding:8px 0;border-bottom:1px solid var(--color-divider);color:${r.color}`)}>
                        <span>
                          {r.step}
                        </span>
                        <span style={css(`font-feature-settings:'tnum';color:var(--color-neutral-600)`)}>
                          {r.meta}
                        </span>
                      </div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
                <p style={css(`font-size:13px;line-height:1.7;color:var(--color-accent-800);margin:13.8px 0 0;max-width:74ch`)}>
                  {compare.verdict}
                </p>
              </div>
              </>
            ) : null}
            <div style={css(`margin-top:27.6px;border:1px solid var(--color-accent);border-radius:var(--radius-md);padding:18.4px`)}>
              <div style={css(`display:flex;align-items:baseline;justify-content:space-between;gap:18.4px;flex-wrap:wrap`)}>
                <span style={css(`font-family:var(--font-heading);font-size:22px`)}>
                  Deployment gate — planner v15
                </span>
                <span style={css(`font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${gate.color}`)}>
                  {gate.status}
                </span>
              </div>
              <p style={css(`font-size:13.5px;line-height:1.75;text-align:justify;max-width:76ch;margin:9.2px 0 0;color:var(--color-neutral-800)`)}>
                {gate.note}
              </p>
              <div style={css(`display:flex;gap:9.2px;margin-top:13.8px;flex-wrap:wrap`)}>
                {(gate.actions).map((g, _i) => (
                  <React.Fragment key={_i}>
                  <button className="hv0" onClick={g.go} style={css(`font-family:var(--font-body);font-size:13px;padding:9.2px 22px;border:1px solid ${g.border};color:${g.color};background:transparent;border-radius:var(--radius-md);cursor:pointer`)}>
                    {g.label}
                  </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
            <p style={css(`font-size:13.5px;line-height:1.8;text-align:justify;max-width:72ch;margin-top:22px;color:var(--color-neutral-800)`)}>
              The regressions come from two efficiency changes: v15 checks availability once across the whole window where v14 walked it day by day, so interior conflicts go unseen, and it raised the contact-dedupe threshold from 0.90 to 0.95, so genuine matches are written as new records. {gate.outlook}
            </p>
          </div>
          </>
        ) : null}
      </div>
    );
  }
}
