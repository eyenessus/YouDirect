/* eslint-env node */
module.exports = {
  root: true,
  env: { node: true, browser: true, es2023: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    '.cache/',
    '.storage/',
    'coverage/',
    'docs/openapi.json',
    '*.d.ts',
  ],
  rules: {
    // Valores monetários e datas de negócio trafegam como inteiros/strings;
    // comparações frouxas escondem erro de tipo nesse domínio.
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-console': 'off',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
    ],
    // O código usa `as` em pontos de fronteira (driver do Mongo, pdfmake,
    // SDKs carregados sob demanda); `any` explícito é sinalizado, não proibido.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
  overrides: [
    {
      files: ['*.vue'],
      parser: 'vue-eslint-parser',
      parserOptions: { parser: '@typescript-eslint/parser', ecmaVersion: 2023, sourceType: 'module' },
      extends: ['plugin:vue/vue3-recommended'],
      rules: {
        // Os nomes de componente seguem o padrão `AppButton`, `MetricCard`…
        'vue/multi-word-component-names': 'off',
        // Props opcionais já são declaradas como opcionais via
        // `defineProps<T>()`; exigir um default alteraria a semântica
        // (undefined x valor padrão) nos componentes que tratam ambos.
        'vue/require-default-prop': 'off',
        'vue/max-attributes-per-line': 'off',
        'vue/singleline-html-element-content-newline': 'off',
        'vue/html-self-closing': 'off',
        'vue/attributes-order': 'off',
        'vue/html-indent': 'off',
        'vue/html-closing-bracket-newline': 'off',
      },
    },
    {
      files: ['**/*.test.ts', 'e2e/**/*.ts', 'e2e/**/*.mjs'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
