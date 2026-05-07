// eslint.config.mjs
import eslintConfig from '@bob-park/eslint-config-bobpark';

import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    extends: [eslintConfig],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
      },
    },
  },
]);
