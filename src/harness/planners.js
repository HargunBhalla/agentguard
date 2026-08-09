/**
 * The two planners under comparison.
 *
 * They share one body. Everything that separates v15 from v14 is in the two
 * settings below — which is the point: the regressions the replay suite catches
 * are not exotic bugs, they are two reasonable-looking efficiency changes.
 *
 *   perDayScan     v14 walks the requested window a day at a time. v15 collapses
 *                  that into a single window query — fewer calls, but a
 *                  reservation sitting in the interior of the window is invisible.
 *   dedupeThreshold  v14 merges a site contact at 0.90 similarity. v15 raised the
 *                  bar to 0.95, so genuine matches fall through and get created
 *                  as new records.
 */
function makePlanner({ id, label, perDayScan, dedupeThreshold }) {
  return {
    id,
    label,
    perDayScan,
    dedupeThreshold,

    run(goal, t) {
      switch (goal.kind) {
        case 'move': {
          const { unit, id: resId, from, to, event, customer } = goal;
          const avail = t.inventory.check({ unit, from, to, perDay: perDayScan, ignore: resId });
          if (avail.available) {
            t.inventory.release({ unit, id: resId });
            t.inventory.reserve({ unit, from, to, id: resId });
            t.calendar.update({ event, start: from });
            t.crm.update({ id: resId, patch: { stage: 'Rescheduled', customer_id: goal.customerId } });
            t.gmail.send({ to: customer, template: 'rental-reschedule' });
          }
          return;
        }

        case 'extend': {
          const { unit, id: resId, from, to } = goal;
          const avail = t.inventory.check({ unit, from, to, perDay: perDayScan, ignore: resId });
          if (avail.available) {
            // Nothing in the way as far as this planner can tell — take the
            // whole window. When the availability read was window-only, this
            // is where the double booking is created.
            t.inventory.release({ unit, id: resId });
            t.inventory.reserve({ unit, from, to, id: resId });
            t.crm.update({ id: resId, patch: { stage: 'Extended', customer_id: goal.customerId } });
          } else {
            // The scan found an interior conflict: extend only up to the day
            // before it and leave the rest for a human.
            const stop = goal.conflictStartsOn;
            const end = new Date(stop + 'T00:00:00Z');
            end.setUTCDate(end.getUTCDate() - 1);
            const trimmed = end.toISOString().slice(0, 10);
            t.inventory.release({ unit, id: resId });
            t.inventory.reserve({ unit, from, to: trimmed, id: resId });
            t.crm.update({
              id: resId,
              patch: { stage: 'Partially extended', customer_id: goal.customerId },
            });
          }
          return;
        }

        case 'swap': {
          const { fromUnit, toUnit, id: resId, from, to } = goal;
          const avail = t.inventory.check({ unit: toUnit, from, to, perDay: perDayScan });
          if (avail.available) {
            t.inventory.swap({ from: fromUnit, to: toUnit, id: resId });
            t.crm.update({ id: resId, patch: { unit: toUnit, customer_id: goal.customerId } });
          }
          return;
        }

        case 'merge-contact': {
          const found = t.crm.query({ candidate: goal.contact, threshold: dedupeThreshold });
          if (found.match) t.crm.merge({ into: found.match, contact: goal.contact });
          else t.crm.create({ contact: goal.contact });
          return;
        }

        case 'chase': {
          t.gmail.send({ to: goal.to, template: 'agreement-chase' });
          return;
        }

        case 'early-return': {
          t.inventory.release({ unit: goal.unit, id: goal.id });
          t.crm.update({
            id: goal.id,
            patch: { stage: 'Closed — prorated', customer_id: goal.customerId },
          });
          return;
        }

        default:
          throw new Error(`planner ${id} cannot handle goal kind "${goal.kind}"`);
      }
    },
  };
}

export const v14 = makePlanner({
  id: 'v14',
  label: 'v14 — baseline',
  perDayScan: true,
  dedupeThreshold: 0.9,
});

export const v15 = makePlanner({
  id: 'v15',
  label: 'v15 — candidate',
  perDayScan: false,
  dedupeThreshold: 0.95,
});
