/** Root ESLint config. `root: true` stops the cascade here, so every package
 *  resolves this same configuration and `pnpm -r lint` behaves identically
 *  across the workspace (see docs/DECISIONS.md D-003). */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true, browser: true },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    '.next/',
    'out/',
    'coverage/',
    'packages/contracts/lib/',
    'packages/contracts/out/',
    'packages/contracts/cache/',
    'packages/db/src/generated/',
    '*.config.mjs',
    '*.cjs',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-console': 'off',
  },
};
