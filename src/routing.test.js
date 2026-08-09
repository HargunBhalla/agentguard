import { describe, it, expect } from 'vitest';
import { tabFromHash, TABS, DEFAULT_TAB } from './routing.js';

describe('tab routing', () => {
  it('round-trips every tab', () => {
    for (const tab of TABS) expect(tabFromHash(`#${tab}`)).toBe(tab);
  });

  it('accepts the #/tab form as well as #tab', () => {
    expect(tabFromHash('#/chaos')).toBe('chaos');
  });

  it('falls back to the default rather than rendering nothing', () => {
    // A stale link or a hand-edited URL should still land somewhere real.
    for (const bad of ['', '#', '#/', '#nope', '#Pipeline', '#../etc']) {
      expect(tabFromHash(bad)).toBe(DEFAULT_TAB);
    }
  });

  it('does not touch window when given an explicit hash', () => {
    expect(() => tabFromHash('#replay')).not.toThrow();
  });
});
