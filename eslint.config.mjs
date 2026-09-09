// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.claude/**` holds git worktrees - whole checkouts of this repo nested
    // inside it - so without this, linting from the root lints every copy. Each
    // one then fails to parse (`No tsconfigRootDir was set, and multiple
    // candidate TSConfigRootDirs are present`), which on Node < 22 also takes
    // ESLint's own formatter down with it. Nested checkouts are never this
    // project's source.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'prisma/migrations/**', '.claude/**'],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
