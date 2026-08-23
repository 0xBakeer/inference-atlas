import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Node globals used by the repository scripts. Kept inline so tooling stays at two dependencies. */
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  __dirname: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'app/public/data/**', 'bench/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js', '**/scripts/**'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ['**/*.test.ts', 'packages/*/test/**'],
    languageOptions: { globals: nodeGlobals },
  },
);
