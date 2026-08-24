import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      'dist-electron/**',
      '**/dist-electron/**',
      '.git/**',
      '.perf-out/**',
      'build/**',
      '.claude/**',
      'release/**',
    ],
  },
  {
    files: ['packages/desktop/src/**/*.{ts,tsx}', 'packages/desktop/electron/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      sourceType: 'module',
      ecmaVersion: 2022,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
];
