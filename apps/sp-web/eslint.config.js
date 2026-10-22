// @ts-check
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = tseslint.config(
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        // sceneCard* are slot markers for <app-scene-card-shell>.
        { type: 'attribute', prefix: ['app', 'sceneCard'], style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
    },
  },
  {
    // Tests reach protected members through `as any`.
    files: ['**/*.spec.ts', 'src/test-setup.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/label-has-associated-control': [
        'error',
        {
          // These PrimeNG components render a native <input>, so a wrapping
          // <label> names them. p-select / p-multiselect do not (they focus a
          // <span>), so they need ariaLabelledBy or ariaLabel instead.
          controlComponents: ['p-toggleswitch', 'p-checkbox', 'p-inputnumber', 'p-autocomplete'],
        },
      ],
    },
  },
);
