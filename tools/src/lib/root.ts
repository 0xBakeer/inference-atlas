/**
 * Where the repository is.
 *
 * The CLIs are run through `pnpm --filter @atlas/tools run …`, so the working directory is
 * `tools/`, not the repository root. Deriving the root from this module's own location
 * makes every command work the same whether it was started from the root, from `tools/`,
 * or from a temp directory in a test — and `--root` still overrides it, which is how the
 * tests point the same code at a fixture repository.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<repo>/tools/src/lib/root.ts` → `<repo>`. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
