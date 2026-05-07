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

## Status

- ✅ M1: Project Skeleton — Electron + React + TypeScript scaffold, MiniMax tokens, sidebar + 4 placeholder pages, smoke test.
- ✅ M2: Settings page — 5 sections (API & 모델, 경로, Whisper 모델, 자막 스타일, 출력 옵션), electron-store persistence, safeStorage-encrypted API key, native folder dialogs.
- ⏳ M3: YouTube preview + download (next)
