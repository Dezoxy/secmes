import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.config.*',
      'infra/**',
      'charts/**',
      '.claude/**',
      '.venv/**',
      'spike/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      // argus hygiene — the hard invariants are enforced by Semgrep; these are guardrails.
      'no-console': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'security/detect-object-injection': 'off',
    },
  },
  prettier,
);
