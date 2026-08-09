# AgentGuard

A safety layer that sits between an AI agent's proposed tool calls and the
connectors that make them real. Every call is rehearsed against a shadow copy,
measured as a state diff, judged against policy, and only then executed — with
a checkpoint behind it.

This is an interactive prototype of the operator console, built around a single
worked scenario: a rental-yard agent moving an excavator reservation to Friday,
updating the CRM, and notifying the customer.

## Running it

```sh
npm install
npm run dev
```

## The five views

| Tab | What it shows |
| --- | --- |
| **Pipeline** | The interception path, and the seven stages a run passes through. |
| **Pre-flight** | The five proposed calls, their predicted state diffs, the policy checks each one trips, and approve/block controls. |
| **Live trace** | Span timeline for run 8812, expandable to arguments and results, with a compensating rollback. |
| **Chaos lab** | Inject a fault into a recorded run and watch how recovery behaves. |
| **Replay** | The eval harness output — six recorded cases actually replayed against the candidate planner, with a promotion gate. |

## The harness

`src/harness/` is a small execution engine. The interactive tabs render what it
produces rather than fixtures:

| Tab | What runs |
| --- | --- |
| **Pre-flight** | Each proposed call is rehearsed against a throwaway world. Its diff, blast radius and policy verdicts are read back off the result. |
| **Live trace** | Run 8812's connector calls, executed against a shadow copy, with the arguments and results they really produced. The planning, discovery and simulate spans are derived rather than executed — the simulate span reports the diff and violation counts the rehearsal found. |
| **Chaos lab** | The approved plan is replayed with a fault injected, driven through retry-with-backoff and compensating rollback. Duplicates are counted in the world; consistency is a diff against a clean run. |
| **Replay** | Six recorded cases replayed against two planners, with divergence computed from the traces. |

Policies are predicates, not labels. `no_double_booked_equipment` fires because
the rehearsal left a unit with overlapping holds — turn that policy off and the
call goes green, because nothing is asserting it was ever bad.

```sh
npm test         # the harness's own tests
npm run eval     # exits non-zero if the candidate regresses a case
```

```sh
npm run eval     # exits non-zero if the candidate regresses a case
```

A run works like this: each case seeds a **shadow world** (inventory, calendar,
CRM, mail), the planner drives it through an **instrumented tool API** that
records every call, and the world it leaves behind is checked against
**invariants**. A run that violates one also pays the cost of the compensating
rollback, so a broken case comes out slower as well as wrong.

The two planners share one body. Everything separating them is two settings:

| | v14 baseline | v15 candidate |
| --- | --- | --- |
| Availability read | day by day | one window query |
| Contact dedupe threshold | 0.90 | 0.95 |

Both look like reasonable efficiency changes, and both are regressions. The
window query cannot see a reservation sitting in the *interior* of the
requested window, so v15 double-books a unit over an existing weekend
reservation. The raised dedupe threshold drops a genuine 0.93 match, so a site
contact is written as a new record instead of merged. Neither failure is
declared anywhere — the suite finds them by running the planners and checking
the resulting state.

### Bring your own planner

Implement `run(goal, tools)` and pass it in:

```js
import { compareSuites } from './src/harness/index.js';
compareSuites(v14, myPlanner);
```

## How it's built

Vite + React, no other runtime dependencies. Two props on the root component
drive the whole prototype:

- `strictMode` — escalates every policy from its declared mode to a hard block.
- `simMs` — how long the shadow simulation takes to settle.

The source keeps a deliberate split, inherited from the design prototype this
was ported from:

- `src/harness/` — the engine described above: `world.js` (shadow state),
  `tools.js` (instrumented tool surface), `invariants.js`, `shadow.js`
  (pre-flight rehearsal), `chaos.js` (fault injection), `planners.js` and
  `index.js` (the replay runner). Framework-free, so it runs in the browser and
  from Node without change.
- `src/AgentGuard.jsx` — `renderVals()` holds the scenario data and derives a
  flat bag of view values from state and props. `render()` binds that bag to
  markup and contains no logic of its own. Editing behaviour means editing
  `renderVals()`; editing layout means editing `render()`.
- `src/css.js` — the prototype carried its styling as inline CSS strings, much
  of it interpolated per item. `css()` parses those strings into React style
  objects, which keeps the markup readable and the port faithful.
- `src/styles/design.css` — the design system: colour ramps, type scale,
  spacing and radius tokens. This is the source of truth for the look.
- `src/styles/global.css` — element defaults, keyframes, and the two hover
  styles that inline styles cannot express.

Fonts (Cormorant Garamond and Lora) are self-hosted from `public/fonts`, so
the app has no network dependencies at runtime.
