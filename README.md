# Simple Shorts AI App

YouTube → local Whisper STT → LLM highlight extraction → 9:16 shorts with burned-in captions.
Cross-platform desktop app (macOS + Windows).

See `docs/superpowers/specs/2026-05-07-shorts-ai-design.md` for the design.
See `docs/superpowers/plans/` for milestone implementation plans.

## Toolchain

This repo uses [mise](https://mise.jdx.dev/) to pin Node 24 + Yarn 4 + Python 3.11 + uv. Run `mise install` once after cloning.

## Development

```bash
yarn install      # postinstall auto-rebuilds better-sqlite3 against Electron's Node ABI
yarn dev          # launches the Electron app with HMR
yarn typecheck
yarn test         # runs vitest under Electron's Node so native modules load
yarn lint
```

> **Native module note:** `better-sqlite3` (added in M9) is a native binding that
> must be compiled against Electron's embedded Node ABI, not your system Node.
> The `postinstall` script handles this automatically. If you ever see a
> `NODE_MODULE_VERSION` mismatch error, run `yarn rebuild:electron` manually.
> Test runs use `ELECTRON_RUN_AS_NODE=1` so vitest loads the same Electron-ABI
> binary the app does.

## LLM

Highlight extraction runs locally via llama-cpp-python with a Gemma 4 E4B GGUF.
The model file (~2.5GB) is downloaded automatically on the first 하이라이트 추출
click into `~/Library/Application Support/<app>/models/`. No API key required.

## Status

- ✅ M1: Project Skeleton
- ✅ M2: Settings page
- ✅ M3: YouTube preview + download — paste a URL, see meta card, download with live progress and cancel.
- ✅ M4: Python sidecar + STT — uv-managed sidecar with faster-whisper, JSON-RPC stdio, lazy boot, transcript.json next to source.
- ✅ M5: LLM highlight extraction — OpenRouter via openai SDK, sliding-window for long transcripts, highlights.json next to source, in-app card list.
- ✅ M6: First end-to-end render — system ffmpeg, center-crop 9:16, sequential per-clip queue, partial success on per-clip failure.
- ✅ M7: Smart face tracking — MediaPipe per-clip face tracking, Gaussian-smoothed sendcmd-driven dynamic crop, auto-fallback to center on detection failure.
- ✅ M8: Subtitle burn-in — word-grouped TikTok-style ASS captions, libass-rendered in the same single-pass ffmpeg run, styled by Settings.
- ✅ M9: History persistence — better-sqlite3 + FTS5, per-short ffmpeg thumbnails, list/grid view toggle, search/sort/status-filter, detail drawer with reveal/delete.
- ✅ M10: Segment-based highlights — non-contiguous Whisper-segment montages, single-pass ffmpeg `select` filter, M7 tracking + M8 subtitles rebased to montage time. Replaces M5's word-level extraction.
- ✅ M11: LLM local — Gemma 4 E4B Q4_K_M via llama-cpp-python in the sidecar. GBNF JSON grammar. Lazy first-call download (~2.5GB). OpenRouter cloud path removed.
- ⏳ M12: Packaging & distribution (next — was M10 in original spec, deferred twice)
