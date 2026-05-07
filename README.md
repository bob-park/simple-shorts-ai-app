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

M1: Project Skeleton (in progress)
