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
| **Replay** | Six recorded cases replayed against the candidate planner, with a promotion gate. |

## How it's built

Vite + React, no other runtime dependencies. Two props on the root component
drive the whole prototype:

- `strictMode` — escalates every policy from its declared mode to a hard block.
- `simMs` — how long the shadow simulation takes to settle.

The source keeps a deliberate split, inherited from the design prototype this
was ported from:

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
