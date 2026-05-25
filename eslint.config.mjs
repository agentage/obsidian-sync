import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['main.js', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      'prefer-const': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
