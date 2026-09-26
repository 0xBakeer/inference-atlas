/** Shard types now live in @atlas/core (shards.ts); this shim keeps app import paths stable. */
export type {
  Manifest,
  Registry,
  RegistryEngine,
  RegistryModel,
  Stats,
  IndexRow,
  ContributorRow,
  CoverageMap,
  EngineVersion,
} from '@atlas/core';
