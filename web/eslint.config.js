//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  ...tanstackConfig,
  {
    rules: {
      'import/no-cycle': 'off',
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      'pnpm/json-enforce-catalog': 'off',
    },
  },
  {
    // Build output and tool caches are not source. Without these, `eslint` walks
    // .output/ and reports "@typescript-eslint/parser: file was not found in any
    // of the provided project(s)" against bundled JS - a config gap that looks
    // like a code error.
    ignores: [
      'eslint.config.js',
      'prettier.config.js',
      '.output/**',
      '.vercel/**',
      '.tanstack/**',
      '.nitro/**',
      'node_modules/**',
    ],
  },
]
