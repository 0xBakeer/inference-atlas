/** Linear scales and "nice" tick values — the 1/2/5 ladder every plotting library uses. */

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const fn = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  fn.domain = domain;
  fn.range = range;
  return fn;
}

/** Round tick step to 1/2/5 × 10^n covering [min,max] with about `count` ticks. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  // d3's thresholds: geometric midpoints of the 1/2/5/10 ladder.
  const step =
    (norm >= Math.sqrt(50) ? 10 : norm >= Math.sqrt(10) ? 5 : norm >= Math.SQRT2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Domain padded a little so points do not sit on the border. */
export function padDomain(min: number, max: number, frac = 0.05): [number, number] {
  if (min === max) {
    const pad = Math.abs(min) * frac || 1;
    return [min - pad, max + pad];
  }
  const pad = (max - min) * frac;
  return [min - pad, max + pad];
}
