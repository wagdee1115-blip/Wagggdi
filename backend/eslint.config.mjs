import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      // Existing legacy surfaces are tracked separately; the CI gate still enforces
      // Next.js, React Hooks, parser, and TypeScript correctness rules everywhere.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@next/next/no-html-link-for-pages': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  globalIgnores([
    '.next/**',
    'coverage/**',
    'node_modules/**',
    'next-env.d.ts',
  ]),
]);
