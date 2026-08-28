import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.opencode/**',
      'coverage/**',
      'test-results/**',
      '*.zip',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      // The vanilla-JS prototype used untyped globals; the strict port keeps
      // a few targeted non-null assertions where the runtime already guarantees presence.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Hard contract: the typed surface may cast via `unknown` but never `any`.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['vite.config.ts', 'vitest.config.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  prettier,
);
