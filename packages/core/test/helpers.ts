import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, from this file's location. Test-only: nothing in the library touches the filesystem. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...parts), 'utf8')) as T;
}
