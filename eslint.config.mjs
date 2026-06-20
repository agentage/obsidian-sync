import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import obsidianmd from 'eslint-plugin-obsidianmd';

// The obsidianmd plugin mirrors the community-store's automated scan. We layer
// only its own `obsidianmd/*` rules onto our TS config (not the whole
// `recommended` bundle, which re-registers @typescript-eslint + 100+ import/
// security rules and would conflict). This catches normalizePath/DOM/manifest
// violations in CI before they become a store rejection.
const obsidianmdRules = Object.fromEntries(
  obsidianmd.configs.recommended
    .flatMap((c) => Object.entries(c.rules ?? {}))
    .filter(([name]) => name.startsWith('obsidianmd/'))
);

export default [
  {
    ignores: ['main.js', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
      prettier: prettierPlugin,
      obsidianmd,
    },
    rules: {
      ...prettierConfig.rules,
      ...obsidianmdRules,
      // Its suggestions lowercase proper nouns (Agentage, Markdown, MCP),
      // URLs, and input placeholders — wrong for our copy. Store reviewers apply
      // sentence-case with judgment the rule can't; the rest of the ruleset stays on.
      'obsidianmd/ui/sentence-case': 'off',
      // We intentionally use Vault.trash(file, true): an inbound *sync* delete
      // must always be recoverable (system trash), never honor a user's
      // "permanently delete" manual-delete preference. So keep it over FileManager.
      'obsidianmd/prefer-file-manager-trash-file': 'off',
      'prettier/prettier': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'interface',
          format: ['PascalCase'],
          custom: { regex: '^[A-Z]', match: true },
        },
        {
          selector: 'typeAlias',
          format: ['PascalCase'],
        },
      ],
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'no-var': 'error',
    },
  },
  {
    // The obsidianmd scan targets shipped plugin code, not the unit tests
    // (fakes legitimately use sample-ish names, casts, console assertions).
    files: ['src/**/*.test.ts'],
    rules: Object.fromEntries(Object.keys(obsidianmdRules).map((name) => [name, 'off'])),
  },
];
