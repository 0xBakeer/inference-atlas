import type {
  CompiledIndexRow,
  Contributor,
  ContributorScoreBreakdown,
  SiteConfig,
} from './types.js';

/**
 * Contributor points — DESIGN §8.6, weights from `site/config.json`.
 *
 * The scoring exists to point people at grey squares, so it is deliberately lopsided:
 * filling a cell nobody has measured is worth several times re-running a popular one, and a
 * contributor's fifth run in the *same* cell is worth a fraction of their first. Registering
 * a new piece of hardware, a new model or a new engine is worth the most of all, because it
 * widens the map instead of colouring it in.
 *
 * Everything here is pure and deterministic: same rows in, same points out, regardless of
 * the order they are passed in.
 */

const DEFAULT_WEIGHTS = {
  fill_empty_cell: 10,
  additional_run: 2,
  reproduction: 6,
  new_hardware: 25,
  new_model: 15,
  new_engine: 40,
  new_quant: 5,
  new_workload: 8,
  gotcha: 2,
  sweep_point: 0.5,
  eval_run: 4,
  wanted_bonus: 5,
};

const DEFAULT_DIMINISHING = {
  per_cell_factor: 0.5,
  min_factor: 0.1,
  max_runs_counted_per_cell: null as number | null,
};

/**
 * The identity a login belongs to, for grouping.
 *
 * GitHub logins are unique but not case-sensitive, and the same person reaches this file
 * spelled two ways: `provenance.login` is the login as the contributor's result file carries
 * it, while a registry credit is read out of a `…@users.noreply.github.com` address. One
 * casing difference used to split a person into two rows on the leaderboard, half their
 * points on each. Group on this; display the spelling that came with the data.
 */
export function loginKey(login: string): string {
  return login.trim().toLowerCase();
}

/** Who first registered each piece of the registry. `tools/build` derives this from git history. */
export interface RegistryCredits {
  hardware?: Record<string, string>;
  models?: Record<string, string>;
  engines?: Record<string, string>;
  quants?: Record<string, string>;
  workloads?: Record<string, string>;
}

export interface ScoringInput {
  rows: CompiledIndexRow[];
  /** Only `site.scoring` is read; omit it for the defaults. */
  site?: Pick<SiteConfig, 'scoring'> | null;
  registryCredits?: RegistryCredits | null;
  /** Cell ids that were on the wanted queue when they were filled, if the build tracks that. */
  wantedCellIds?: Iterable<string> | null;
}

export interface ScoredRun {
  run_id: string;
  login: string;
  cell_id: string;
  points: number;
  /** `fill` = first run in the cell, `reproduction` = agrees with someone else's run. */
  role: 'fill' | 'reproduction' | 'additional';
  factor: number;
}

export interface ScoringOutput {
  contributors: Contributor[];
  runs: ScoredRun[];
}

function emptyBreakdown(): ContributorScoreBreakdown {
  return {
    cells_filled: 0,
    reproductions: 0,
    additional_runs: 0,
    sweep_points: 0,
    eval_runs: 0,
    gotchas: 0,
    registry_hardware: 0,
    registry_models: 0,
    registry_engines: 0,
    registry_quants: 0,
    registry_workloads: 0,
  };
}

/** Runs are scored in submission order; ties broken by run_id so the result is stable. */
function chronological(rows: CompiledIndexRow[]): CompiledIndexRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.provenance.submitted_at ?? a.provenance.started_at ?? '';
    const tb = b.provenance.submitted_at ?? b.provenance.started_at ?? '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0;
  });
}

export function computeScores(input: ScoringInput): ScoringOutput {
  const weights = { ...DEFAULT_WEIGHTS, ...(input.site?.scoring?.weights ?? {}) };
  const diminishing = { ...DEFAULT_DIMINISHING, ...(input.site?.scoring?.diminishing ?? {}) };
  const wanted = new Set(input.wantedCellIds ?? []);

  const rows = chronological(input.rows);

  const seenCells = new Set<string>();
  /** cell + config + workload → identities that have already run it, for reproduction credit. */
  const seenExact = new Map<string, Set<string>>();
  /** identity + cell → how many runs that person already has there, for diminishing returns. */
  const perLoginCell = new Map<string, number>();

  const contributors = new Map<string, Contributor>();
  const scoredRuns: ScoredRun[] = [];

  for (const row of rows) {
    const login = row.provenance.login;
    const key = loginKey(login);
    const contributor = contributors.get(key) ?? {
      login,
      user_id: row.provenance.user_id ?? null,
      runs: 0,
      cells_filled: 0,
      reproductions: 0,
      hardware_ids: [],
      first_seen: null,
      last_seen: null,
      points: 0,
      breakdown: emptyBreakdown(),
    };
    contributors.set(key, contributor);
    if (contributor.user_id === null && row.provenance.user_id != null) {
      contributor.user_id = row.provenance.user_id;
    }

    const exactKey = `${row.cell_id}|${row.config_id}|${row.workload_id}`;
    const priorLogins = seenExact.get(exactKey) ?? new Set<string>();
    const isFill = !seenCells.has(row.cell_id);
    const isReproduction = !isFill && priorLogins.size > 0 && !priorLogins.has(key);

    const perCellKey = `${key}|${row.cell_id}`;
    const priorOwnRuns = perLoginCell.get(perCellKey) ?? 0;
    const capped =
      diminishing.max_runs_counted_per_cell != null &&
      priorOwnRuns >= diminishing.max_runs_counted_per_cell;
    const factor = capped
      ? 0
      : Math.max(diminishing.min_factor ?? 0, Math.pow(diminishing.per_cell_factor, priorOwnRuns));

    let base: number;
    let role: ScoredRun['role'];
    if (isFill) {
      base = weights.fill_empty_cell;
      role = 'fill';
    } else if (isReproduction) {
      base = weights.reproduction;
      role = 'reproduction';
    } else {
      base = weights.additional_run;
      role = 'additional';
    }

    const sweepPoints = row.sweep_points ?? 0;
    const gotchas = row.gotchas ?? 0;
    let extra = sweepPoints * weights.sweep_point + gotchas * weights.gotcha;
    if (row.kind === 'eval') extra += weights.eval_run;
    if (isFill && wanted.has(row.cell_id)) extra += weights.wanted_bonus;

    const points = (base + extra) * factor;

    contributor.points += points;
    contributor.runs += 1;
    contributor.breakdown.sweep_points += sweepPoints;
    contributor.breakdown.gotchas += gotchas;
    if (row.kind === 'eval') contributor.breakdown.eval_runs += 1;
    if (role === 'fill') {
      contributor.cells_filled += 1;
      contributor.breakdown.cells_filled += 1;
    } else if (role === 'reproduction') {
      contributor.reproductions += 1;
      contributor.breakdown.reproductions += 1;
    } else {
      contributor.breakdown.additional_runs += 1;
    }
    if (!contributor.hardware_ids.includes(row.hardware.id)) {
      contributor.hardware_ids.push(row.hardware.id);
    }
    const when = row.provenance.submitted_at ?? row.provenance.started_at ?? null;
    if (when) {
      if (contributor.first_seen === null || when < contributor.first_seen) {
        contributor.first_seen = when;
      }
      if (contributor.last_seen === null || when > contributor.last_seen) {
        contributor.last_seen = when;
      }
    }

    scoredRuns.push({
      run_id: row.run_id,
      login: contributor.login,
      cell_id: row.cell_id,
      points,
      role,
      factor,
    });

    seenCells.add(row.cell_id);
    priorLogins.add(key);
    seenExact.set(exactKey, priorLogins);
    perLoginCell.set(perCellKey, priorOwnRuns + 1);
  }

  const credits = input.registryCredits ?? {};
  const creditKinds: Array<[keyof RegistryCredits, number, keyof ContributorScoreBreakdown]> = [
    ['hardware', weights.new_hardware, 'registry_hardware'],
    ['models', weights.new_model, 'registry_models'],
    ['engines', weights.new_engine, 'registry_engines'],
    ['quants', weights.new_quant, 'registry_quants'],
    ['workloads', weights.new_workload, 'registry_workloads'],
  ];
  for (const [kind, weight, field] of creditKinds) {
    for (const login of Object.values(credits[kind] ?? {})) {
      const key = loginKey(login);
      const contributor =
        contributors.get(key) ??
        ({
          login,
          user_id: null,
          runs: 0,
          cells_filled: 0,
          reproductions: 0,
          hardware_ids: [],
          first_seen: null,
          last_seen: null,
          points: 0,
          breakdown: emptyBreakdown(),
        } satisfies Contributor);
      contributors.set(key, contributor);
      contributor.points += weight;
      contributor.breakdown[field] += 1;
    }
  }

  const list = [...contributors.values()].map((c) => ({
    ...c,
    points: Math.round(c.points * 100) / 100,
    hardware_ids: [...c.hardware_ids].sort(),
  }));
  list.sort((a, b) => (b.points === a.points ? (a.login < b.login ? -1 : 1) : b.points - a.points));

  return { contributors: list, runs: scoredRuns };
}
