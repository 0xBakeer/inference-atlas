import { describe, expect, it } from 'vitest';
import { cellId, engineMinor, parseRunId, resultPath, runId } from './ids.js';
import type { CellIdInput } from './ids.js';
import { readJson } from '../test/helpers.js';

interface IdFixture {
  cell_id: Array<{ name: string; input: CellIdInput; expected: string }>;
  run_id: Array<{
    name: string;
    input: { config_id: string; workload_id: string; github_login: string; started_at: string };
    expected: string;
  }>;
  engine_minor: Array<{ input: string; expected: string }>;
  result_path: Array<{
    input: { engine_id: string; model_id: string; hardware_id: string; run_id: string };
    expected: string;
  }>;
}

const fixture = readJson<IdFixture>('schemas/fixtures/id-vectors.json');

describe('cell_id', () => {
  it('has at least four golden vectors', () => {
    expect(fixture.cell_id.length).toBeGreaterThanOrEqual(4);
  });
  for (const v of fixture.cell_id) {
    it(v.name, () => expect(cellId(v.input)).toBe(v.expected));
  }
  it('is distinct per engine minor and per device count', () => {
    const ids = new Set(fixture.cell_id.map((v) => v.expected));
    expect(ids.size).toBe(fixture.cell_id.length);
  });
});

describe('run_id', () => {
  it('has at least four golden vectors', () => {
    expect(fixture.run_id.length).toBeGreaterThanOrEqual(4);
  });
  for (const v of fixture.run_id) {
    it(v.name, () =>
      expect(
        runId(v.input.config_id, v.input.workload_id, v.input.github_login, v.input.started_at),
      ).toBe(v.expected),
    );
  }
  it('separates two contributors running the identical configuration', () => {
    const a = runId(
      '1dd64efc5109c652',
      'serve-single-i256-o256-v1',
      'alice',
      '2026-08-16T10:00:00Z',
    );
    const b = runId('1dd64efc5109c652', 'serve-single-i256-o256-v1', 'bob', '2026-08-16T10:00:00Z');
    expect(a).not.toBe(b);
  });
  it('round-trips through parseRunId', () => {
    for (const v of fixture.run_id) {
      const parsed = parseRunId(v.expected);
      expect(parsed).not.toBeNull();
      expect(parsed?.configId).toBe(v.input.config_id);
      expect(parsed?.workloadId).toBe(v.input.workload_id);
    }
  });
  it('rejects things that are not run ids', () => {
    expect(parseRunId('not-a-run-id')).toBeNull();
    expect(parseRunId('zzzz--serve-v1--aaaaaa')).toBeNull();
    expect(parseRunId('1dd64efc5109c652--serve-v1--XYZ123')).toBeNull();
  });
});

describe('engineMinor', () => {
  for (const v of fixture.engine_minor) {
    it(`${v.input} -> ${v.expected}`, () => expect(engineMinor(v.input)).toBe(v.expected));
  }
});

describe('resultPath', () => {
  for (const v of fixture.result_path) {
    it(v.expected, () =>
      expect(
        resultPath(v.input.engine_id, v.input.model_id, v.input.hardware_id, v.input.run_id),
      ).toBe(v.expected),
    );
  }
});
