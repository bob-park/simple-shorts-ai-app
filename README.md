# Simple Shorts AI App

YouTube → local Whisper STT → LLM highlight extraction → 9:16 shorts with burned-in captions.
Cross-platform desktop app (macOS + Windows).

See `docs/superpowers/specs/2026-05-07-shorts-ai-design.md` for the design.
See `docs/superpowers/plans/` for milestone implementation plans.

## Toolchain

This repo uses [mise](https://mise.jdx.dev/) to pin Node 24 + Yarn 4 + Python 3.11 + uv. Run `mise install` once after cloning.

## Development

```bash
yarn install
yarn dev          # launches the Electron app with HMR
yarn typecheck
yarn test
yarn lint
```

## Status

- ✅ M1: Project Skeleton
- ✅ M2: Settings page
- ✅ M3: YouTube preview + download — paste a URL, see meta card, download with live progress and cancel.
- ✅ M4: Python sidecar + STT — uv-managed sidecar with faster-whisper, JSON-RPC stdio, lazy boot, transcript.json next to source.
- ⏳ M5: LLM highlight extraction (next)
