export default [
  { ignores: ['dist', 'node_modules', 'supabase/functions'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: { window: 'readonly', document: 'readonly', console: 'readonly', fetch: 'readonly', crypto: 'readonly', import: 'readonly' },
    },
    rules: {},
  },
];
