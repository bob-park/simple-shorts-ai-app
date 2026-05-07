// eslint.config.mjs
import eslintConfig from '@bob-park/eslint-config-bobpark';

import { defineConfig } from 'eslint/config';

export default defineConfig([
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'coverage/**'] },
  {
    extends: [eslintConfig],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
      },
    },
  },
]);
