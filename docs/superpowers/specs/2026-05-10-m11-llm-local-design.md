# M11 — LLM Local (Gemma via llama-cpp-python) Design Spec

**Status:** Approved 2026-05-10. Replaces OpenRouter cloud LLM with a locally-hosted Gemma 3 4B model running through llama-cpp-python in the existing Python sidecar. Shipped before packaging (M12) so the dogfood-able dev-mode app gets the full local-only experience first.

**Why:** Offline operation, no per-call API cost, no API key management, simpler Settings UI. Trade-off accepted: slower first-call (model load + cold start), lower ceiling on narrative quality vs. Claude Sonnet — verified acceptable for highlight extraction at this scope.

**Outcome:** `HighlightService` calls a new sidecar RPC `llm_chat` instead of OpenRouter. Settings drops the LLM section's API key + provider/model fields. First call to "하이라이트 추출" downloads the Gemma GGUF (~2.5GB) with progress; thereafter the model loads from disk in ~3s and stays warm in the sidecar.

---

## 1. Architecture

### 1.1 Components

```
NewJob page
    │
    ├── (existing) Whisper STT → transcript.json
    │
    └── HighlightCard onStart()
        │
        ▼
main.ts: extractHighlights IPC
    │
    ▼
HighlightService.extract(opts)        ← OpenRouter client gone
    │
    ├── chunkPlanner.planChunks(...)  (unchanged)
    │
    └── for each chunk:
            sidecar.call('llm_chat', {prompt, schema_id: 'highlights'})
                │
                ▼
          Python sidecar
            │
            ├── handlers/llm.py (NEW)
            │     • lazy load model at first chat call
            │     • llama-cpp-python with Metal (AS) or CPU (Intel)
            │     • GBNF grammar enforces JSON shape
            │     • streams nothing — single response per call
            │
            └── handlers/llm.py llm_download_model
                  • streams HuggingFace download with progress
                  • atomic rename on completion
```

### 1.2 Model file management

```
$userData/models/                              # Electron app.getPath('userData')
├── gemma-3-4b-it-Q4_K_M.gguf                  # final model file
└── gemma-3-4b-it-Q4_K_M.gguf.partial          # only exists during download
```

`$userData` resolves to:
- macOS: `~/Library/Application Support/simple-shorts-ai-app/`
- (M12 packaged: `~/Library/Application Support/Shorts AI/`)

The path is computed in main.ts via `app.getPath('userData')` and passed to the sidecar through `llm_chat` / `llm_download_model` opts. The sidecar never hardcodes paths.

### 1.3 First-call flow (model not yet downloaded)

```
User clicks "하이라이트 추출"
  → main.ts checks: does $userData/models/gemma-3-4b-it-Q4_K_M.gguf exist?
  → No: emit extract:progress { phase: 'download', pct: 0 }
  → call sidecar.llm_download_model({modelPath, source: 'unsloth/gemma-3-4b-it-GGUF'})
    → sidecar streams progress lines via stdout (RPC notifications)
    → main forwards as extract:progress events
  → On completion: continue to chunked extraction (existing flow)
```

If download fails or is canceled mid-way, the `.partial` file is deleted (sidecar's own cleanup). Subsequent retries start fresh — no resume support in v1.

### 1.4 Subsequent calls (model present)

```
User clicks "하이라이트 추출"
  → main.ts: file exists, skip download
  → first chunk: emit extract:progress { phase: 'chunk', chunkIndex: 1, ... }
  → sidecar.llm_chat({modelPath, system, user, schema_id: 'highlights'})
    → sidecar lazy-loads model (~3s first time, then cached in memory)
    → completes with JSON-grammar-enforced response
  → HighlightService parses + maps + dedupes (unchanged downstream)
```

The loaded model stays in the sidecar process memory. If the user runs another extraction in the same session, no reload cost.

---

## 2. RPC contract

Three new methods on the Python sidecar JSON-RPC server:

### 2.1 `llm_download_model`

```python
# Request
{
  "method": "llm_download_model",
  "params": {
    "modelPath": "/Users/.../models/gemma-3-4b-it-Q4_K_M.gguf",
    "source": "unsloth/gemma-3-4b-it-GGUF",  # HuggingFace repo
    "filename": "gemma-3-4b-it-Q4_K_M.gguf"  # file inside the repo
  }
}

# Notifications during call (RPC notifications, not responses)
{
  "method": "llm_download_progress",
  "params": { "downloadedBytes": 12345, "totalBytes": 2500000000, "pct": 0.49 }
}
# emitted every ~500ms or every 1% (whichever first)

# Response on completion
{ "result": { "ok": true, "sha256": "abc..." } }

# Or error
{ "error": { "code": -32000, "message": "Network error: ..." } }
```

### 2.2 `llm_chat`

```python
# Request
{
  "method": "llm_chat",
  "params": {
    "modelPath": "/Users/.../models/gemma-3-4b-it-Q4_K_M.gguf",
    "system": "당신은 짧은 영상 편집자다. ...",
    "user": "청크 시작 글로벌 인덱스: 0\n...",
    "schemaId": "highlights",   # one of: 'highlights' | 'highlights_rerank'
    "temperature": 0.7,
    "maxTokens": 4096
  }
}

# Response (single, not streaming)
{
  "result": {
    "json": { "highlights": [...] },   # parsed object, not string
    "usage": { "promptTokens": 1234, "completionTokens": 567 }
  }
}
```

The sidecar parses the model's text output (which is constrained by GBNF grammar to be valid JSON for the requested `schemaId`) and returns the already-parsed object. No fence-stripping or escape needed — GBNF guarantees it.

### 2.3 `llm_model_status`

```python
# Request
{ "method": "llm_model_status", "params": { "modelPath": "/Users/.../...gguf" } }

# Response
{
  "result": {
    "exists": true,
    "sizeBytes": 2500000000,
    "loaded": false   # whether the sidecar has it in memory right now
  }
}
```

Used by main.ts on app boot to know whether to surface the "다운로드 필요" state in HighlightCard ahead of user interaction.

---

## 3. Sidecar implementation

### 3.1 `sidecar/pyproject.toml`

```toml
dependencies = [
  "faster-whisper==1.0.3",          # unchanged
  "mediapipe==0.10.18",             # unchanged
  "opencv-python==4.10.0.84",       # unchanged
  "llama-cpp-python==0.3.2",        # NEW — versions for Metal+CPU compatibility
  "huggingface-hub==0.26.5",        # NEW — for model download
]
```

`llama-cpp-python` ships PyPI wheels for macOS arm64 with Metal support and macOS x86_64 (CPU). No build-from-source required at install time.

### 3.2 `sidecar/handlers/llm.py` (NEW)

Three exported functions matching the RPC methods. Key implementation notes:

```python
# Module-level cache so model is loaded once per sidecar process
_loaded_model: Llama | None = None
_loaded_model_path: str | None = None

# JSON grammars cached at module load
_GRAMMARS = {
    'highlights': llama_cpp.LlamaGrammar.from_string(HIGHLIGHTS_GBNF),
    'highlights_rerank': llama_cpp.LlamaGrammar.from_string(HIGHLIGHTS_GBNF),  # same shape
}

def _ensure_loaded(model_path: str) -> Llama:
    global _loaded_model, _loaded_model_path
    if _loaded_model is None or _loaded_model_path != model_path:
        if _loaded_model is not None:
            del _loaded_model  # release memory before loading new
        _loaded_model = Llama(
            model_path=model_path,
            n_ctx=8192,            # Gemma 3 supports more, but 8k covers our chunk size
            n_gpu_layers=-1,       # all layers to GPU on Metal; ignored on CPU build
            verbose=False,
        )
        _loaded_model_path = model_path
    return _loaded_model

def llm_chat(model_path, system, user, schema_id, temperature, max_tokens):
    model = _ensure_loaded(model_path)
    grammar = _GRAMMARS[schema_id]
    out = model.create_chat_completion(
        messages=[
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        grammar=grammar,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    text = out['choices'][0]['message']['content']
    return {
        'json': json.loads(text),
        'usage': out['usage'],
    }
```

The GBNF grammar string for `highlights`:

```
root        ::= "{" ws "\"highlights\"" ws ":" ws highlights ws "}"
highlights  ::= "[" ws (highlight (ws "," ws highlight)*)? ws "]"
highlight   ::= "{" ws
                  "\"segment_indices\"" ws ":" ws indices ws "," ws
                  "\"title\"" ws ":" ws string ws "," ws
                  "\"hook\"" ws ":" ws string
                ws "}"
indices     ::= "[" ws (integer (ws "," ws integer)*)? ws "]"
integer     ::= [0-9] [0-9]*
string      ::= "\"" char* "\""
char        ::= [^"\\] | "\\" ["\\/bfnrt] | "\\u" [0-9a-fA-F]{4}
ws          ::= [ \t\n]*
```

(Order matters in GBNF; this above is illustrative — actual file will be tested against valid + invalid samples.)

### 3.3 `sidecar/handlers/llm.py llm_download_model`

Uses `huggingface_hub.hf_hub_download` with a custom callback for progress, downloading to `<modelPath>.partial`, then renaming on success. On exception or abort, the partial file is deleted in a `finally` block. SHA-256 is computed during write and returned in the success response.

---

## 4. Main process changes

### 4.1 `src/main/services/HighlightService.ts`

The orchestration shape stays the same — `extract(opts)` → maybe-chunked LLM calls → optional rerank → final `HighlightSet`. The `ClientLike` interface changes:

```ts
// OLD (deleted)
interface ClientLike {
  chatJson(opts: { apiKey, model, systemPrompt, userPrompt, ... }): Promise<unknown>;
}

// NEW
interface ClientLike {
  chat(opts: { system: string; user: string; schemaId: 'highlights' | 'highlights_rerank' }): Promise<{ highlights: unknown[] }>;
}
```

The service's parsing/dedup/sort/bounds-check pipeline is unchanged — it operates on the parsed object regardless of source. The new client wraps the sidecar IPC.

The `apiKey` parameter and `MissingApiKey` early-throw are deleted entirely. The `model` string is gone from `ExtractOptions`; the constant `'gemma-3-4b'` is set inside HighlightService when constructing `HighlightSet.model`.

### 4.2 New `src/main/infra/SidecarLlmClient.ts`

A thin wrapper around the existing `PythonSidecar` instance, implementing the new `ClientLike`. Mirrors the pattern of how `PythonSidecar.transcribe` is wrapped. The model path is injected at construction time (computed in main.ts from `app.getPath('userData')`).

### 4.3 `src/main/main.ts`

- Delete OpenRouter client construction.
- Construct `SidecarLlmClient` with the model path.
- Pass it into `HighlightService` constructor.
- Add IPC: `llm:download-model` that calls sidecar and streams progress through the existing `onExtractProgress` channel under `phase: 'download'`.
- On `extract:run`, call `sidecar.llmModelStatus(modelPath)`. If `exists === false`, kick off download first, then proceed.

### 4.4 Deleted files

- `src/main/infra/OpenRouterClient.ts`
- `src/main/infra/OpenRouterClient.test.ts`

---

## 5. Settings + UI

### 5.1 `src/shared/settings.ts`

```ts
// REMOVED
llm: z.object({
  provider: z.literal('openrouter'),
  model: z.string().min(1),
}),
```

The `llm` key is removed entirely. `SettingsSchema` no longer has it. `DEFAULT_SETTINGS_TEMPLATE` no longer initializes it.

The legacy `llm.openrouterApiKey` keytar entry stays in keytar (unused). New install / re-install: no key prompt.

### 5.2 `src/renderer/components/settings/LlmSection.tsx`

The current LlmSection card with API key input is **replaced** with a small read-only info card:

```
┌─ 하이라이트 모델 ─────────────────────┐
│ Gemma 3 4B (Q4_K_M)                  │
│ ✓ 다운로드됨 (2.5GB)                  │
│   ~/Library/Application Support/.../  │
│   models/gemma-3-4b-it-Q4_K_M.gguf    │
│                                       │
│ [모델 폴더 열기]   [재다운로드]        │
└──────────────────────────────────────┘
```

If model not downloaded, the same card shows:

```
│ Gemma 3 4B (Q4_K_M)                  │
│ ⚠️ 다운로드 안 됨 (~2.5GB 필요)        │
│ 첫 하이라이트 추출 시 자동 다운로드    │
```

The "재다운로드" button deletes the existing file then triggers `llm:download-model`. "모델 폴더 열기" reveals in Finder.

### 5.3 `src/renderer/components/newjob/HighlightCard.tsx`

The `'missing-key'` discriminated state is **removed**. A new state `'downloading-model'` is added:

```ts
type Props =
  | { status: 'probing' }
  | { status: 'idle'; onStart: () => void }
  | { status: 'downloading-model'; pct: number; downloadedMb: number; totalMb: number }   // NEW
  | { status: 'extracting'; progress: Progress | null; onCancel: () => void }
  | { status: 'done'; ... }
  | { status: 'canceled'; onReset: () => void }
  | { status: 'error'; error: Error; onReset: () => void };
```

The `extracting` state's `progress` discriminator gets a new `phase: 'download'` value handled before the existing chunk/rerank phases — but for cleaner UX, downloading is its own top-level state, not crammed into 'extracting'.

`probing` checks model status on mount. If not downloaded, `idle` button label becomes "모델 다운로드 후 추출" (single click triggers both).

### 5.4 `src/shared/extract.ts`

`ExtractProgress.phase` enum gains `'download'`. The shape of the progress event is unchanged. The renderer treats `'download'` separately at the HighlightCard level (lifts to `'downloading-model'` state).

---

## 6. Failure handling

| Failure | UX |
|---|---|
| Model file missing on extract trigger | Auto-trigger download first; user sees `downloading-model` state |
| Download network error | `error` state with stderr tail + 다시 시도 |
| Download canceled (user closes app) | Partial file deleted on next sidecar boot's startup check |
| Sidecar OOM during model load (Intel Mac, 4GB-class hardware) | `error` state with "메모리 부족" message; suggestion: 더 작은 모델 (out of v1 since 4B is fixed) |
| llama-cpp-python wheel install failure (rare) | Sidecar boot fails → existing M4 sidecar-down flow kicks in; UI shows "사이드카 시작 실패" |
| GBNF grammar rejects model output (shouldn't happen by construction) | `error` state with "LLM 응답 파싱 실패" — should never trigger; safety net |
| Model loaded but generates empty highlights array | Same as M10's existing "0 highlights" path (UI shows 0개 추출) |

---

## 7. Testing strategy

### 7.1 Unit tests

| File | Cases |
|---|---|
| `SidecarLlmClient.test.ts` (new) | RPC call shape, schemaId mapping, error propagation. Mock sidecar. ~4 cases |
| `HighlightService.test.ts` | (rewrite) operates on new client mock returning `{ highlights: [...] }`. Existing 9 cases adapt — same asserts, simpler client. |
| `Settings.test.tsx` (or LlmSection-specific) | (rewrite) no API key input, model status card displays correctly in 3 states. ~3 cases |
| `HighlightCard` smoke test | (update) `downloading-model` state renders progress; `idle` triggers download flow when model missing |
| `tests/renderer/App.test.tsx` | (no change — already passes since OpenRouter wasn't asserted) |
| `tests/sidecar/test_llm.py` (new) | GBNF grammar parses sample outputs; download-progress callback fires; cleanup of `.partial` on exception. ~5 cases |

Net: ~10 vitest changes (some additions, some deletions of OpenRouter tests). Sidecar pytest +5. Total target: ~185 vitest, 29 sidecar pytest.

### 7.2 What we DON'T test in M11

- Real model load + inference (would require 2.5GB GGUF in CI). Tests mock the sidecar.
- Real HuggingFace download. Tests mock `huggingface_hub.hf_hub_download`.
- llama-cpp-python's actual JSON-grammar enforcement. Tested manually + smoke-tested in dev mode.

### 7.3 Manual integration

After M11 implementation:

1. Delete `~/Library/Application Support/simple-shorts-ai-app/models/` if present.
2. `yarn dev`, run pipeline: paste URL → STT → click 하이라이트 추출.
3. Verify download card appears, progress streams from 0% to 100% over ~2-5 min (depends on connection).
4. After completion, verify chunked extraction runs and produces highlights.
5. Quit app, re-run extraction on the same video — should skip download, load model in ~3s, produce highlights.
6. Compare highlight quality vs. previous Claude Sonnet runs on the same video. Acceptance: comparable narrative coherence; titles/hooks should not be obviously worse.

---

## 8. Migration

**Hard break.** OpenRouter API key in keytar stays in the keychain but is never read again. Settings UI no longer surfaces it (no migration prompt — the user just sees the new model card on next Settings open). The persisted electron-store settings JSON may still have a `llm` field from M10; zod's default behavior ignores unknown keys at `parse`, so legacy data does not break the new schema and we don't actively delete it.

This is acceptable because the project is pre-launch and the user is the sole tester.

---

## 9. Risk + edge cases

| Risk | Mitigation |
|---|---|
| llama-cpp-python wheel for macOS arm64 + Metal not on PyPI for current version | Pin version 0.3.2 (verified availability at brainstorming time); on install failure, fall back to CPU wheel — slower but functional |
| Gemma 3 4B Q4_K_M quality on multi-chunk rerank insufficient | Acceptable degraded quality for v1; if narrative judgments are obviously worse, document as known limitation. M11+ can swap to 12B or revisit |
| First load (~3s) feels broken to user | UI shows "모델 로딩 중..." between download completion and first chunk progress event |
| Sidecar process memory grows by ~5GB after model load | Document; user should close other heavy apps. No mitigation in v1. Future: explicit "모델 언로드" button |
| Intel Mac users without GPU acceleration get very slow inference | Document; can take 30+ seconds per chunk. Out-of-scope to optimize for Intel. |
| Model download hash mismatch (HuggingFace repo updated) | Verify SHA-256 against pinned hash in `sidecar/handlers/llm.py`; mismatch → reject and re-download |
| HuggingFace requires auth for some Gemma repos | Use the `unsloth/gemma-3-4b-it-GGUF` mirror (verified public, no auth required) |
| GBNF grammar bug causes infinite output | `max_tokens=4096` cap + grammar must always reach a `}` close — test against pathological inputs |
| Transition: m10's HighlightService.test.ts has 9 tests that assume OpenRouter shape | Plan task explicitly rewrites these — included in 7.1 above |

---

## 10. What's NOT in M11

- Model picker UI (other Gemma sizes / other model families)
- Per-chunk parallelism (current sequential per-chunk loop unchanged)
- Streaming responses (single-shot per chunk)
- Quantization picker (Q4_K_M fixed)
- Resume of partial downloads (delete + restart)
- Bundle the GGUF into the .app (M12 bundles ffmpeg/Python but not the 2.5GB model — too big; lazy download only)
- Telemetry on inference latency (manual measurements only)
- Multi-model in-memory cache (one model at a time; if model path changes, unload + reload)

---

## 11. Notes for the implementing agent

- llama-cpp-python's `Llama.create_chat_completion` is the highest-level API and supports `grammar=` natively. Don't drop to `Llama()` raw token loops.
- `huggingface_hub.hf_hub_download` accepts a `cache_dir` plus `local_dir` — use `local_dir` to write directly to our target location (avoids HF's symlink dance) and `local_dir_use_symlinks=False`.
- Model file SHA-256 should be pinned in code, not in spec; the spec just lists "pinned to whatever was current at implementation time."
- In dev mode, `app.getPath('userData')` returns `/Users/<user>/Library/Application Support/Electron` — *not* the project directory. Verify this works for the test fixture path or override via env var.
- The sidecar's RPC notification mechanism (for download progress) needs to be re-checked — if the M4 sidecar didn't expose a notifications channel, this M11 work adds it. If notifications can't be added cleanly, fall back to polling: main calls `llm_download_status` every 500ms while a download is active.
- The M10 chunked rerank prompt restated the schema explicitly (per the post-merge fix). Keep both `highlights` and `highlights_rerank` GBNFs identical for now; the difference is purely in the system prompt copy, not in the JSON shape.
- README needs updating: drop OpenRouter section entirely, add a note about local model + first-call download.
