# M1: Project Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap an Electron + React + TypeScript app with the MiniMax design tokens applied to a sidebar layout that lets the user navigate between four placeholder pages (NewJob, Progress, History, Settings). `yarn dev` opens the app and clicking any sidebar item changes the main pane.

**Architecture:** electron-vite for separate main/preload/renderer bundling with HMR. Strict secure defaults (contextIsolation: true, nodeIntegration: false, sandbox-friendly preload). React 18 + react-router-dom 6 for the renderer. CSS custom properties for the MiniMax design token system. All MiniMax tokens declared once in `tokens.css` so later milestones consume them by name.

**Tech Stack:** Electron 33+, electron-vite 2+, React 18, TypeScript 5, react-router-dom 6, **Tailwind CSS 4 with `@tailwindcss/vite`** (CSS-first `@theme` config mirrors MiniMax tokens), Vitest 2+, @testing-library/react 16+, ESLint 9 with `@bob-park/eslint-config-bobpark` (FlatCompat) + Prettier 3 with `@bob-park/prettier-config-bobpark` (configured via `package.json` `"prettier"` field), @fontsource/dm-sans for offline DM Sans.

**Toolchain (already pinned in `.mise.toml`):** Node 24, Yarn 4.14.1. The plan uses Yarn throughout. Yarn 4's default Plug'n'Play resolver is incompatible with Electron's native module loading, so Task 1 sets `nodeLinker: node-modules` in `.yarnrc.yml`.

---

## File Structure

```
.
├── package.json
├── tsconfig.json                  # solution file (references node + web)
├── tsconfig.node.json             # main + preload (Node + Electron types)
├── tsconfig.web.json              # renderer (DOM + React)
├── electron.vite.config.ts        # main / preload / renderer bundles + @tailwindcss/vite
├── vitest.config.ts
├── eslint.config.mjs              # flat config (extends @bob-park/eslint-config-bobpark) — AUTHORED BY USER
├── .yarnrc.yml                    # nodeLinker: node-modules + bob-park GH Packages registry — AUTHORED BY USER
├── .mise.toml                     # node 24 + yarn 4.14.1 — AUTHORED BY USER
├── .editorconfig
├── .gitignore
├── README.md
# Note: Prettier config lives in package.json "prettier" field, not a standalone file.
├── src/
│   ├── main/
│   │   ├── main.ts                # Electron app + BrowserWindow + CSP
│   │   └── preload.ts             # contextBridge stub (typed)
│   ├── shared/
│   │   └── ipc.ts                 # IPC channel constants + Bridge type (M1: empty stub)
│   └── renderer/
│       ├── index.html
│       ├── main.tsx               # React mount
│       ├── App.tsx                # router + sidebar layout
│       ├── router.tsx             # route table
│       ├── pages/
│       │   ├── NewJob.tsx         # placeholder
│       │   ├── Progress.tsx       # placeholder
│       │   ├── History.tsx        # placeholder
│       │   └── Settings.tsx       # placeholder
│       ├── components/
│       │   ├── Sidebar.tsx        # 4 nav items, active state (Tailwind utilities)
│       │   └── AppShell.tsx       # sidebar + outlet layout (Tailwind utilities)
│       └── styles/
│           └── global.css         # @import "tailwindcss"; @theme { MiniMax tokens }; @layer base { body }
└── tests/
    └── renderer/
        └── App.test.tsx           # smoke: renders + nav works
```

**Decomposition rationale:**

- `src/main/`, `src/renderer/`, `src/shared/` are the three Electron processes' code regions; the type-shared layer (`shared/`) prevents duplication of IPC contracts in later milestones.
- `components/` vs `pages/`: pages are mounted by the router; components are reused across pages. `AppShell` is a layout component that owns the sidebar + outlet split.
- Styles split by concern (reset / tokens / typography / global) so later milestones can change one without touching the others.

---

## Tasks

### Task 1: Toolchain + repo + package.json scaffold

**Files:**

- Modify: `.gitignore` (already exists — extend with project-specific entries)
- Create: `.editorconfig`
- Create: `package.json`
- Create: `README.md`

**Pre-existing state to respect (do not delete or recreate):**

- `.git/` — initialized on `master` (no commits yet, `.gitignore` and `.mise.toml` already staged)
- `.mise.toml` — pins Node 24 + Yarn 4.14.1
- `.gitignore` — Next.js-template baseline (we'll extend it, not replace)
- `.yarnrc.yml` — already configured by the user with `nodeLinker: node-modules`, `enableScripts: true`, and a GitHub Packages registry entry for the `@bob-park` scope
- `eslint.config.mjs` — already authored by the user, extends `@bob-park/eslint-config-bobpark` via `FlatCompat`

**Environment requirement:** `@bob-park/*` packages live on GitHub Packages. Before running any `yarn add` for those, export a token:

```bash
export GITHUB_NPM_AUTH_TOKEN="<your GitHub PAT with read:packages>"
```

(or persist it in your shell rc / `.envrc`). Without this, `yarn add @bob-park/...` will fail with a 401 from npm.pkg.github.com.

- [ ] **Step 1: Verify the toolchain is active**

Run from project root:

```bash
mise install
node --version
yarn --version
```

Expected: `node` prints `v24.x.x`, `yarn` prints `4.14.1`. If `yarn` is missing, run `corepack enable` then re-run.

- [ ] **Step 2: Extend `.gitignore` with project-specific entries**

The existing `.gitignore` has Next.js-flavored entries. Append our additions at the end:

```
### simple-shorts-ai-app ###
# electron-vite build output
/out
/dist
/release

# yarn berry internals (we use nodeLinker: node-modules, so this stays minimal)
.yarn/cache
.yarn/install-state.gz
.pnp.*

# logs
/logs
*.log

# local workspaces (sample/working media — keep out of repo)
/.scratch
/workspace
```

Open `.gitignore` and append the block above (do not delete existing lines).

- [ ] **Step 3: Verify `.yarnrc.yml` is correct (do not recreate)**

Read `.yarnrc.yml` and confirm it contains at minimum:

- `nodeLinker: node-modules`
- `enableScripts: true` (Electron's native module postinstall scripts need this)
- An `npmScopes.bob-park` entry pointing at `https://npm.pkg.github.com`

If any of these are missing, edit the file in place rather than overwriting it. If all three are present, skip without changes.

- [ ] **Step 4: Create `.editorconfig`**

Create `.editorconfig`:

```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 5: Create `package.json`**

Create `package.json`:

```json
{
  "name": "simple-shorts-ai-app",
  "version": "0.0.1",
  "private": true,
  "description": "YouTube to 9:16 shorts via local STT and LLM highlight extraction.",
  "main": "out/main/main.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc -b --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "packageManager": "yarn@4.14.1"
}
```

- [ ] **Step 6: Create minimal `README.md`**

Create `README.md`:

````markdown
# Simple Shorts AI App

YouTube → local Whisper STT → LLM highlight extraction → 9:16 shorts with burned-in captions.
Cross-platform desktop app (macOS + Windows).

See `docs/superpowers/specs/2026-05-07-shorts-ai-design.md` for the design.
See `docs/superpowers/plans/` for milestone implementation plans.

## Toolchain

This repo uses [mise](https://mise.jdx.dev/) to pin Node 24 + Yarn 4. Run `mise install` once after cloning.

## Development

```bash
yarn install
yarn dev          # launches the Electron app with HMR
yarn typecheck
yarn test
yarn lint
```
````

## Status

M1: Project Skeleton (in progress)

````

- [ ] **Step 7: Stage and commit**

```bash
git add .gitignore .yarnrc.yml .editorconfig package.json README.md .mise.toml eslint.config.mjs
git commit -m "chore(m1): initialize repo with package.json, yarn berry config, and tooling"
````

> The `.yarnrc.yml` and `eslint.config.mjs` files were authored by the user before this task started; they are part of the same logical bootstrap commit.

---

### Task 2: Install dependencies

**Files:**

- Modify: `package.json` (yarn adds entries)
- Create: `yarn.lock`

- [ ] **Step 1: Install runtime dependencies**

```bash
yarn add \
  react@^18.3.1 \
  react-dom@^18.3.1 \
  react-router-dom@^6.26.2 \
  @fontsource/dm-sans@^5.1.0
```

- [ ] **Step 2: Install dev dependencies (Electron + build + Tailwind)**

```bash
yarn add --dev \
  electron@^33.0.0 \
  electron-vite@^2.3.0 \
  vite@^5.4.0 \
  @vitejs/plugin-react@^4.3.0 \
  typescript@^5.5.0 \
  @types/node@^22.0.0 \
  @types/react@^18.3.0 \
  @types/react-dom@^18.3.0 \
  tailwindcss@^4.0.0 \
  @tailwindcss/vite@^4.0.0
```

> **Why Tailwind v4 + `@tailwindcss/vite`:** v4 uses CSS-first config with `@theme`, which maps directly onto our MiniMax design tokens (no JS `tailwind.config.ts` needed). The Vite plugin removes the PostCSS step entirely.

- [ ] **Step 3: Install dev dependencies (test)**

```bash
yarn add --dev \
  vitest@^2.1.0 \
  @testing-library/react@^16.0.0 \
  @testing-library/jest-dom@^6.5.0 \
  @testing-library/user-event@^14.5.0 \
  jsdom@^25.0.0
```

- [ ] **Step 4: Install ESLint + Prettier with the bob-park shared configs**

These pull from GitHub Packages — make sure `GITHUB_NPM_AUTH_TOKEN` is exported (see Task 1 environment requirement).

```bash
yarn add --dev \
  eslint@^9.10.0 \
  @eslint/eslintrc@^3.1.0 \
  @bob-park/eslint-config-bobpark@0.2.4-RC1-20251111 \
  prettier@^3.3.0 \
  @bob-park/prettier-config-bobpark@0.3.1-RC1-20250912
```

> **Why these versions exactly:** the `0.2.4-RC1-20251111` and `0.3.1-RC1-20250912` releases are the ones the user has standardized on across their projects. Do not bump them without asking.
>
> **Peer plugins:** the `@bob-park/eslint-config-bobpark` package brings its own React / TypeScript ESLint plugin dependencies. Do not install `typescript-eslint`, `eslint-plugin-react`, or `eslint-plugin-react-hooks` separately — that risks version drift with the shared config.

- [ ] **Step 5: Verify install**

Run:

```bash
ls -d \
  node_modules/electron \
  node_modules/react \
  node_modules/electron-vite \
  node_modules/vitest \
  node_modules/tailwindcss \
  node_modules/@tailwindcss/vite \
  node_modules/@bob-park/eslint-config-bobpark \
  node_modules/@bob-park/prettier-config-bobpark
```

Expected: every directory exists. If any are missing, re-run the matching `yarn add` command. If the two `@bob-park/*` paths are missing with a 401 error in the install log, re-export `GITHUB_NPM_AUTH_TOKEN` and retry.

- [ ] **Step 6: Commit lockfile**

```bash
git add package.json yarn.lock
git commit -m "chore(m1): install runtime and dev dependencies via yarn"
```

---

### Task 3: TypeScript configs

**Files:**

- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`

The renderer (DOM + React) and main/preload (Node) need different lib/types. A solution-style root tsconfig references both.

- [ ] **Step 1: Create root `tsconfig.json` (references)**

Create `tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

- [ ] **Step 2: Create `tsconfig.node.json` (main + preload + shared)**

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node", "electron"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "outDir": "./out/types/node",
    "tsBuildInfoFile": "./out/types/node.tsbuildinfo"
  },
  "include": ["src/main/**/*.ts", "src/shared/**/*.ts", "electron.vite.config.ts"]
}
```

- [ ] **Step 3: Create `tsconfig.web.json` (renderer)**

Create `tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "outDir": "./out/types/web",
    "tsBuildInfoFile": "./out/types/web.tsbuildinfo"
  },
  "include": ["src/renderer/**/*.ts", "src/renderer/**/*.tsx", "src/shared/**/*.ts", "tests/**/*.ts", "tests/**/*.tsx"]
}
```

- [ ] **Step 4: Verify (will fail because no source files yet)**

Run:

```bash
yarn tsc -b --noEmit
```

Expected: errors like `error TS6053: File 'src/main/main.ts' not found` — this is OK for now, source files come in Task 5 and later. We're only verifying the configs parse.

- [ ] **Step 5: Commit**

```bash
git add tsconfig*.json
git commit -m "chore(m1): add TypeScript project references for main/web"
```

---

### Task 4: electron-vite config + tsconfig path aliases

**Files:**

- Create: `electron.vite.config.ts`
- Modify: `tsconfig.node.json` (add `paths` for `@shared/*`)
- Modify: `tsconfig.web.json` (add `paths` for `@shared/*` and `@renderer/*`)

- [ ] **Step 1: Create `electron.vite.config.ts`**

Create `electron.vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/main.ts') },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/main/preload.ts') },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  },
});
```

> The `@tailwindcss/vite` plugin auto-scans renderer source files for class names; no PostCSS or `tailwind.config.ts` needed.

- [ ] **Step 2: Add `paths` to `tsconfig.node.json`**

The Vite alias `@shared` is invisible to `tsc`. Without a tsconfig `paths` entry, `yarn typecheck` will fail with TS2307 the moment a file does `import { x } from '@shared/...'`. Mirror the Vite aliases here.

Edit `tsconfig.node.json` — inside `compilerOptions`, AFTER `tsBuildInfoFile`, add:

```json
"paths": {
  "@shared/*": ["./src/shared/*"]
}
```

Resulting `compilerOptions` block ends with `..., "tsBuildInfoFile": "./out/types/node.tsbuildinfo", "paths": { "@shared/*": ["./src/shared/*"] } }`.

- [ ] **Step 3: Add `paths` to `tsconfig.web.json`**

Edit `tsconfig.web.json` — inside `compilerOptions`, AFTER `tsBuildInfoFile`, add:

```json
"paths": {
  "@shared/*": ["./src/shared/*"],
  "@renderer/*": ["./src/renderer/*"]
}
```

- [ ] **Step 4: Verify configs still parse**

```bash
yarn tsc -b --noEmit
```

Expected: still TS18003 ("no inputs") errors per config (because `src/` is empty), but no TS5102 / JSON parse errors. Adding `paths` is a `compilerOptions` addition, not a structural change.

- [ ] **Step 5: Commit**

```bash
git add electron.vite.config.ts tsconfig.node.json tsconfig.web.json
git commit -m "chore(m1): add electron-vite config and mirror aliases as tsconfig paths"
```

---

### Task 5: Verify ESLint + Prettier wiring

**Files:**

- Verify (do not modify): `eslint.config.mjs` (already authored by user)
- Verify (do not modify): `package.json` (already has `"prettier": "@bob-park/prettier-config-bobpark"` field added by user)

> No `prettier.config.js` is created — Prettier reads its config from the `"prettier"` field in `package.json`. Both ESLint and Prettier shared configs are already wired; this task just verifies they resolve correctly after Task 2's installs.

- [ ] **Step 1: Verify the existing `eslint.config.mjs`**

Read `eslint.config.mjs` and confirm:

- It imports `@bob-park/eslint-config-bobpark`
- It uses `FlatCompat` from `@eslint/eslintrc`
- It exports a `defineConfig([...])` array

If anything is missing, leave the user's authored file structure alone and only add what's needed. Do **not** rewrite the file from scratch — the user maintains a uniform shape across their projects.

- [ ] **Step 2: Verify the `package.json` Prettier field**

Read `package.json` and confirm it contains:

```json
"prettier": "@bob-park/prettier-config-bobpark"
```

If missing, add the field (after `packageManager`). Do not change other keys.

- [ ] **Step 3: Verify ESLint runs (no source files yet, so no errors)**

```bash
yarn lint
```

Expected: exit code 0. If you see "Cannot find module '@bob-park/eslint-config-bobpark'", re-run Task 2 Step 4. If you see "FlatCompat is not a function", confirm `@eslint/eslintrc` is in dev dependencies.

- [ ] **Step 4: Verify Prettier resolves the shared config**

```bash
yarn prettier --check package.json
```

Expected: exits 0 (file already matches) — proves Prettier successfully loaded the bob-park shared config from the package.json field. If it fails with "Cannot find module '@bob-park/prettier-config-bobpark'", re-run Task 2 Step 4.

- [ ] **Step 5: Commit (only if `package.json` was modified above)**

If you added the `"prettier"` field in Step 2:

```bash
git add package.json
git commit -m "chore(m1): wire prettier to @bob-park shared config via package.json"
```

If `package.json` already had the field, skip the commit — there is nothing to commit for this task. Move to Task 6.

---

### Task 6: Tailwind v4 + MiniMax design tokens

**Files:**

- Create: `src/renderer/styles/global.css`

In Tailwind v4, the entire design system lives in CSS via `@theme`. We define MiniMax tokens as Tailwind theme variables — Tailwind generates utilities like `bg-brand-coral`, `text-ink`, `p-md`, `rounded-hero` from these. Components consume them as utility classes; no separate `tokens.css` / `typography.css` / `reset.css` files (Preflight is included via `@import "tailwindcss"`).

**Naming conventions:** Tailwind v4 prefixes determine which utility family is generated:

- `--color-*` → `bg-*`, `text-*`, `border-*`
- `--spacing-*` → `p-*`, `m-*`, `gap-*`, `w-*`, `h-*`
- `--radius-*` → `rounded-*`
- `--font-*` → `font-*`
- `--text-*` → `text-*` (font-size; supports `--text-*--line-height` companion)
- `--shadow-*` → `shadow-*`

- [ ] **Step 1: Create `src/renderer/styles/global.css`**

Create `src/renderer/styles/global.css`:

```css
@import 'tailwindcss';

/* Load DM Sans once, all weights we use */
@import '@fontsource/dm-sans/400.css';
@import '@fontsource/dm-sans/500.css';
@import '@fontsource/dm-sans/600.css';
@import '@fontsource/dm-sans/700.css';

@theme {
  /* === Fonts === */
  --font-sans: 'DM Sans', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif;

  /* === Colors: Brand & accent === */
  --color-brand-coral: #f4664a;
  --color-brand-magenta: #e046a8;
  --color-brand-blue: #2c70ff;
  --color-brand-blue-deep: #1a4ccc;
  --color-brand-blue-700: #2056cc;
  --color-brand-blue-200: #d6e3ff;
  --color-brand-cyan: #66c4ff;
  --color-brand-purple: #6f3fce;

  /* === Colors: Surface === */
  --color-canvas: #ffffff;
  --color-surface: #f5f5f5;
  --color-surface-soft: #fafafa;
  --color-hairline: #e3e3e3;
  --color-hairline-soft: #efefef;

  /* === Colors: Text === */
  --color-primary: #1a1a1a;
  --color-on-primary: #ffffff;
  --color-on-dark: #ffffff;
  --color-ink: #1a1a1a;
  --color-ink-strong: #000000;
  --color-charcoal: #2a2a2a;
  --color-slate: #555555;
  --color-steel: #777777;
  --color-stone: #999999;
  --color-muted: #b3b3b3;

  /* === Colors: Semantic === */
  --color-success-bg: #e6f4ea;
  --color-success-text: #1e7a3c;

  /* === Spacing (4px base) === */
  --spacing-xxs: 4px;
  --spacing-xs: 8px;
  --spacing-sm: 12px;
  --spacing-md: 16px;
  --spacing-lg: 20px;
  --spacing-xl: 24px;
  --spacing-xxl: 32px;
  --spacing-xxxl: 40px;
  --spacing-section-sm: 48px;
  --spacing-section: 64px;
  --spacing-section-lg: 80px;
  --spacing-hero: 96px;

  /* === Radius === */
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-xxl: 20px;
  --radius-xxxl: 24px;
  --radius-hero: 32px;

  /* === Elevation === */
  --shadow-1: 0 1px 2px 0 rgba(0, 0, 0, 0.04);
  --shadow-2: 0 4px 6px 0 rgba(0, 0, 0, 0.08);
  --shadow-3: 0 0 22px 0 rgba(0, 0, 0, 0.08);
  --shadow-4: 0 12px 16px -4px rgba(36, 36, 36, 0.08);

  /* === Type scale (size + line-height + letter-spacing) === */
  --text-hero-display: 80px;
  --text-hero-display--line-height: 1.1;
  --text-hero-display--letter-spacing: -2px;

  --text-display-lg: 56px;
  --text-display-lg--line-height: 1.1;
  --text-display-lg--letter-spacing: -1.5px;

  --text-heading-lg: 40px;
  --text-heading-lg--line-height: 1.2;
  --text-heading-lg--letter-spacing: -1px;

  --text-heading-md: 32px;
  --text-heading-md--line-height: 1.25;
  --text-heading-md--letter-spacing: -0.5px;

  --text-heading-sm: 24px;
  --text-heading-sm--line-height: 1.3;

  --text-card-title: 20px;
  --text-card-title--line-height: 1.4;

  --text-subtitle: 18px;
  --text-subtitle--line-height: 1.5;

  --text-body-md: 16px;
  --text-body-md--line-height: 1.5;

  --text-body-sm: 14px;
  --text-body-sm--line-height: 1.5;

  --text-caption: 13px;
  --text-caption--line-height: 1.7;

  --text-micro: 12px;
  --text-micro--line-height: 1.5;

  --text-button-md: 14px;
  --text-button-md--line-height: 1.4;
}

/* Body + #root defaults */
@layer base {
  body {
    font-family: var(--font-sans);
    background: var(--color-canvas);
    color: var(--color-ink);
    -webkit-font-smoothing: antialiased;
  }

  #root {
    display: flex;
    min-height: 100vh;
  }
}
```

> **Why one file:** With Tailwind v4 the design system is concise enough that splitting into reset/tokens/typography adds noise without value. If `global.css` later grows past ~250 lines, split tokens into a separate `theme.css` and `@import` it from `global.css`.
>
> **Note on `rounded-full`**: Tailwind v4 ships `rounded-full` as `9999px` natively — we don't need to add it as a custom token.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/styles
git commit -m "feat(m1): add Tailwind v4 with MiniMax design tokens via @theme"
```

---

### Task 7: Shared IPC contract stub

**Files:**

- Create: `src/shared/ipc.ts`

A typed surface for the renderer to call the main process. Empty for M1 (no IPC yet) but defined now so later milestones extend it.

- [ ] **Step 1: Create `src/shared/ipc.ts`**

Create `src/shared/ipc.ts`:

```ts
/**
 * Typed IPC bridge between renderer and main.
 * Channels and methods are added as features land in M2+.
 */
export interface AppApi {
  /** App version surfaced from main → renderer at boot. */
  getAppVersion(): Promise<string>;
}

declare global {
  interface Window {
    api: AppApi;
  }
}

export {};
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/ipc.ts
git commit -m "feat(m1): declare typed IPC bridge shape (window.api)"
```

---

### Task 8: Electron main process

**Files:**

- Create: `src/main/main.ts`

Secure defaults: contextIsolation on, nodeIntegration off, dev opens devtools but production locks them. CSP set via response headers.

- [ ] **Step 1: Create `src/main/main.ts`**

Create `src/main/main.ts`:

```ts
import { BrowserWindow, app, session, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !app.isPackaged;

function setupContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      // Vite dev injects inline scripts; allow only in dev.
      `script-src 'self'${isDev ? " 'unsafe-inline' 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: https:",
      `connect-src 'self'${isDev ? ' ws://localhost:5173 http://localhost:5173' : ''}`,
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // External links open in the OS browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

void app.whenReady().then(() => {
  setupContentSecurityPolicy();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 2: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(m1): add Electron main process with secure defaults and CSP"
```

---

### Task 9: Preload script (typed bridge)

**Files:**

- Create: `src/main/preload.ts`

- [ ] **Step 1: Create `src/main/preload.ts`**

Create `src/main/preload.ts`:

```ts
import type { AppApi } from '@shared/ipc';
import { contextBridge, ipcRenderer } from 'electron';

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
};

contextBridge.exposeInMainWorld('api', api);
```

- [ ] **Step 2: Wire the `app:getVersion` handler in main**

Modify `src/main/main.ts` — add the import and handler. Replace the `void app.whenReady()...` block with:

```ts
import { BrowserWindow, app, ipcMain, session, shell } from 'electron';

// ...everything else above stays the same...

void app.whenReady().then(() => {
  setupContentSecurityPolicy();

  ipcMain.handle('app:getVersion', () => app.getVersion());

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.ts src/main/main.ts
git commit -m "feat(m1): expose typed window.api bridge with app version probe"
```

---

### Task 10: Renderer entry point + index.html

**Files:**

- Create: `src/renderer/index.html`
- Create: `src/renderer/main.tsx`

- [ ] **Step 1: Create `src/renderer/index.html`**

Create `src/renderer/index.html`:

```html
<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Simple Shorts AI</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/renderer/main.tsx`**

Create `src/renderer/main.tsx`:

```tsx
import { StrictMode } from 'react';

import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.html src/renderer/main.tsx
git commit -m "feat(m1): add renderer entry point and HTML shell"
```

---

### Task 11: Placeholder pages (NewJob / Progress / History / Settings)

**Files:**

- Create: `src/renderer/pages/NewJob.tsx`
- Create: `src/renderer/pages/Progress.tsx`
- Create: `src/renderer/pages/History.tsx`
- Create: `src/renderer/pages/Settings.tsx`

Each page is a minimal stub now; later milestones flesh them out. Use a shared layout style so they all look the same.

- [ ] **Step 1: Create `src/renderer/pages/NewJob.tsx`**

Create `src/renderer/pages/NewJob.tsx`:

```tsx
export function NewJobPage() {
  return (
    <section className="p-section">
      <h1 className="text-heading-md font-semibold">새 작업</h1>
      <p className="mt-md text-body-md text-slate">
        YouTube URL을 붙여넣고 옵션을 골라 숏츠 생성을 시작하는 화면. (M3에서 구현)
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Create `src/renderer/pages/Progress.tsx`**

Create `src/renderer/pages/Progress.tsx`:

```tsx
export function ProgressPage() {
  return (
    <section className="p-section">
      <h1 className="text-heading-md font-semibold">작업 중</h1>
      <p className="mt-md text-body-md text-slate">진행 중인 작업의 단계별 진행률과 라이브 로그. (M4 이후)</p>
    </section>
  );
}
```

- [ ] **Step 3: Create `src/renderer/pages/History.tsx`**

Create `src/renderer/pages/History.tsx`:

```tsx
export function HistoryPage() {
  return (
    <section className="p-section">
      <h1 className="text-heading-md font-semibold">히스토리</h1>
      <p className="mt-md text-body-md text-slate">과거 작업 검색 + 리스트/썸네일 뷰 토글. (M9에서 구현)</p>
    </section>
  );
}
```

- [ ] **Step 4: Create `src/renderer/pages/Settings.tsx`**

Create `src/renderer/pages/Settings.tsx`:

```tsx
export function SettingsPage() {
  return (
    <section className="p-section">
      <h1 className="text-heading-md font-semibold">설정</h1>
      <p className="mt-md text-body-md text-slate">API 키, LLM 모델, 경로, Whisper 모델, 자막 스타일. (M2에서 구현)</p>
    </section>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/pages
git commit -m "feat(m1): add placeholder pages for NewJob/Progress/History/Settings"
```

---

### Task 12: Sidebar component

**Files:**

- Create: `src/renderer/components/Sidebar.tsx`

The sidebar has 4 nav items. Active item gets the MiniMax `sidebar-nav-item-active` treatment (surface background + ink text). Uses `NavLink` so React Router applies the active class automatically.

- [ ] **Step 1: Create `src/renderer/components/Sidebar.tsx`**

Create `src/renderer/components/Sidebar.tsx`:

```tsx
import { NavLink } from 'react-router-dom';

type NavItem = { to: string; label: string };

const items: NavItem[] = [
  { to: '/', label: '새 작업' },
  { to: '/progress', label: '작업 중' },
  { to: '/history', label: '히스토리' },
  { to: '/settings', label: '설정' },
];

export function Sidebar() {
  return (
    <nav
      aria-label="주 내비게이션"
      className="gap-xxs border-hairline-soft bg-canvas px-md py-xl flex w-[220px] shrink-0 flex-col border-r"
    >
      <div className="mb-md px-md py-xs text-card-title font-semibold">Shorts AI</div>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            `px-md py-xs text-body-sm block rounded-sm ${
              isActive ? 'bg-surface text-ink font-medium' : 'text-charcoal bg-transparent'
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat(m1): add sidebar with 4 nav items and MiniMax active styling"
```

---

### Task 13: AppShell + Router + App

**Files:**

- Create: `src/renderer/components/AppShell.tsx`
- Create: `src/renderer/router.tsx`
- Create: `src/renderer/App.tsx`

- [ ] **Step 1: Create `src/renderer/components/AppShell.tsx`**

Create `src/renderer/components/AppShell.tsx`:

```tsx
import { Outlet } from 'react-router-dom';

import { Sidebar } from './Sidebar';

export function AppShell() {
  return (
    <>
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </>
  );
}
```

- [ ] **Step 2: Create `src/renderer/router.tsx`**

Create `src/renderer/router.tsx`:

```tsx
import { createHashRouter } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { HistoryPage } from './pages/History';
import { NewJobPage } from './pages/NewJob';
import { ProgressPage } from './pages/Progress';
import { SettingsPage } from './pages/Settings';

// Hash router avoids file:// path issues when running the packaged app.
export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <NewJobPage /> },
      { path: 'progress', element: <ProgressPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);
```

- [ ] **Step 3: Create `src/renderer/App.tsx`**

Create `src/renderer/App.tsx`:

```tsx
import { RouterProvider } from 'react-router-dom';

import { router } from './router';

export function App() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/AppShell.tsx src/renderer/router.tsx src/renderer/App.tsx
git commit -m "feat(m1): wire AppShell layout + hash router for the four pages"
```

---

### Task 14: Vitest setup + smoke test

**Files:**

- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Create `vitest.config.ts`**

Create `vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    css: false,
  },
});
```

- [ ] **Step 2: Create `tests/setup.ts`**

Create `tests/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Write the failing smoke test**

Create `tests/renderer/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '../../src/renderer/App';

describe('App shell', () => {
  it('renders the sidebar with all four nav items', () => {
    render(<App />);
    expect(screen.getByRole('navigation', { name: '주 내비게이션' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '새 작업' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '작업 중' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '히스토리' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '설정' })).toBeInTheDocument();
  });

  it('shows the NewJob page on initial route', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '새 작업' })).toBeInTheDocument();
  });

  it('navigates to settings when the Settings link is clicked', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('link', { name: '설정' }));
    expect(screen.getByRole('heading', { name: '설정' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run tests — they should pass on first run because Tasks 6–13 already shipped the implementation**

```bash
yarn test
```

Expected: 3 passing tests (`App shell > renders the sidebar...`, `App shell > shows the NewJob page...`, `App shell > navigates to settings...`).

If a test fails, fix the implementation in the file the failure points to. Do not modify the test to match a wrong implementation.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts tests/setup.ts tests/renderer/App.test.tsx
git commit -m "test(m1): smoke test for sidebar render and navigation"
```

---

### Task 15: Typecheck + lint clean pass

**Files:**

- (no new files — verifying everything compiles and lints)

- [ ] **Step 1: Run typecheck**

```bash
yarn typecheck
```

Expected: exit code 0, no errors. If errors, fix the source file the error points at (do not loosen tsconfig).

- [ ] **Step 2: Run lint**

```bash
yarn lint
```

Expected: exit code 0, no errors. Warnings about unused vars are acceptable if intentional.

- [ ] **Step 3: Run prettier check**

```bash
yarn prettier --check .
```

Expected: all files match. If not, run `yarn format` and re-stage.

- [ ] **Step 4: Commit any auto-format changes (if applied)**

```bash
git status
# If anything changed:
git add -A
git commit -m "chore(m1): apply prettier formatting"
```

---

### Task 16: Manual verification — `yarn dev`

This is a human-in-the-loop step. The agent should run the dev server and report what they observed; the user verifies in the actual window.

- [ ] **Step 1: Run dev**

```bash
yarn dev
```

Expected: Electron window opens within ~3 seconds. Sidebar on the left with 4 items. "새 작업" page visible by default.

- [ ] **Step 2: Manually click each sidebar item**

For each of "새 작업" / "작업 중" / "히스토리" / "설정":

- The clicked item gets the surface (`#f5f5f5`) background.
- The main pane shows the matching heading (e.g., clicking "설정" shows a "설정" heading).
- DM Sans is rendered (not the system fallback).

If any of those fail, fix and re-run.

- [ ] **Step 3: Stop the dev server**

In the terminal: `Ctrl+C`.

- [ ] **Step 4: Run production build to verify it bundles**

```bash
yarn build
```

Expected: exit code 0; `out/main/`, `out/preload/`, `out/renderer/` populated.

- [ ] **Step 5: Final commit (only if any fixes were made above)**

```bash
git status
# Only commit if there are tracked changes from manual fixes.
```

---

### Task 17: Update README status

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Update the Status section**

Edit `README.md`, replace the `## Status` section with:

```markdown
## Status

- ✅ M1: Project Skeleton — Electron + React + TypeScript scaffold, MiniMax tokens, sidebar + 4 placeholder pages, smoke test.
- ⏳ M2: Settings page (next)
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(m1): mark milestone 1 complete in README"
```

---

## Definition of Done (M1)

All of these must be true before declaring M1 finished:

1. `yarn install && yarn dev` opens a working Electron window with the sidebar layout.
2. Clicking each of the 4 sidebar items changes the main pane and applies the active styling.
3. `yarn typecheck` exits 0.
4. `yarn lint` exits 0.
5. `yarn test` passes 3/3.
6. `yarn build` produces `out/main/main.js`, `out/preload/preload.js`, `out/renderer/index.html`.
7. Git history is clean (one commit per task).

## What's NOT in M1 (intentionally deferred)

- Any IPC method beyond the version probe — wired in M2 with the settings work.
- Real settings UI / keychain — M2.
- yt-dlp / video preview — M3.
- Python sidecar — M4.
- Packaging / installers — M10.

## Notes for the implementing agent

- **Use Tailwind utilities, not inline styles.** All component styling is via Tailwind classes generated from the `@theme` tokens in `global.css`. Do not write `style={{ ... }}` blocks except for truly dynamic computed values.
- **Do not invent new design tokens.** Use only what's defined in the `@theme` block in `global.css`. If you need a value that's missing, add it there (matching the MiniMax spec naming) before consuming it.
- **Do not create `tailwind.config.ts` or `postcss.config.js`** — Tailwind v4 with `@tailwindcss/vite` reads everything from CSS.
- **Do not add a state management library** (Redux/Zustand). React Router state + local state is sufficient for M1.
- **Do not introduce dark mode** — explicitly out of v1 scope.
- **Do not add error boundaries or telemetry** — comes in later milestones where it has actual signal.
- If `yarn install` warns about peer dep mismatches in the React/TypeScript ecosystem, prefer the versions pinned in this plan over yarn's suggestion. Do not bump the `@bob-park/*` package versions without checking with the user — they are coordinated across the user's projects.
