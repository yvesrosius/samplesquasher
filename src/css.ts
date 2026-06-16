import type { CSSProperties } from 'react';

/**
 * Convert a raw CSS declaration string (as used throughout the Stem Squash
 * design prototype, e.g. `"display:flex;gap:8px;"`) into a React style object.
 *
 * This lets us reuse the design's exact inline-style strings verbatim — both
 * the static ones in the template and the dynamic ones computed in JS — which
 * keeps the port pixel-faithful to the original.
 */
export function css(decls: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of decls.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!prop) continue;
    // `box-sizing` -> `boxSizing`, `-webkit-font-smoothing` -> `WebkitFontSmoothing`
    const key = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = val;
  }
  return out as CSSProperties;
}
