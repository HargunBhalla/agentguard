/**
 * Parse a CSS declaration string into a React style object.
 *
 * The prototype carried its styling as inline CSS text, much of it
 * interpolated per-item (`border:1px solid ${t.border}`). Keeping the strings
 * intact and parsing them here preserves the original source line-for-line
 * and keeps the markup readable; hand-converting every declaration to a
 * camelCased object literal would have obscured it for no gain.
 */
const cache = new Map();

const camel = (p) =>
  p.startsWith('--') ? p : p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function css(text) {
  if (!text) return undefined;
  const hit = cache.get(text);
  if (hit) return hit;

  const style = {};
  let depth = 0;
  let start = 0;
  // Split on top-level semicolons only — `color-mix(in srgb, a, b)` and
  // `url(data:...;base64,...)` both contain characters we must not split on.
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === ';' && depth === 0) || i === text.length) {
      const decl = text.slice(start, i).trim();
      start = i + 1;
      if (!decl) continue;
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      style[camel(decl.slice(0, colon).trim())] = decl.slice(colon + 1).trim();
    }
  }

  cache.set(text, style);
  return style;
}
