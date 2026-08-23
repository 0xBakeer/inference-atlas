/**
 * `@atlas/core` — everything that must behave identically in the browser, in Node and
 * (re-implemented, golden-vector tested) in the Python harness.
 *
 * No filesystem, no network, no Node-only API: the config explorer recomputes fingerprints
 * live in the browser with the same code CI validates PRs with.
 */

export * from './types.js';
export { sha256Hex, sha256Short } from './hash.js';
export {
  canonicalizeArgs,
  normalizeKey,
  normalizeValue,
  normalizeNumber,
  byteCompare,
} from './canonical.js';
export type { CanonicalizeInput, CanonicalizeResult, CanonicalParam } from './canonical.js';
export { cellId, runId, parseRunId, engineMinor, resultPath, resultDir } from './ids.js';
export type { CellIdInput, ParsedRunId } from './ids.js';
export {
  checkPlausibility,
  activeWeightGb,
  bandwidthCeiling,
  tokensPerForwardPass,
} from './plausibility.js';
export type { PlausibilityIssue, PlausibilityInput } from './plausibility.js';
export { computeScores } from './scoring.js';
export type { ScoringInput, ScoringOutput, ScoredRun, RegistryCredits } from './scoring.js';
export { computeCoverage, emptyCell, minorsBehind } from './coverage.js';
export type { CoverageRegistry, CoverageOptions } from './coverage.js';
export { buildPacket, renderFlags, renderServeCommand, AGENT_RULES } from './packet.js';
export type { PacketSpec, PacketRegistry, PacketEngineEntry, PacketModelEntry } from './packet.js';
