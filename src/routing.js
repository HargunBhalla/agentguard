/**
 * Tab routing.
 *
 * Tabs live in the URL hash rather than in component state alone, so Back and
 * Forward move between them, a reload keeps you where you were, and a tab can
 * be linked to directly. The hash is used in preference to a path because
 * Pages serves static files — a path route would 404 on refresh.
 */
export const TABS = ['pipeline', 'preflight', 'trace', 'chaos', 'evals'];

export const DEFAULT_TAB = 'pipeline';

/**
 * Read the current tab out of a hash. Anything unrecognised falls back to the
 * default rather than rendering an empty shell, so a hand-edited or stale URL
 * still lands somewhere real.
 */
export function tabFromHash(hash) {
  const raw = hash ?? (typeof window === 'undefined' ? '' : window.location.hash);
  const name = String(raw).replace(/^#\/?/, '');
  return TABS.includes(name) ? name : DEFAULT_TAB;
}
