export type Better = 'higher' | 'lower';

export interface ParetoPoint {
  x: number;
  y: number;
}

/**
 * Indices of the points on the Pareto frontier, ordered by x ascending.
 * A point is dominated when another point is at least as good on both axes and strictly
 * better on one. Directions are configurable: TTFT is better lower, tok/s better higher.
 */
export function paretoFrontier(points: ParetoPoint[], xBetter: Better, yBetter: Better): number[] {
  const sx = xBetter === 'lower' ? 1 : -1; // sort so "better x" comes first
  const sy = yBetter === 'lower' ? -1 : 1; // after transform, larger ty is better
  const order = points
    .map((p, i) => ({ i, tx: sx * p.x, ty: sy * p.y }))
    .filter((p) => Number.isFinite(p.tx) && Number.isFinite(p.ty))
    .sort((a, b) => a.tx - b.tx || b.ty - a.ty);
  const out: number[] = [];
  let bestY = -Infinity;
  for (const p of order) {
    if (p.ty > bestY) {
      out.push(p.i);
      bestY = p.ty;
    }
  }
  // return in ascending raw x for drawing
  return out.sort((a, b) => points[a]!.x - points[b]!.x);
}
