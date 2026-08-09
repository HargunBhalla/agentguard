/**
 * The recorded cases the suite replays.
 *
 * Each carries the seed state its run starts from and the goal handed to the
 * planner. Nothing here says which planner should pass — that falls out of
 * running them.
 */
export const CASES = [
  {
    name: 'Move a rental, notify the customer',
    actions: 'inventory.reserve, calendar.update, gmail.send',
    seed: {
      units: { 184: { reservations: [{ id: 'R-2118', from: '2026-08-12', to: '2026-08-13' }] } },
      reservations: { 'R-2118': { stage: 'Scheduled', customer_id: 'ABC' } },
    },
    goal: {
      kind: 'move',
      unit: '184',
      id: 'R-2118',
      from: '2026-08-14',
      to: '2026-08-15',
      event: 'dlv-184',
      customer: 'marcus.hale@abcconstruction.com',
      customerId: 'ABC',
    },
  },
  {
    name: 'Extend a rental over a booked weekend',
    actions: 'inventory.reserve ×2',
    seed: {
      units: {
        184: {
          reservations: [
            { id: 'R-2118', from: '2026-08-12', to: '2026-08-14' },
            // Sits in the middle of the window the extension asks for. Only a
            // day-by-day availability read notices it.
            { id: 'R-2209', from: '2026-08-15', to: '2026-08-16' },
          ],
        },
      },
      reservations: { 'R-2118': { stage: 'Scheduled', customer_id: 'ABC' } },
    },
    goal: {
      kind: 'extend',
      unit: '184',
      id: 'R-2118',
      from: '2026-08-12',
      to: '2026-08-17',
      conflictStartsOn: '2026-08-15',
      customerId: 'ABC',
    },
  },
  {
    name: 'Swap the assigned unit after a breakdown',
    actions: 'inventory.swap, crm.update',
    seed: {
      units: {
        184: { reservations: [{ id: 'R-2118', from: '2026-08-12', to: '2026-08-14' }] },
        219: { reservations: [] },
      },
      reservations: { 'R-2118': { stage: 'Scheduled', customer_id: 'ABC' } },
    },
    goal: {
      kind: 'swap',
      fromUnit: '184',
      toUnit: '219',
      id: 'R-2118',
      from: '2026-08-12',
      to: '2026-08-14',
      customerId: 'ABC',
    },
  },
  {
    name: 'Duplicate site contact merge',
    actions: 'crm.create, crm.merge',
    seed: {
      contacts: [{ email: 'marcus.hale@abcconstruction.com', name: 'Marcus Hale' }],
    },
    goal: {
      kind: 'merge-contact',
      contact: { email: 'marcus.hales@abcconstruction.com', name: 'Marcus Hale' },
    },
  },
  {
    name: 'Chase an unsigned rental agreement',
    actions: 'gmail.send',
    seed: {},
    goal: { kind: 'chase', to: 'marcus.hale@abcconstruction.com' },
  },
  {
    name: 'Early return, prorate the invoice',
    actions: 'inventory.release, crm.update',
    seed: {
      units: { 184: { reservations: [{ id: 'R-2118', from: '2026-08-12', to: '2026-08-17' }] } },
      reservations: { 'R-2118': { stage: 'Scheduled', customer_id: 'ABC' } },
    },
    goal: { kind: 'early-return', unit: '184', id: 'R-2118', customerId: 'ABC' },
  },
];
