/** The TUI shell: header, view routing, keyboard, background refresh. */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { EngineVersion, IndexRow, ResultRecord } from '@atlas/core';
import type { TuiConfig } from '../config.js';
import { recipesDir } from '../config.js';
import type { ColorLevel } from '../canvas/color.js';
import type { AtlasData } from '../data/load.js';
import { loadAtlas } from '../data/load.js';
import type { DataSource } from '../data/source.js';
import { coverageGrid, filterRows, paretoData, rankForHome } from '../derive.js';
import type { FitVerdict } from '../hw/fit.js';
import { fitVerdict } from '../hw/fit.js';
import type { Target } from '../hw/target.js';
import { chooseTarget, targetLabel } from '../hw/target.js';
import type { HardwareRequest } from '../hw/request.js';
import { hardwareIssueUrl, proposeHardware } from '../hw/request.js';
import { copyToClipboard, openUrl } from '../recipe/send.js';
import { saveTarget } from '../config.js';
import { generateRecipe, recipeFileName } from '../recipe/generate.js';
import { agentCommand, runAgentCommand, writeRecipe } from '../recipe/send.js';
import { COLORS } from './theme.js';
import { KeyHints } from './widgets.js';
import { CoverageView } from './views/coverage.js';
import type { HardwareChoice, PickerRow } from './views/hardware.js';
import { HardwareView, isAddRow } from './views/hardware.js';
import { DetailView } from './views/detail.js';
import { HomeView } from './views/home.js';
import { ParetoView } from './views/pareto.js';
import { RecipeView } from './views/recipe.js';
import { RunsView } from './views/runs.js';

type View = 'home' | 'runs' | 'pareto' | 'coverage' | 'hardware' | 'detail' | 'recipe' | 'help';

export interface AppProps {
  source: DataSource;
  config: TuiConfig;
  initialData: AtlasData;
  /** The box every verdict is judged against; switchable at runtime with `b`. */
  initialTarget: Target;
  level: ColorLevel;
}

interface DetailState {
  row: IndexRow;
  record: ResultRecord | null;
  engineVersion: EngineVersion | null;
  loading: boolean;
}

interface RecipeState {
  markdown: string;
  file: string | null;
  scroll: number;
  status: string | null;
}

const clampSel = (v: number, len: number): number => Math.max(0, Math.min(v, Math.max(0, len - 1)));

export function App({
  source,
  config,
  initialData,
  initialTarget,
  level,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [data, setData] = useState(initialData);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [view, setView] = useState<View>(initialTarget.hardware === null ? 'hardware' : 'home');
  const [back, setBack] = useState<View>('home');
  const [selHome, setSelHome] = useState(0);
  const [selRuns, setSelRuns] = useState(0);
  const [selPareto, setSelPareto] = useState(0);
  const [target, setTarget] = useState<Target>(initialTarget);
  const [selHw, setSelHw] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [hwStatus, setHwStatus] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<{
    request: HardwareRequest;
    url: string;
  } | null>(null);
  // No recognised hardware and nothing chosen: ask before showing verdicts nobody can trust.
  const [firstRun, setFirstRun] = useState(initialTarget.hardware === null);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [recipe, setRecipe] = useState<RecipeState | null>(null);
  const [, bump] = useState(0);

  // `|| ` not `?? `: a pty that reports 0 columns is not a 0-column terminal.
  const cols = stdout?.columns || 100;
  const rows = stdout?.rows || 32;
  const bodyHeight = Math.max(6, rows - 12);

  useEffect(() => {
    const onResize = () => bump((n) => n + 1);
    stdout?.on('resize', onResize);
    return () => {
      stdout?.off('resize', onResize);
    };
  }, [stdout]);

  const refresh = useCallback(() => {
    void loadAtlas(source).then((next) => {
      setData(next);
      setCheckedAt(Date.now());
    });
  }, [source]);

  useEffect(() => {
    if (config.data.refreshMinutes <= 0) return;
    const t = setInterval(refresh, config.data.refreshMinutes * 60_000);
    return () => clearInterval(t);
  }, [config.data.refreshMinutes, refresh]);

  const keyMetrics = useMemo(() => {
    const site = data.registry.site as { coverage?: { key_metrics?: string[] } };
    return (
      site.coverage?.key_metrics ?? [
        'output_tok_s',
        'decode_tok_s_per_request',
        'accuracy',
        'ttft_p50',
      ]
    );
  }, [data]);

  const fitFor = useCallback(
    (row: IndexRow, record?: ResultRecord | null): FitVerdict =>
      fitVerdict({
        row,
        record: record ?? null,
        engine: data.engineById(row.engine.id),
        model: data.modelById.get(row.model.id) ?? null,
        quant: data.quantById(row.model.id, row.model.quant_id),
        target,
      }),
    [data, target],
  );

  const ranked = useMemo(() => {
    const withFits = data.index.map((row) => {
      const fit = fitFor(row);
      return { row, fitLevel: fit.level, fitLabel: fit.label };
    });
    return rankForHome(withFits, keyMetrics);
  }, [data, fitFor, keyMetrics]);

  const filtered = useMemo(() => filterRows(data.index, filter), [data, filter]);
  const pareto = useMemo(() => paretoData(data.index), [data]);
  const coverage = useMemo(() => coverageGrid(data), [data]);

  const openDetail = useCallback(
    (row: IndexRow) => {
      setBack(view === 'detail' || view === 'recipe' ? 'home' : (view as View));
      setDetail({ row, record: null, engineVersion: null, loading: true });
      setView('detail');
      void (async () => {
        const record = await source.run<ResultRecord>(row.path);
        const engineVersion = await source.engineVersion<EngineVersion>(
          row.engine.id,
          row.engine.version,
        );
        setDetail((d) =>
          d && d.row.run_id === row.run_id ? { ...d, record, engineVersion, loading: false } : d,
        );
      })();
    },
    [source, view],
  );

  const openRecipe = useCallback(
    (d: DetailState) => {
      const engine = data.engineById(d.row.engine.id);
      if (!engine || !d.record) return;
      const fit = fitFor(d.row, d.record);
      const markdown = generateRecipe({
        row: d.row,
        record: d.record,
        engine,
        model: data.modelById.get(d.row.model.id) ?? null,
        quant: data.quantById(d.row.model.id, d.row.model.quant_id),
        measuredOn: data.hardwareById.get(d.row.hardware.id) ?? null,
        workload: data.workloadById.get(d.row.workload_id) ?? null,
        engineVersion: d.engineVersion,
        fit,
        target,
        site: data.registry.site,
      });
      let file: string | null = null;
      let status: string | null = null;
      try {
        file = writeRecipe(recipesDir(config), recipeFileName(d.row), markdown);
      } catch (err) {
        status = `could not write recipe: ${err instanceof Error ? err.message : String(err)}`;
      }
      setRecipe({ markdown, file, scroll: 0, status });
      setView('recipe');
    },
    [data, fitFor, target, config],
  );

  /** Every registry entry, the detected one first, each carrying its own pending count. */
  const hwChoices = useMemo((): HardwareChoice[] => {
    const detectedId = initialTarget.source === 'detected' ? initialTarget.hardware?.id : null;
    const rows = data.registry.hardware.map((hardware) => ({
      hardware,
      count: counts[hardware.id] ?? (hardware.id === target.hardware?.id ? target.count : 1),
      detected: hardware.id === detectedId,
    }));
    return rows.sort((a, b) => {
      if (a.detected !== b.detected) return a.detected ? -1 : 1;
      return a.hardware.id.localeCompare(b.hardware.id);
    });
  }, [data, counts, target, initialTarget]);

  /**
   * The picker's rows. The escape hatch sits last normally, but first when nothing was
   * recognised — that is precisely the case where the answer is "none of these".
   */
  const pickerRows = useMemo(
    (): PickerRow[] =>
      initialTarget.source === 'unknown'
        ? [{ kind: 'add' }, ...hwChoices]
        : [...hwChoices, { kind: 'add' }],
    [hwChoices, initialTarget],
  );

  /** Build the registry request from what was probed, and ask before opening anything. */
  const askToAddBox = useCallback(() => {
    const captured = initialTarget.captured;
    if (!captured) {
      setHwStatus('nothing was probed on this machine, so there is nothing to propose');
      return;
    }
    const request = proposeHardware(captured);
    setPendingRequest({ request, url: hardwareIssueUrl(request, data.registry.site) });
  }, [initialTarget, data]);

  const selectHardware = useCallback(
    (choice: HardwareChoice) => {
      const next = chooseTarget(choice.hardware, choice.count, initialTarget.captured);
      setTarget(next);
      setFirstRun(false);
      setSelHome(0);
      const saved = saveTarget(choice.hardware.id, choice.count);
      setHwStatus(
        saved.ok
          ? `${targetLabel(next)} — saved to ${saved.file}`
          : `selected, but could not write the config: ${saved.error}`,
      );
    },
    [initialTarget],
  );

  const bumpCount = useCallback((choice: HardwareChoice, delta: number) => {
    setCounts((c) => ({
      ...c,
      [choice.hardware.id]: Math.max(1, Math.min(64, choice.count + delta)),
    }));
  }, []);

  useInput((input, key) => {
    // The confirmation dialog owns the keyboard while it is up: opening a browser is an
    // outward-facing act and must not happen on a stray keypress.
    if (pendingRequest) {
      if (key.escape || input === 'n' || input === 'q') setPendingRequest(null);
      else if (key.return || input === 'y') {
        const opened = openUrl(pendingRequest.url);
        setHwStatus(
          opened.ok
            ? 'opened the registry request in your browser — nothing is sent until you submit it there'
            : `could not open a browser (${opened.error ?? 'unknown'}) — press c to copy the link`,
        );
        if (opened.ok) setPendingRequest(null);
      } else if (input === 'c') {
        const ok = copyToClipboard(pendingRequest.url);
        setHwStatus(
          ok ? 'link copied to the clipboard' : 'link sent via OSC52 (terminal permitting)',
        );
        setPendingRequest(null);
      }
      return;
    }

    // Filter entry swallows everything printable.
    if (filtering) {
      if (key.return || key.escape) setFiltering(false);
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
      setSelRuns(0);
      return;
    }

    if (input === 'q' && view !== 'recipe') {
      exit();
      return;
    }
    if (key.escape) {
      if (view === 'recipe') setView('detail');
      else if (view === 'detail' || view === 'help') setView(back);
      else if (view === 'hardware' && !firstRun) setView('home');
      return;
    }
    if (input === '?') {
      if (view !== 'help') setBack(view === 'detail' || view === 'recipe' ? 'home' : view);
      setView(view === 'help' ? back : 'help');
      return;
    }
    if (input === 'r') {
      refresh();
      return;
    }

    const down = input === 'j' || key.downArrow;
    const up = input === 'k' || key.upArrow;

    if (view === 'recipe' && recipe) {
      if (down) setRecipe({ ...recipe, scroll: recipe.scroll + 1 });
      else if (up) setRecipe({ ...recipe, scroll: Math.max(0, recipe.scroll - 1) });
      else if (input === 'c') {
        const ok = copyToClipboard(recipe.markdown);
        setRecipe({
          ...recipe,
          status: ok ? 'copied to clipboard' : 'sent via OSC52 (terminal permitting)',
        });
      } else if (/^[1-9]$/.test(input)) {
        const names = Object.keys(config.agents);
        const name = names[Number(input) - 1];
        const agent = name ? config.agents[name] : undefined;
        if (name && agent && recipe.file) {
          const command = agentCommand(agent, recipe.file);
          if (agent.mode === 'run') {
            setRecipe({ ...recipe, status: `running ${name}…` });
            runAgentCommand(command, (result) =>
              setRecipe((r) =>
                r
                  ? {
                      ...r,
                      status: `${name}: ${result.ok ? 'done' : 'FAILED'} — ${result.output.slice(-200).trim() || 'no output'}`,
                    }
                  : r,
              ),
            );
          } else {
            const ok = copyToClipboard(command);
            setRecipe({
              ...recipe,
              status: `${name} command ${ok ? 'copied — paste it in a shell' : 'sent via OSC52'}`,
            });
          }
        }
      }
      return;
    }

    if (input === 'b') {
      setSelHw(
        Math.max(
          0,
          hwChoices.findIndex((c) => c.hardware.id === target.hardware?.id),
        ),
      );
      setHwStatus(null);
      setView('hardware');
      return;
    }
    if (input === '1') setView('home');
    else if (input === '2') setView('runs');
    else if (input === '3') setView('pareto');
    else if (input === '4') setView('coverage');
    else if (input === '5') setView('hardware');
    else if (key.tab) {
      const order: View[] = ['home', 'runs', 'pareto', 'coverage', 'hardware'];
      const current = order.indexOf(view);
      setView(order[(current + 1) % order.length]!);
    } else if (input === '/') {
      setView('runs');
      setFiltering(true);
    } else if (view === 'hardware') {
      const row = pickerRows[selHw];
      const choice = row && !isAddRow(row) ? row : null;
      if (down) setSelHw((s) => clampSel(s + 1, pickerRows.length));
      else if (up) setSelHw((s) => clampSel(s - 1, pickerRows.length));
      else if (choice && (input === '+' || input === '=' || key.rightArrow)) bumpCount(choice, 1);
      else if (choice && (input === '-' || input === '_' || key.leftArrow)) bumpCount(choice, -1);
      else if (key.return && choice) selectHardware(choice);
      else if (key.return && row && isAddRow(row)) askToAddBox();
    } else if (view === 'home') {
      if (down) setSelHome((s) => clampSel(s + 1, ranked.length));
      else if (up) setSelHome((s) => clampSel(s - 1, ranked.length));
      else if (key.return && ranked[selHome]) openDetail(ranked[selHome]!.row);
      else if (input === 'g' && ranked[selHome]) openDetail(ranked[selHome]!.row);
    } else if (view === 'runs') {
      if (down) setSelRuns((s) => clampSel(s + 1, filtered.length));
      else if (up) setSelRuns((s) => clampSel(s - 1, filtered.length));
      else if (key.return && filtered[selRuns]) openDetail(filtered[selRuns]!);
      else if (input === 'g' && filtered[selRuns]) openDetail(filtered[selRuns]!);
    } else if (view === 'pareto') {
      if (down || key.rightArrow) setSelPareto((s) => clampSel(s + 1, pareto.points.length));
      else if (up || key.leftArrow) setSelPareto((s) => clampSel(s - 1, pareto.points.length));
      else if (key.return && pareto.points[selPareto]) openDetail(pareto.points[selPareto]!.row);
    } else if (view === 'detail' && detail) {
      if (input === 'g' && detail.record) openRecipe(detail);
    }
  });

  const commit = data.manifest?.commit_short ?? '?';
  const ageMin = Math.round((Date.now() - checkedAt) / 60000);
  const syncLabel =
    data.sync.status === 'offline'
      ? 'offline (cache)'
      : `${data.sync.status} · checked ${ageMin}m ago`;

  const hints: Array<[string, string]> =
    view === 'recipe'
      ? [
          ['j/k', 'scroll'],
          ['c', 'copy md'],
          ['1-9', 'send to agent'],
          ['esc', 'back'],
        ]
      : view === 'detail'
        ? [
            ['g', 'recipe'],
            ['esc', 'back'],
            ['?', 'help'],
          ]
        : view === 'hardware'
          ? pendingRequest
            ? [
                ['enter/y', 'open the request'],
                ['c', 'copy the link'],
                ['esc/n', 'cancel'],
              ]
            : [
                ['j/k', 'move'],
                ['+/-', 'how many'],
                ['enter', 'use it'],
                ...(firstRun ? [] : ([['esc', 'back']] as Array<[string, string]>)),
              ]
          : [
              ['1-5', 'views'],
              ['j/k', 'move'],
              ['enter', 'open'],
              ['/', 'filter'],
              ['b', 'box'],
              ['g', 'recipe'],
              ['q', 'quit'],
            ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={COLORS.accent}>
          INFERENCE ATLAS{' '}
          <Text color={COLORS.muted}>[{view === 'home' ? 'target' : view}] · box </Text>
          <Text color={COLORS.ok}>{targetLabel(target)}</Text>
          <Text color={COLORS.muted}>
            {' '}
            · data @ {commit} · {syncLabel}
          </Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column" minHeight={bodyHeight}>
        {view === 'home' ? (
          <HomeView
            data={data}
            target={target}
            ranked={ranked}
            keyMetrics={keyMetrics}
            selected={selHome}
            height={bodyHeight - 8}
            width={cols - 6}
          />
        ) : view === 'runs' ? (
          <RunsView
            rows={filtered}
            keyMetrics={keyMetrics}
            filter={filter}
            filtering={filtering}
            selected={selRuns}
            height={bodyHeight - 3}
            width={cols - 6}
          />
        ) : view === 'pareto' ? (
          <ParetoView
            points={pareto.points}
            frontier={pareto.frontier}
            selected={selPareto}
            width={Math.min(cols - 8, 90)}
            height={Math.max(6, bodyHeight - 8)}
            level={level}
          />
        ) : view === 'coverage' ? (
          <CoverageView grid={coverage} level={level} />
        ) : view === 'hardware' ? (
          <HardwareView
            rows={pickerRows}
            selected={selHw}
            target={target}
            firstRun={firstRun}
            status={hwStatus}
            height={bodyHeight - 9}
            width={cols - 6}
            pending={pendingRequest}
          />
        ) : view === 'detail' && detail ? (
          <DetailView
            row={detail.row}
            record={detail.record}
            loading={detail.loading}
            fit={fitFor(detail.row, detail.record)}
            targetLabel={targetLabel(target)}
            width={cols - 6}
            level={level}
          />
        ) : view === 'recipe' && recipe ? (
          <RecipeView
            markdown={recipe.markdown}
            file={recipe.file}
            scroll={recipe.scroll}
            height={Math.max(8, bodyHeight - 8)}
            agents={config.agents}
            status={recipe.status}
          />
        ) : (
          <HelpView />
        )}
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={hints} />
      </Box>
    </Box>
  );
}

function HelpView(): React.JSX.Element {
  const rows: Array<[string, string]> = [
    ['1 / 2 / 3 / 4 / 5', 'target · all runs · pareto · coverage · hardware'],
    ['b', 'pick the target hardware — saved to your config'],
    ['+ / - (in b)', 'how many of that device you have'],
    ['enter on “not listed?”', 'open a pre-filled registry request for your box'],
    ['tab', 'cycle views'],
    ['j / k, arrows', 'move selection / scroll'],
    ['enter', 'open the selected run'],
    ['/', 'filter runs (esc to stop typing)'],
    ['g', 'generate the install recipe for the selected run'],
    ['c (in recipe)', 'copy the markdown'],
    ['1-9 (in recipe)', 'send to a configured agent'],
    ['r', 'refresh data now'],
    ['esc', 'back'],
    ['q', 'quit'],
  ];
  return (
    <Box flexDirection="column">
      {rows.map(([k, v]) => (
        <Text key={k}>
          <Text color={COLORS.counter} bold>
            {k.padEnd(16)}
          </Text>
          <Text>{v}</Text>
        </Text>
      ))}
    </Box>
  );
}
