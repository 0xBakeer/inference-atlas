import { canonicalDistance, parseCanonical } from './diff.js';

export interface Neighbour<T> {
  item: T;
  distance: number;
  /** Keys whose values differ (or exist only on one side). */
  differing: string[];
}

/**
 * Nearest neighbours of a target canonical string among candidates. Distance = number of
 * resolved params that differ. Ties keep input order.
 */
export function nearestNeighbours<T>(
  targetCanonical: string,
  candidates: T[],
  canonicalOf: (t: T) => string,
  limit = 8,
): Neighbour<T>[] {
  const target = parseCanonical(targetCanonical);
  const out: Neighbour<T>[] = candidates.map((item) => {
    const other = parseCanonical(canonicalOf(item));
    const keys = new Set([...Object.keys(target), ...Object.keys(other)]);
    const differing = [...keys].filter((k) => target[k] !== other[k]).sort();
    return { item, distance: canonicalDistance(target, other), differing };
  });
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, limit);
}
