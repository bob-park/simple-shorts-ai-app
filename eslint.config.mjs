// eslint.config.mjs
import eslintConfig from '@bob-park/eslint-config-bobpark';

import { FlatCompat } from '@eslint/eslintrc';
import { defineConfig } from 'eslint/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
    baseDirectory: __dirname,
});

export default defineConfig([
    {
        extends: [eslintConfig],
    },
]);
