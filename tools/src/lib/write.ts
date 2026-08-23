/**
 * Deterministic JSON output.
 *
 * `app/public/data/` is rebuilt on every push, and a build whose output depends on
 * directory order or `Object.keys` insertion order produces a diff every time even when
 * nothing changed. Every object written by the build therefore goes through `sortKeys`,
 * and every array is sorted by its caller before it gets here.
 *
 * `index.json` is written without whitespace: it is the biggest file the app fetches on
 * first paint and GitHub Pages does not let us control compression.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256Hex } from '@atlas/core';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Recursively sort object keys; arrays keep the order the caller chose. */
export function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out as unknown as T;
  }
  return value;
}

export interface WrittenFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface WriteOptions {
  /** `false` writes without whitespace — used for index.json. */
  pretty?: boolean;
  /** Skip the recursive key sort for payloads that are already canonical (copied runs). */
  sorted?: boolean;
}

export function serialize(data: unknown, options: WriteOptions = {}): string {
  const value = options.sorted === true ? data : sortKeys(data);
  return options.pretty === false ? JSON.stringify(value) : `${JSON.stringify(value, null, 2)}\n`;
}

export function writeJsonFile(
  absolutePath: string,
  data: unknown,
  options: WriteOptions = {},
): WrittenFile {
  const text = serialize(data, options);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, text, 'utf8');
  return {
    path: absolutePath,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256Hex(text),
  };
}
