import React from 'react';
import { css } from './css.js';

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
    { n: '7', name: 'Tracing, replay & evals', note: 'Spans recorded and replayed against the candidate planner.', tab: 'replay', status: '2 regressions', tone: 'gold' }
  ];

  state = { tab: 'pipeline', sim: 'idle', selId: 'a1', decisions: {},
    policyOn: { p1: true, p2: true, p3: true, p4: false },
    openSpans: { s5: true }, rollback: 'none', chaos: 'idle', chaosLog: [], openCase: null,
    connector: 'gmail', fault: 'f1', stepId: 'gmail.send', mods: {} };

  policyDefs = [
    { id: 'p1', name: 'No double-booked equipment', mode: 'hard block', sev: 'blocked' },
    { id: 'p2', name: 'Reservation stays inside the contract window', mode: 'hold for review', sev: 'review' },
    { id: 'p3', name: 'No deletions on shared calendars', mode: 'hard block', sev: 'blocked' },
    { id: 'p4', name: 'No bulk send over 50 recipients', mode: 'hold for review', sev: 'review' }
  ];

  actionDefs = [
    { id: 'a1', tool: 'inventory.reserve', trips: ['p1'],
      risk: 'Risk: high — execution blocked. Excavator #184 is already booked Friday.',
      alt: 'Suggested alternative: excavator #219, same 8-ton class, available Fri–Mon at the same rate. Swapping the unit clears the invariant without moving the date.',
      summary: 'Hold excavator #184 for Fri 14 – Mon 17 Aug',
      detail: 'Moving the rental to Friday extends the hold across the weekend. Shadow execution wrote the reservation into the sandbox inventory service and found unit #184 already committed to reservation R-2209 from Saturday morning.',
      blast: 'Blast radius: 1 unit · collides with an existing reservation',
      diff: [{ field: 'unit.184.status', before: 'Available Fri', after: 'Reserved Fri–Mon' }, { field: 'reservation.R-2118.window', before: 'Wed 12 – Sat 15', after: 'Fri 14 – Mon 17' }, { field: 'conflicts.open', before: '0', after: '1 (R-2209)' }] },
    { id: 'a2', tool: 'calendar.update', trips: [], summary: 'Move delivery window to Fri 14 Aug, 07:00',
      detail: 'The delivery event sits on the dispatch calendar with the driver and the yard lead as attendees. Both are free in the new window, and the event carries a restorable checkpoint.',
      blast: 'Blast radius: 1 event · 2 attendees notified · reversible',
      diff: [{ field: 'event.start', before: 'Wed 12 Aug 07:00', after: 'Fri 14 Aug 07:00' }, { field: 'attendee.notices', before: '0', after: '2' }] },
    { id: 'a3', tool: 'crm.update', trips: [], summary: 'Reschedule reservation R-2118 on ABC Construction',
      detail: 'The rental record on the ABC Construction account is updated to the new window and the owning salesperson is flagged for a follow-up. Inside the agent’s scoped permission set.',
      blast: 'Blast radius: 1 record · reversible from checkpoint',
      diff: [{ field: 'reservation.stage', before: 'Scheduled', after: 'Rescheduled' }, { field: 'account.last_touch', before: '2026-07-30', after: '2026-08-09' }] },
    { id: 'a4', tool: 'gmail.send', trips: [], summary: 'Notify Marcus Hale — new delivery window',
      detail: 'A single confirmation to the site contact on file, quoting the new window and the unit number. No attachments, no account data in the body.',
      blast: 'Blast radius: 1 external recipient · irreversible once sent',
      diff: [{ field: 'messages.sent', before: '0', after: '1' }, { field: 'thread.labels', before: '—', after: '+rental-reschedule' }] },
    { id: 'a5', tool: 'gmail.send', trips: ['p4'], summary: 'Yard-wide schedule digest to 68 recipients',
      detail: 'The planner expanded “update the team” into a digest addressed to every dispatcher and driver on the yard distribution list — 68 recipients for a change that affects two of them.',
      blast: 'Blast radius: 68 internal recipients · irreversible once sent',
      diff: [{ field: 'messages.sent', before: '0', after: '68' }, { field: 'recipients.distinct', before: '0', after: '68' }] }
  ];

  spanDefs = [
    { id: 's1', name: 'llm.plan', left: 0, width: 16, ms: '820ms', status: 'ok', args: '{\n  "goal": "move ABC excavator to Friday,\\n           update salesperson, notify customer"\n}', result: '{\n  "steps": 7,\n  "tools": ["crm","inventory","calendar","gmail"]\n}' },
    { id: 's2', name: 'composio.tools.discover', left: 16, width: 9, ms: '290ms', status: 'ok', args: '{\n  "connections": ["gmail","google_calendar","rentalcrm"]\n}', result: '{\n  "tools": 24,\n  "auth": "all sessions valid"\n}' },
    { id: 's3', name: 'crm.query', left: 25, width: 8, ms: '350ms', status: 'ok', args: '{\n  "object": "Reservation",\n  "account": "ABC Construction"\n}', result: '{\n  "records": 1,\n  "id": "R-2118",\n  "unit": "184"\n}' },
    { id: 's4', name: 'inventory.check', left: 33, width: 10, ms: '420ms', status: 'ok', args: '{\n  "unit": "184",\n  "window": "2026-08-14/2026-08-17"\n}', result: '{\n  "available": false,\n  "conflict": "R-2209"\n}' },
    { id: 's5', name: 'agentguard.simulate', left: 43, width: 16, ms: '690ms', status: 'shadow', args: '{\n  "mode": "shadow",\n  "actions": 5\n}', result: '{\n  "diffs": 5,\n  "side_effects": 0,\n  "violations": 1\n}' },
    { id: 's6', name: 'calendar.update', left: 59, width: 22, ms: '1.10s', status: 'retry 2/3', args: '{\n  "event": "dlv-184",\n  "start": "2026-08-14T07:00"\n}', result: '{\n  "error": "429 rateLimitExceeded",\n  "retry_after": "30s"\n}' },
    { id: 's7', name: 'gmail.send', left: 81, width: 14, ms: '480ms', status: 'ok', args: '{\n  "to": "marcus.hale@abcconstruction.com",\n  "template": "rental-reschedule"\n}', result: '{\n  "sent": 1,\n  "checkpoint": "ck-8812-03"\n}' }
  ];

  faultDefs = [
    { id: 'f1', name: '429 rate limit', note: 'Provider throttles mid-batch' },
    { id: 'f2', name: 'Timeout', note: 'No response after 30s' },
    { id: 'f3', name: 'Auth token expired', note: 'Composio session refresh fails once' },
    { id: 'f4', name: 'Partial write', note: 'Reservation lands, notification does not' },
    { id: 'f5', name: '500 from provider', note: 'Upstream error, retryable' },
    { id: 'f6', name: 'Malformed JSON', note: 'Tool returns an unparseable payload' },
    { id: 'f7', name: 'Stale inventory', note: 'Availability read is 40s out of date' }
  ];

  invariantDefs = [
    { expr: 'inventory.available >= 0', ok: true },
    { expr: 'no_overlap(unit, window)', ok: false },
    { expr: 'external_email_count <= 10', ok: false },
    { expr: 'reservation.customer_id != None', ok: true },
    { expr: 'discount <= 20%', ok: true }
  ];

  sagaDefs = [
    { step: 'inventory.reserve — #184', state: 'committed', undo: 'Reservation released; unit returned to Wed–Sat.' },
    { step: 'crm.update — R-2118', state: 'committed', undo: 'Stage reverted to Scheduled; last_touch restored.' },
    { step: 'calendar.update — dlv-184', state: 'failed', undo: 'Nothing to undo — the write never landed.' },
    { step: 'gmail.send — Marcus Hale', state: 'not run', undo: 'Skipped; no notice went out.' }
  ];

  canaryDefs = [
    { metric: 'Task success', old: '91%', cand: '96%', good: true },
    { metric: 'Tool calls per run', old: '8.2', cand: '6.4', good: true },
    { metric: 'Latency', old: '4.8s', cand: '3.5s', good: true },
    { metric: 'Policy errors', old: '0.4%', cand: '0.1%', good: true },
    { metric: 'Recovery rate', old: '72%', cand: '91%', good: true },
    { metric: 'Invariant violations', old: '0', cand: '2', good: false }
  ];

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

  modifierDefs = [
    { id: 'persist', label: 'Persist failure (every retry fails)' },
    { id: 'expire', label: 'Expire OAuth token mid-run' },
    { id: 'corrupt', label: 'Corrupt response payload' }
  ];

  caseDefs = [
    { name: 'Move a rental, notify the customer', actions: 'inventory.reserve, calendar.update, gmail.send', v14: 'pass', v15: 'pass', delta: '−40ms' },
    { name: 'Extend a rental over a booked weekend', actions: 'inventory.reserve ×2', v14: 'pass', v15: 'fail', delta: '+610ms' },
    { name: 'Swap the assigned unit after a breakdown', actions: 'inventory.swap, crm.update', v14: 'pass', v15: 'pass', delta: '−12ms' },
    { name: 'Duplicate site contact merge', actions: 'crm.create, crm.merge', v14: 'pass', v15: 'fail', delta: '+95ms' },
    { name: 'Chase an unsigned rental agreement', actions: 'gmail.send', v14: 'pass', v15: 'pass', delta: '+8ms' },
    { name: 'Early return, prorate the invoice', actions: 'inventory.release, crm.update', v14: 'pass', v15: 'pass', delta: '−3ms' }
  ];

  compareData = {
    1: { summary: 'divergence at step 2 · double booking',
      left: [ { step: 'llm.plan', meta: '8 steps' }, { step: 'inventory.check (per day)', meta: '4 calls' },
        { step: 'conflict found', meta: 'Sat · R-2209' }, { step: 'inventory.reserve', meta: 'held' },
        { step: 'policy: double booking', meta: 'clear' }, { step: 'result', meta: 'pass' } ],
      right: [ { step: 'llm.plan', meta: '6 steps' },
        { step: 'inventory.check (window only)', meta: '1 call', color: 'var(--color-accent-800)' },
        { step: 'no conflict seen', meta: 'weekend not scanned', color: 'var(--color-accent-800)' },
        { step: 'inventory.reserve', meta: 'overlaps R-2209', color: 'var(--color-accent-800)' },
        { step: 'policy: double booking', meta: 'violated', color: 'var(--color-accent-800)' },
        { step: 'result', meta: 'fail — held', color: 'var(--color-accent-800)' } ],
      verdict: 'v15 collapses the per-day availability checks into one window query and stops seeing interior conflicts. Faster, but the excavator is booked over an existing weekend reservation and the invariant fires. Either restore the per-day scan or make inventory.check return interior overlaps.' },
    3: { summary: 'divergence at step 2 · duplicate write',
      left: [ { step: 'crm.query (dedupe)', meta: 'threshold 0.90' }, { step: 'match found', meta: '0.93' },
        { step: 'crm.merge', meta: '1 record' }, { step: 'result', meta: 'pass' } ],
      right: [ { step: 'crm.query (dedupe)', meta: 'threshold 0.95', color: 'var(--color-accent-800)' },
        { step: 'no match', meta: '0.93 < 0.95', color: 'var(--color-accent-800)' },
        { step: 'crm.create', meta: '1 new record', color: 'var(--color-accent-800)' },
        { step: 'result', meta: 'fail — duplicate', color: 'var(--color-accent-800)' } ],
      verdict: 'The dedupe threshold moved from 0.90 to 0.95 in v15, so a genuine site contact falls through and a duplicate is created instead of merged. Revert the threshold or add a secondary email-domain check before creating.' }
  };

  compareFor(i) {
    if (i == null) return { name: '', summary: '', left: [], right: [], verdict: '' };
    const c = this.caseDefs[i];
    const d = this.compareData[i] || {
      summary: 'no divergence · both versions agree',
      left: [{ step: 'llm.plan', meta: 'ok' }, { step: c.actions, meta: 'ok' }, { step: 'result', meta: 'pass' }],
      right: [{ step: 'llm.plan', meta: 'ok' }, { step: c.actions, meta: 'ok' }, { step: 'result', meta: 'pass' }],
      verdict: 'Both versions produce the same actions and the same final state. Latency moved ' + c.delta + '.'
    };
    const tint = rows => rows.map(r => ({ ...r, color: r.color || 'var(--color-text)' }));
    return { name: c.name, summary: d.summary, left: tint(d.left), right: tint(d.right), verdict: d.verdict };
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

  experiment() {
    const st = this.state;
    const f = this.faultDefs.find(x => x.id === st.fault) || this.faultDefs[0];
    const list = this.stepDefs[st.connector || 'gmail'];
    const step = (list.find(s => s.id === st.stepId) || list[0]).id;
    const m = st.mods || {};
    const ink = 'var(--color-neutral-800)', gold = 'var(--color-accent-700)', deep = 'var(--color-accent-800)';
    const log = [
      { t: '0.00s', text: 'Replaying recorded run 8812 against the shadow copy.', color: ink },
      { t: '1.24s', text: 'Injected ' + f.name + ' at ' + step + ' (batch 3 of 9).', color: gold }
    ];
    let outcome;
    if (m.corrupt) {
      log.push(
        { t: '1.31s', text: 'Response payload failed schema validation — 2 fields unreadable.', color: deep },
        { t: '1.33s', text: 'Agent proceeded on a partial read and re-issued ' + step + '.', color: deep },
        { t: '2.02s', text: 'Idempotency key matched on 1 of 2 calls — a duplicate reservation landed.', color: deep },
        { t: '2.40s', text: 'Rollback released the duplicate, but the CRM reservation stage is now ambiguous.', color: gold }
      );
      outcome = { headline: 'Recovered — but not cleanly.', border: 'var(--color-accent)', color: 'var(--color-accent-800)',
        checks: [
          { label: 'Recovered', value: 'Partially', note: 'Run completed after a manual-review hold.', color: 'var(--color-accent-700)' },
          { label: 'Duplicate actions', value: '1 detected', note: 'inventory.reserve fired twice; one released.', color: 'var(--color-accent-800)' },
          { label: 'State consistency', value: 'Diverged', note: 'Reservation window does not match the trace.', color: 'var(--color-accent-800)' }
        ] };
    } else if (m.persist) {
      log.push(
        { t: '1.26s', text: 'Attempt 1 failed. Backing off 2s.', color: ink },
        { t: '3.31s', text: 'Attempt 2 failed. Backing off 4s.', color: ink },
        { t: '7.40s', text: 'Attempt 3 failed. Retry budget exhausted.', color: deep },
        { t: '7.42s', text: 'Compensating saga to ck-8812-03 — reservation released, calendar event restored, notice recalled.', color: gold },
        { t: '8.10s', text: 'Run halted. Incident filed as INC-2261.', color: ink }
      );
      outcome = { headline: 'Failed safe. No duplicates, no drift.', border: 'var(--color-accent)', color: 'var(--color-accent-700)',
        checks: [
          { label: 'Recovered', value: 'No — halted', note: 'Retry budget spent; run stopped deliberately.', color: 'var(--color-accent-700)' },
          { label: 'Duplicate actions', value: 'None', note: 'Idempotency keys held across all 3 retries.', color: 'var(--color-neutral-700)' },
          { label: 'State consistency', value: 'Clean', note: 'Shadow state matches the pre-run checkpoint.', color: 'var(--color-neutral-700)' }
        ] };
    } else if (m.expire) {
      log.push(
        { t: '1.28s', text: 'OAuth token expired mid-run. Refresh requested.', color: gold },
        { t: '2.10s', text: 'Refresh succeeded after 1 failure. Session re-established.', color: ink },
        { t: '2.44s', text: 'Resumed ' + step + ' from the last acknowledged batch.', color: ink },
        { t: '3.90s', text: 'Run completed. Reservation, calendar and notice all consistent.', color: ink }
      );
      outcome = { headline: 'Recovered cleanly.', border: 'var(--color-divider)', color: 'var(--color-text)',
        checks: [
          { label: 'Recovered', value: 'Yes · 2.6s', note: 'Token refreshed and the run resumed in place.', color: 'var(--color-neutral-800)' },
          { label: 'Duplicate actions', value: 'None', note: 'Resumed from the last acknowledged batch.', color: 'var(--color-neutral-700)' },
          { label: 'State consistency', value: 'Clean', note: 'Final state equals the predicted diff.', color: 'var(--color-neutral-700)' }
        ] };
    } else {
      log.push(
        { t: '1.26s', text: 'Attempt 1 failed. Backing off 2s.', color: ink },
        { t: '3.30s', text: 'Attempt 2 succeeded. Batch 3 of 9 acknowledged.', color: ink },
        { t: '5.80s', text: 'Run completed. Reservation, calendar and notice all consistent.', color: ink }
      );
      outcome = { headline: 'Recovered cleanly.', border: 'var(--color-divider)', color: 'var(--color-text)',
        checks: [
          { label: 'Recovered', value: 'Yes · 1 retry', note: 'Backoff absorbed the fault inside the SLA.', color: 'var(--color-neutral-800)' },
          { label: 'Duplicate actions', value: 'None', note: 'Idempotency key deduplicated the retry.', color: 'var(--color-neutral-700)' },
          { label: 'State consistency', value: 'Clean', note: 'Final state equals the predicted diff.', color: 'var(--color-neutral-700)' }
        ] };
    }
    return { log, outcome };
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
        const map = {
          held: { status: 'held at 10% canary', color: 'var(--color-accent-700)',
            note: '42 recorded runs replayed against v15. Two fail on the double-booking invariant, so the candidate stays behind the canary — 10% of live rental traffic, every action still pre-flighted.' },
          promoted: { status: 'promoted to 100%', color: 'var(--color-accent-800)',
            note: 'v15 is now the default planner for all rental traffic. The two failing cases were accepted with an amended invariant; AgentGuard will hold any run that trips it and page the on-call owner.' },
          blocked: { status: 'blocked · rolled back to v14', color: 'var(--color-accent-800)',
            note: 'v15 is withdrawn from the canary and v14 restored. The candidate keeps receiving shadow traffic, so the replay suite continues to fill without any production exposure.' }
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
                  42 recorded runs, replayed against v15.
                </h1>
              </div>
              <span style={css(`font-size:12.5px;color:var(--color-accent-700);border:1px solid var(--color-accent);padding:6px 13.8px;border-radius:var(--radius-md);white-space:nowrap`)}>
                2 regressions · rollout held at 10%
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
              Both regressions come from the same shortcut: v15 checks availability once across the whole window where v14 walked it day by day, so interior conflicts go unseen and the double-booking invariant fires mid-run. Rollout stays held until the replay suite is green or the check is restored.
            </p>
          </div>
          </>
        ) : null}
      </div>
    );
  }
}
