# M4: Python Sidecar + STT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a long-running Python sidecar that speaks JSON-RPC over stdio to the Electron main process, exposing a `transcribe()` method backed by `faster-whisper`. Add a "전사 시작" button to the NewJob page after download completes; clicking it streams progress to the renderer and saves a `<videoStem>.transcript.json` next to the source video. The sidecar boots lazily on first transcribe call, keeps the model warm between jobs, and is restarted by the main process if it crashes.

**Architecture:** A small Python project lives at `sidecar/` (its own pyproject.toml, uv-managed venv, src layout). The Node main process spawns it on demand with `python -m shorts_sidecar`. Communication is line-delimited JSON messages over stdin/stdout — request/response correlated by `id`, plus one-way `progress` notifications. `PythonSidecar` (Node) owns process lifecycle and request/response correlation; `TranscribeService` is the higher-level facade. The Python side runs a stdin reader on a daemon thread and dispatches transcribe work to a worker thread so cancel requests can interrupt mid-job via a `threading.Event`.

**Tech Stack:** Python 3.11 (pinned via mise), `uv` for venv + dependency management, `faster-whisper` ^1.0, `pytest` for sidecar tests. TypeScript side reuses existing patterns: zod schemas in `shared/`, IPC contract in `shared/ipc.ts`, services in `src/main/services/`, hooks + components in `src/renderer/`. Models cache to `app.getPath('userData')/whisper-models` via the `HF_HOME` env var so they don't pollute the user's home cache.

---

## File Structure

```
.mise.toml                         # MODIFY: add python = '3.11', uv (latest)
.gitignore                         # MODIFY: ignore sidecar/.venv, __pycache__, .pytest_cache, *.transcript.json (no — we write into user dirs)
sidecar/
├── pyproject.toml                 # NEW: uv project, faster-whisper + pytest deps
├── uv.lock                        # NEW: locked deps
├── README.md                      # NEW: how to run sidecar standalone for dev
├── src/
│   └── shorts_sidecar/
│       ├── __init__.py
│       ├── __main__.py            # NEW: entrypoint — main loop wires reader/dispatcher
│       ├── rpc.py                 # NEW: line-JSON protocol (parse/encode, no IO)
│       ├── whisper_engine.py      # NEW: faster-whisper wrapper, lazy model load
│       └── server.py              # NEW: Server class — owns model + worker thread + cancel event
└── tests/
    ├── __init__.py
    ├── test_rpc.py                # NEW: pytest — protocol parsing
    ├── test_whisper_engine.py     # NEW: pytest — wrapper with mocked WhisperModel
    └── test_server.py             # NEW: pytest — server dispatch logic with mocked engine

src/
├── shared/
│   ├── transcript.ts              # NEW: Segment, Word, Transcript zod schemas
│   ├── transcribe.ts              # NEW: TranscribeProgress, TranscribeStatus types
│   └── ipc.ts                     # MODIFY: add transcribe / cancelTranscribe / onTranscribeProgress / sidecarHealth
├── main/
│   ├── main.ts                    # MODIFY: instantiate sidecar + service, register IPC, save transcript.json
│   ├── preload.ts                 # MODIFY: expose new methods + progress subscription
│   ├── infra/
│   │   ├── PythonSidecar.ts       # NEW: process lifecycle + JSON-RPC client
│   │   └── PythonSidecar.test.ts  # NEW: vitest with fake child
│   └── services/
│       ├── TranscribeService.ts   # NEW: thin facade, calls sidecar.transcribe with progress forwarding
│       └── TranscribeService.test.ts # NEW: vitest with mocked PythonSidecar
└── renderer/
    ├── hooks/
    │   └── useTranscribe.ts       # NEW: state machine
    └── components/
        └── newjob/
            ├── TranscribeCard.tsx  # NEW: 전사 시작 / progress / done states
            └── DownloadProgress.tsx # (unchanged — TranscribeCard renders separately)
└── pages/
    └── NewJob.tsx                  # MODIFY: render TranscribeCard when download.status === 'done'
tests/
└── renderer/
    └── NewJob.test.tsx             # MODIFY: add transcribe stub, ensure existing tests still pass
```

**Decomposition rationale:**

- The Python sidecar is its own project with its own dependency manifest. Mixing it into the Node `package.json` would couple unrelated build systems.
- `rpc.py` has zero IO so it's trivial to unit-test. `server.py` owns threads + the engine but delegates parsing to `rpc.py`. `whisper_engine.py` wraps faster-whisper and exposes a generator-of-segments API.
- TS-side: `PythonSidecar` is the protocol-aware transport (manages spawn, stdin/stdout, request id correlation, progress dispatch). `TranscribeService` is the domain-level orchestrator (saves transcript.json, talks to settings).
- The renderer adds one new component (`TranscribeCard`) rather than overloading `DownloadProgress` — the two flows are sequential but independently designed.

---

## Tasks

### Task 1: Toolchain — pin Python 3.11 + uv via mise

**Files:**

- Modify: `.mise.toml`
- Modify: `.gitignore`

- [ ] **Step 1: Add Python + uv to `.mise.toml`**

Read the current `.mise.toml`:

```toml
[tools]
node = '24'
yarn = '4.14.1'
```

Append the new tools so it becomes:

```toml
[tools]
node = '24'
yarn = '4.14.1'
python = '3.11'
uv = 'latest'
```

- [ ] **Step 2: Activate the new tools**

```bash
mise install
python --version
uv --version
```

Expected: `python` prints `Python 3.11.x`, `uv` prints `uv 0.x.x`. If either is missing, `mise install` should pull them; if mise reports "no plugin", run `mise plugin install python` and `mise plugin install uv`.

- [ ] **Step 3: Extend `.gitignore` for Python artifacts**

Append to the bottom of `.gitignore`:

```
### python ###
sidecar/.venv/
sidecar/**/__pycache__/
sidecar/**/*.pyc
sidecar/.pytest_cache/
sidecar/.ruff_cache/
sidecar/.mypy_cache/
```

- [ ] **Step 4: Commit**

```bash
git add .mise.toml .gitignore
git commit -m "chore(m4): pin python 3.11 and uv via mise, ignore python build artifacts"
```

---

### Task 2: Sidecar project scaffold (pyproject + dependencies)

**Files:**

- Create: `sidecar/pyproject.toml`
- Create: `sidecar/README.md`
- Create: `sidecar/src/shorts_sidecar/__init__.py`

- [ ] **Step 1: Create `sidecar/pyproject.toml`**

```toml
[project]
name = "shorts-sidecar"
version = "0.1.0"
description = "Local STT + (later) face tracking sidecar for simple-shorts-ai-app."
requires-python = ">=3.11,<3.13"
dependencies = [
  "faster-whisper>=1.0.3",
]

[dependency-groups]
dev = [
  "pytest>=8.0",
  "pytest-asyncio>=0.23",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/shorts_sidecar"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
```

- [ ] **Step 2: Create `sidecar/README.md`**

````markdown
# shorts-sidecar

Long-running Python process that speaks line-delimited JSON-RPC over stdio.
Spawned by the Electron main process on demand; never run directly by users.

## Local development

```bash
cd sidecar
uv sync                     # creates .venv with deps
uv run pytest               # runs the test suite
uv run python -m shorts_sidecar < /dev/null  # smoke (immediate EOF → exits 0)
```
````

Send a request manually:

```bash
echo '{"id":"1","method":"health"}' | uv run python -m shorts_sidecar
```

Expected output: `{"id":"1","result":{"ok":true,"modelsLoaded":[]}}`.

````

- [ ] **Step 3: Create the package entry**

Create `sidecar/src/shorts_sidecar/__init__.py`:

```python
"""Long-running STT/face-tracking sidecar for simple-shorts-ai-app."""

__version__ = "0.1.0"
````

- [ ] **Step 4: Initialize the venv and install deps**

```bash
cd sidecar
uv sync
ls .venv/bin/python      # confirm venv exists
uv run python -c 'import faster_whisper; print(faster_whisper.__version__)'
cd ..
```

Expected: `uv sync` creates `.venv` and `uv.lock`. The version probe prints something like `1.0.3` or higher.

- [ ] **Step 5: Commit**

```bash
git add sidecar/pyproject.toml sidecar/README.md sidecar/src/shorts_sidecar/__init__.py sidecar/uv.lock
git commit -m "feat(m4): scaffold sidecar python project with faster-whisper dep"
```

---

### Task 3: RPC line protocol (TDD)

**Files:**

- Create: `sidecar/src/shorts_sidecar/rpc.py`
- Create: `sidecar/tests/__init__.py`
- Create: `sidecar/tests/test_rpc.py`

The `rpc` module is pure — it converts dicts to/from JSON lines. No threading, no IO.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/__init__.py` as an empty file.

Create `sidecar/tests/test_rpc.py`:

```python
import json
import pytest

from shorts_sidecar.rpc import (
    encode_message,
    parse_line,
    response,
    error_response,
    notification,
)


def test_parse_line_decodes_a_request():
    line = '{"id":"abc","method":"transcribe","params":{"audio_path":"/tmp/x.mp4"}}'
    msg = parse_line(line)
    assert msg == {
        "id": "abc",
        "method": "transcribe",
        "params": {"audio_path": "/tmp/x.mp4"},
    }


def test_parse_line_returns_none_on_blank_line():
    assert parse_line("") is None
    assert parse_line("   \n") is None


def test_parse_line_raises_on_invalid_json():
    with pytest.raises(ValueError):
        parse_line("not json")


def test_encode_message_returns_single_line_json_with_trailing_newline():
    out = encode_message({"id": "1", "result": {"ok": True}})
    assert out.endswith("\n")
    assert "\n" not in out[:-1]
    assert json.loads(out) == {"id": "1", "result": {"ok": True}}


def test_response_builds_id_plus_result():
    assert response("abc", {"x": 1}) == {"id": "abc", "result": {"x": 1}}


def test_error_response_builds_id_plus_error():
    err = error_response("abc", code="canceled", message="Transcription canceled")
    assert err == {
        "id": "abc",
        "error": {"code": "canceled", "message": "Transcription canceled"},
    }


def test_notification_has_no_id():
    note = notification("progress", {"job_id": "abc", "processed": 1.0, "total": 10.0})
    assert "id" not in note
    assert note["method"] == "progress"
    assert note["params"]["job_id"] == "abc"
```

- [ ] **Step 2: Run tests — they should fail (no rpc module yet)**

```bash
cd sidecar && uv run pytest tests/test_rpc.py -v
```

Expected: ImportError / ModuleNotFoundError on `shorts_sidecar.rpc`.

- [ ] **Step 3: Implement `sidecar/src/shorts_sidecar/rpc.py`**

```python
"""Line-delimited JSON-RPC protocol helpers (pure, no IO)."""

from __future__ import annotations

import json
from typing import Any


def parse_line(line: str) -> dict[str, Any] | None:
    """Parse one input line into a message dict.

    Returns None for blank lines (so the caller can ignore them).
    Raises ValueError for malformed JSON.
    """
    stripped = line.strip()
    if not stripped:
        return None
    try:
        msg = json.loads(stripped)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON line: {e.msg}") from e
    if not isinstance(msg, dict):
        raise ValueError("Expected a JSON object at the top level")
    return msg


def encode_message(msg: dict[str, Any]) -> str:
    """Serialize a message dict into one JSON line terminated by '\\n'."""
    return json.dumps(msg, ensure_ascii=False) + "\n"


def response(request_id: str, result: Any) -> dict[str, Any]:
    return {"id": request_id, "result": result}


def error_response(request_id: str, code: str, message: str) -> dict[str, Any]:
    return {"id": request_id, "error": {"code": code, "message": message}}


def notification(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Server-initiated notification (no id, so the client ignores any ack semantics)."""
    return {"method": method, "params": params}
```

- [ ] **Step 4: Run tests — should pass 7/7**

```bash
cd sidecar && uv run pytest tests/test_rpc.py -v
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/shorts_sidecar/rpc.py sidecar/tests/__init__.py sidecar/tests/test_rpc.py
git commit -m "feat(m4): add line-JSON RPC helpers with pytest coverage"
```

---

### Task 4: Whisper engine wrapper (TDD with mocked WhisperModel)

**Files:**

- Create: `sidecar/src/shorts_sidecar/whisper_engine.py`
- Create: `sidecar/tests/test_whisper_engine.py`

The engine wraps `faster_whisper.WhisperModel` so tests can substitute a fake. It does NOT do IO or threading — it's a generator-style transcribe with a cancel callback.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_whisper_engine.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import pytest

from shorts_sidecar.whisper_engine import WhisperEngine, TranscribeResult


@dataclass
class FakeWord:
    start: float
    end: float
    word: str


@dataclass
class FakeSegment:
    start: float
    end: float
    text: str
    words: list[FakeWord] | None


@dataclass
class FakeInfo:
    duration: float
    language: str
    language_probability: float


class FakeWhisperModel:
    def __init__(self, model_size: str, **_kwargs):
        self.model_size = model_size
        self.transcribe_args: dict | None = None

    def transcribe(self, audio_path: str, **kwargs) -> tuple[Iterable, FakeInfo]:
        self.transcribe_args = {"audio_path": audio_path, **kwargs}
        segments = [
            FakeSegment(
                start=0.0,
                end=1.5,
                text="Hello",
                words=[FakeWord(0.0, 0.5, "Hello")],
            ),
            FakeSegment(
                start=1.5,
                end=3.0,
                text="world",
                words=[FakeWord(1.5, 2.0, "world")],
            ),
        ]
        return iter(segments), FakeInfo(duration=3.0, language="en", language_probability=0.99)


def test_engine_calls_factory_with_model_name_on_first_use():
    created: list[str] = []

    def factory(model: str, **_kwargs):
        created.append(model)
        return FakeWhisperModel(model)

    engine = WhisperEngine(model_factory=factory)
    list(engine.transcribe("/tmp/a.mp4", model="small"))
    assert created == ["small"]


def test_engine_caches_loaded_models_by_name():
    created: list[str] = []

    def factory(model: str, **_kwargs):
        created.append(model)
        return FakeWhisperModel(model)

    engine = WhisperEngine(model_factory=factory)
    list(engine.transcribe("/tmp/a.mp4", model="small"))
    list(engine.transcribe("/tmp/b.mp4", model="small"))
    list(engine.transcribe("/tmp/c.mp4", model="medium"))
    assert created == ["small", "medium"]


def test_engine_yields_progress_then_final_result():
    def factory(model: str, **_kwargs):
        return FakeWhisperModel(model)

    engine = WhisperEngine(model_factory=factory)
    yields = list(engine.transcribe("/tmp/a.mp4", model="small"))

    # Two progress events (one per segment) + one final TranscribeResult
    assert len(yields) == 3
    assert yields[0].kind == "progress"
    assert yields[0].processed == pytest.approx(1.5)
    assert yields[0].total == pytest.approx(3.0)
    assert yields[1].kind == "progress"
    assert yields[1].processed == pytest.approx(3.0)
    final = yields[2]
    assert isinstance(final, TranscribeResult)
    assert [s["text"] for s in final.segments] == ["Hello", "world"]
    assert [w["text"] for w in final.words] == ["Hello", "world"]


def test_engine_stops_when_cancel_callback_returns_true():
    def factory(model: str, **_kwargs):
        return FakeWhisperModel(model)

    engine = WhisperEngine(model_factory=factory)
    cancelled_after = 1
    seen = []

    def cancel():
        return len(seen) >= cancelled_after

    with pytest.raises(InterruptedError):
        for item in engine.transcribe("/tmp/a.mp4", model="small", is_canceled=cancel):
            seen.append(item)
    # Saw the first progress, then the cancel check fired before the second
    assert len(seen) == 1


def test_engine_passes_word_timestamps_flag():
    factory_calls: list[FakeWhisperModel] = []

    def factory(model: str, **_kwargs):
        m = FakeWhisperModel(model)
        factory_calls.append(m)
        return m

    engine = WhisperEngine(model_factory=factory)
    list(engine.transcribe("/tmp/a.mp4", model="small"))
    assert factory_calls[0].transcribe_args is not None
    assert factory_calls[0].transcribe_args.get("word_timestamps") is True
```

- [ ] **Step 2: Run tests — they should fail**

```bash
cd sidecar && uv run pytest tests/test_whisper_engine.py -v
```

Expected: ImportError on `shorts_sidecar.whisper_engine`.

- [ ] **Step 3: Implement `sidecar/src/shorts_sidecar/whisper_engine.py`**

```python
"""Generator-style wrapper around faster-whisper.WhisperModel."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Protocol


class _ModelLike(Protocol):
    def transcribe(self, audio_path: str, **kwargs: Any) -> tuple[Any, Any]: ...


ModelFactory = Callable[..., _ModelLike]


@dataclass
class TranscribeProgress:
    kind: str = "progress"
    processed: float = 0.0
    total: float = 0.0


@dataclass
class TranscribeResult:
    kind: str = "result"
    segments: list[dict] = field(default_factory=list)
    words: list[dict] = field(default_factory=list)
    language: str = ""
    duration: float = 0.0


def _default_factory(model: str, **kwargs: Any):  # pragma: no cover - integration only
    from faster_whisper import WhisperModel

    return WhisperModel(model, **kwargs)


class WhisperEngine:
    """Loads models lazily on first use, caches by model name.

    `transcribe()` is a generator that yields `TranscribeProgress` per segment
    and finally a `TranscribeResult`. If `is_canceled()` ever returns True,
    raises `InterruptedError` mid-iteration.
    """

    def __init__(self, model_factory: ModelFactory = _default_factory) -> None:
        self._factory = model_factory
        self._cache: dict[str, _ModelLike] = {}

    @property
    def loaded_models(self) -> list[str]:
        return list(self._cache.keys())

    def _get(self, model: str) -> _ModelLike:
        if model not in self._cache:
            self._cache[model] = self._factory(model)
        return self._cache[model]

    def transcribe(
        self,
        audio_path: str,
        *,
        model: str,
        language: str | None = None,
        is_canceled: Callable[[], bool] | None = None,
    ) -> Iterator[TranscribeProgress | TranscribeResult]:
        whisper = self._get(model)
        kwargs: dict[str, Any] = {"word_timestamps": True}
        if language and language != "auto":
            kwargs["language"] = language

        segments_iter, info = whisper.transcribe(audio_path, **kwargs)
        total = float(getattr(info, "duration", 0.0))

        out_segments: list[dict] = []
        out_words: list[dict] = []
        for seg in segments_iter:
            if is_canceled and is_canceled():
                raise InterruptedError("transcription canceled")
            out_segments.append({"start": float(seg.start), "end": float(seg.end), "text": seg.text})
            for w in seg.words or []:
                out_words.append({"start": float(w.start), "end": float(w.end), "text": w.word})
            yield TranscribeProgress(processed=float(seg.end), total=total)

        yield TranscribeResult(
            segments=out_segments,
            words=out_words,
            language=getattr(info, "language", "") or "",
            duration=total,
        )
```

- [ ] **Step 4: Run tests — should pass 5/5**

```bash
cd sidecar && uv run pytest tests/test_whisper_engine.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/shorts_sidecar/whisper_engine.py sidecar/tests/test_whisper_engine.py
git commit -m "feat(m4): add WhisperEngine generator-style wrapper with cancel"
```

---

### Task 5: Server (dispatcher with worker thread + cancel) — TDD

**Files:**

- Create: `sidecar/src/shorts_sidecar/server.py`
- Create: `sidecar/tests/test_server.py`

`Server` ties RPC + WhisperEngine together. It owns:

- Inbound queue (filled by stdin reader in `__main__`)
- Outbound queue (drained by stdout writer in `__main__`)
- Worker thread that runs the current transcribe job
- A `threading.Event` that signals cancel

Tests use a fake engine to avoid real model loads.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_server.py`:

```python
from __future__ import annotations

import threading
import time
from queue import Queue, Empty

import pytest

from shorts_sidecar.server import Server
from shorts_sidecar.whisper_engine import TranscribeProgress, TranscribeResult


class StubEngine:
    """Replays a fixed yield sequence; observes cancel via callback."""

    def __init__(self, sequence):
        self._sequence = sequence
        self.last_args: dict | None = None

    @property
    def loaded_models(self):
        return ["stub"]

    def transcribe(self, audio_path, *, model, language=None, is_canceled=None):
        self.last_args = {"audio_path": audio_path, "model": model, "language": language}
        for item in self._sequence:
            if is_canceled and is_canceled():
                raise InterruptedError
            yield item


def _run_server_with(messages):
    inbound: Queue = Queue()
    outbound: Queue = Queue()
    for m in messages:
        inbound.put(m)
    inbound.put(None)  # sentinel: shut down after these
    return inbound, outbound


def _drain(outbound: Queue, timeout: float = 1.0) -> list[dict]:
    out: list[dict] = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            out.append(outbound.get(timeout=0.05))
        except Empty:
            if not out:
                continue
            break
    return out


def test_health_returns_ok_with_loaded_models_list():
    inbound, outbound = _run_server_with([{"id": "1", "method": "health"}])
    server = Server(engine=StubEngine([]))
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    assert any(m == {"id": "1", "result": {"ok": True, "modelsLoaded": ["stub"]}} for m in msgs)


def test_transcribe_emits_progress_then_final_result():
    seq = [
        TranscribeProgress(processed=1.0, total=4.0),
        TranscribeProgress(processed=4.0, total=4.0),
        TranscribeResult(segments=[{"start": 0.0, "end": 4.0, "text": "hi"}], words=[], duration=4.0, language="en"),
    ]
    inbound, outbound = _run_server_with([
        {"id": "abc", "method": "transcribe", "params": {"audio_path": "/x.mp4", "model": "small"}}
    ])
    server = Server(engine=StubEngine(seq))
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    progress_msgs = [m for m in msgs if m.get("method") == "progress"]
    final = [m for m in msgs if m.get("id") == "abc" and "result" in m]
    assert len(progress_msgs) == 2
    assert progress_msgs[0]["params"] == {"jobId": "abc", "processed": 1.0, "total": 4.0}
    assert len(final) == 1
    assert final[0]["result"]["segments"][0]["text"] == "hi"


def test_cancel_during_transcribe_emits_canceled_error():
    # Stub yields one progress then sleeps; cancel arrives mid-iteration.
    class SlowEngine:
        loaded_models = []

        def transcribe(self, audio_path, *, model, language=None, is_canceled=None):
            yield TranscribeProgress(processed=1.0, total=10.0)
            for _ in range(50):
                if is_canceled and is_canceled():
                    raise InterruptedError
                time.sleep(0.01)
            yield TranscribeResult(segments=[], words=[], duration=10.0, language="en")

    inbound: Queue = Queue()
    outbound: Queue = Queue()
    inbound.put({"id": "abc", "method": "transcribe", "params": {"audio_path": "/x.mp4", "model": "small"}})

    server = Server(engine=SlowEngine())
    server_thread = threading.Thread(target=server.run, args=(inbound, outbound), daemon=True)
    server_thread.start()

    # Wait for the first progress event to confirm transcribe is running.
    deadline = time.monotonic() + 1.0
    saw_progress = False
    while time.monotonic() < deadline and not saw_progress:
        try:
            msg = outbound.get(timeout=0.05)
            if msg.get("method") == "progress":
                saw_progress = True
            else:
                outbound.put(msg)  # not the one we wanted; put back
                break
        except Empty:
            continue
    assert saw_progress

    inbound.put({"id": "cancel-1", "method": "cancel", "params": {"jobId": "abc"}})
    inbound.put(None)
    server_thread.join(timeout=2.0)
    assert not server_thread.is_alive()

    msgs = _drain(outbound, timeout=0.3)
    cancel_resp = [m for m in msgs if m.get("id") == "abc" and "error" in m]
    assert cancel_resp and cancel_resp[0]["error"]["code"] == "canceled"


def test_unknown_method_returns_error():
    inbound, outbound = _run_server_with([{"id": "1", "method": "nope"}])
    server = Server(engine=StubEngine([]))
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    err = [m for m in msgs if m.get("id") == "1" and "error" in m]
    assert err and err[0]["error"]["code"] == "unknown_method"
```

- [ ] **Step 2: Run tests — they should fail**

```bash
cd sidecar && uv run pytest tests/test_server.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement `sidecar/src/shorts_sidecar/server.py`**

```python
"""Dispatcher: pulls messages from `inbound`, services them, pushes results to `outbound`.

Transcribe runs on a worker thread so cancel/health requests can be handled
while a transcription is in progress.
"""

from __future__ import annotations

import threading
import traceback
from dataclasses import asdict
from queue import Queue, Empty
from typing import Any

from .whisper_engine import TranscribeProgress, TranscribeResult, WhisperEngine


class Server:
    def __init__(self, engine: Any | None = None) -> None:
        self._engine = engine if engine is not None else WhisperEngine()
        self._cancel_event = threading.Event()
        self._active_job_id: str | None = None
        self._worker: threading.Thread | None = None
        self._lock = threading.Lock()

    # Public entry: drain `inbound`, push outputs to `outbound`. Returns when
    # a sentinel `None` is received from `inbound`.
    def run(self, inbound: Queue, outbound: Queue) -> None:
        while True:
            msg = inbound.get()
            if msg is None:
                # Wait for any in-flight job to finish/cancel before exiting.
                self._cancel_event.set()
                if self._worker is not None:
                    self._worker.join(timeout=2.0)
                return
            self._dispatch(msg, outbound)

    # --- private ----------------------------------------------------------

    def _dispatch(self, msg: dict, outbound: Queue) -> None:
        method = msg.get("method")
        if method == "health":
            outbound.put(
                {
                    "id": msg.get("id"),
                    "result": {"ok": True, "modelsLoaded": self._engine.loaded_models},
                }
            )
            return
        if method == "transcribe":
            self._start_transcribe(msg, outbound)
            return
        if method == "cancel":
            with self._lock:
                target = (msg.get("params") or {}).get("jobId") or self._active_job_id
                if target and target == self._active_job_id:
                    self._cancel_event.set()
            return
        # Unknown method
        outbound.put(
            {
                "id": msg.get("id"),
                "error": {"code": "unknown_method", "message": f"unknown method: {method!r}"},
            }
        )

    def _start_transcribe(self, msg: dict, outbound: Queue) -> None:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                outbound.put(
                    {
                        "id": msg.get("id"),
                        "error": {"code": "busy", "message": "another transcribe job is in progress"},
                    }
                )
                return
            job_id = str(msg.get("id"))
            self._active_job_id = job_id
            self._cancel_event.clear()
            self._worker = threading.Thread(
                target=self._run_transcribe,
                args=(job_id, msg.get("params") or {}, outbound),
                daemon=True,
            )
            self._worker.start()

    def _run_transcribe(self, job_id: str, params: dict, outbound: Queue) -> None:
        try:
            stream = self._engine.transcribe(
                params.get("audio_path"),
                model=params.get("model", "small"),
                language=params.get("language"),
                is_canceled=self._cancel_event.is_set,
            )
            for item in stream:
                if isinstance(item, TranscribeProgress):
                    outbound.put(
                        {
                            "method": "progress",
                            "params": {
                                "jobId": job_id,
                                "processed": item.processed,
                                "total": item.total,
                            },
                        }
                    )
                elif isinstance(item, TranscribeResult):
                    payload = asdict(item)
                    payload.pop("kind", None)
                    outbound.put({"id": job_id, "result": payload})
        except InterruptedError:
            outbound.put(
                {
                    "id": job_id,
                    "error": {"code": "canceled", "message": "Transcription canceled"},
                }
            )
        except Exception as e:
            outbound.put(
                {
                    "id": job_id,
                    "error": {
                        "code": "transcribe_failed",
                        "message": f"{type(e).__name__}: {e}\n{traceback.format_exc()}",
                    },
                }
            )
        finally:
            with self._lock:
                if self._active_job_id == job_id:
                    self._active_job_id = None
```

- [ ] **Step 4: Run tests — should pass 4/4**

```bash
cd sidecar && uv run pytest tests/test_server.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/shorts_sidecar/server.py sidecar/tests/test_server.py
git commit -m "feat(m4): add Server dispatcher with cancellable transcribe worker"
```

---

### Task 6: Sidecar entrypoint (`__main__.py`)

**Files:**

- Create: `sidecar/src/shorts_sidecar/__main__.py`

The entrypoint wires stdin → inbound queue, outbound queue → stdout, and runs the Server. We test it via a smoke command rather than unit tests because it involves real stdio.

- [ ] **Step 1: Implement the entrypoint**

```python
"""Entrypoint: `python -m shorts_sidecar` — line-JSON over stdio."""

from __future__ import annotations

import sys
import threading
from queue import Queue

from .rpc import encode_message, parse_line
from .server import Server


def _stdin_reader(inbound: Queue) -> None:
    for raw in sys.stdin:
        try:
            msg = parse_line(raw)
        except ValueError:
            continue
        if msg is None:
            continue
        inbound.put(msg)
    inbound.put(None)  # EOF → shutdown


def _stdout_writer(outbound: Queue) -> None:
    while True:
        msg = outbound.get()
        if msg is None:
            return
        sys.stdout.write(encode_message(msg))
        sys.stdout.flush()


def main() -> int:
    inbound: Queue = Queue()
    outbound: Queue = Queue()

    reader = threading.Thread(target=_stdin_reader, args=(inbound,), daemon=True)
    writer = threading.Thread(target=_stdout_writer, args=(outbound,), daemon=True)
    reader.start()
    writer.start()

    server = Server()
    server.run(inbound, outbound)

    outbound.put(None)
    writer.join(timeout=1.0)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
```

- [ ] **Step 2: Smoke-test the entrypoint manually**

```bash
cd sidecar
echo '{"id":"1","method":"health"}' | uv run python -m shorts_sidecar
```

Expected output (one line):

```json
{ "id": "1", "result": { "ok": true, "modelsLoaded": [] } }
```

If you see anything else (Python traceback, no output, multiple lines), STOP and report.

- [ ] **Step 3: Run the full pytest suite**

```bash
cd sidecar && uv run pytest -v
```

Expected: 16 tests pass (7 rpc + 5 whisper_engine + 4 server). Some warnings from pytest-asyncio are OK if any.

- [ ] **Step 4: Commit**

```bash
git add sidecar/src/shorts_sidecar/__main__.py
git commit -m "feat(m4): add sidecar entrypoint with stdin reader and stdout writer threads"
```

---

### Task 7: Shared Transcript types (zod schemas)

**Files:**

- Create: `src/shared/transcript.ts`
- Create: `src/shared/transcribe.ts`

- [ ] **Step 1: Create `src/shared/transcript.ts`**

```ts
import { z } from 'zod';

export const SegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const WordSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type Word = z.infer<typeof WordSchema>;

export const TranscriptSchema = z.object({
  /** Total audio duration in seconds (from yt-dlp/whisper). */
  duration: z.number().nonnegative(),
  /** Detected or specified language (BCP47 / ISO 639). May be empty. */
  language: z.string(),
  segments: z.array(SegmentSchema),
  words: z.array(WordSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
```

- [ ] **Step 2: Create `src/shared/transcribe.ts`**

```ts
import { z } from 'zod';

export const TranscribeProgressSchema = z.object({
  jobId: z.string().min(1),
  /** Seconds of audio processed so far. */
  processed: z.number().nonnegative(),
  /** Total duration in seconds. May be 0 if unknown. */
  total: z.number().nonnegative(),
});
export type TranscribeProgress = z.infer<typeof TranscribeProgressSchema>;

export type TranscribeStatus = 'idle' | 'starting' | 'transcribing' | 'done' | 'canceled' | 'error';
```

- [ ] **Step 3: Format + verify**

```bash
yarn prettier --write src/shared/transcript.ts src/shared/transcribe.ts
yarn lint && yarn typecheck
```

Expected: lint exits 0 (1 known `__dirname` warning); typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/shared/transcript.ts src/shared/transcribe.ts
git commit -m "feat(m4): add shared Transcript and TranscribeProgress schemas"
```

---

### Task 8: IPC contract extension

**Files:**

- Modify: `src/shared/ipc.ts`

- [ ] **Step 1: Replace `src/shared/ipc.ts` entirely**

```ts
import type { Settings } from './settings';
import type { TranscribeProgress } from './transcribe';
import type { Transcript } from './transcript';
import type { DownloadProgress, VideoMeta } from './youtube';

export interface AppApi {
  getAppVersion(): Promise<string>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;

  hasApiKey(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;

  pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null>;

  fetchVideoPreview(url: string): Promise<VideoMeta>;
  downloadVideo(url: string): Promise<{ outputPath: string }>;
  cancelDownload(): Promise<void>;
  onDownloadProgress(callback: (p: DownloadProgress) => void): () => void;

  /** Transcribe an existing audio/video file via the Python sidecar. */
  transcribeFile(audioPath: string): Promise<{ transcriptPath: string; transcript: Transcript }>;
  /** Cancel the active transcription (no-op if none). */
  cancelTranscribe(): Promise<void>;
  /** Subscribe to transcribe progress notifications. Returns unsubscribe. */
  onTranscribeProgress(callback: (p: TranscribeProgress) => void): () => void;
  /** Health-check the Python sidecar (will boot it lazily if needed). */
  sidecarHealth(): Promise<{ ok: boolean; modelsLoaded: string[] }>;

  revealInFolder(absolutePath: string): Promise<void>;
  /** Open a file with the OS default app (e.g., transcript.json → text editor). */
  openPath(absolutePath: string): Promise<void>;
}

declare global {
  interface Window {
    api: AppApi;
  }
}

export {};
```

- [ ] **Step 2: Format + typecheck only (lint will fail until preload is updated)**

```bash
yarn prettier --write src/shared/ipc.ts
yarn typecheck
```

Expected: typecheck exits 0. (`yarn lint` will fail until Task 11/12; skip for now.)

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc.ts
git commit -m "feat(m4): extend AppApi with transcribe/cancelTranscribe/onTranscribeProgress/sidecarHealth/openPath"
```

---

### Task 9: PythonSidecar (Node — process + RPC client) — TDD

**Files:**

- Create: `src/main/infra/PythonSidecar.ts`
- Create: `src/main/infra/PythonSidecar.test.ts`

`PythonSidecar` spawns the Python process, sends one-line JSON requests, and routes responses back to the right callers via request id correlation. It also dispatches `progress` notifications to a single subscriber.

- [ ] **Step 1: Write the failing tests**

Create `src/main/infra/PythonSidecar.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PythonSidecar } from './PythonSidecar';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', signal === 'SIGTERM' ? null : 0));
    return true;
  }
}

describe('PythonSidecar', () => {
  let spawn: ReturnType<typeof vi.fn>;
  let child: FakeChild;
  let sidecar: PythonSidecar;

  beforeEach(() => {
    child = new FakeChild();
    spawn = vi.fn(() => child);
    sidecar = new PythonSidecar({
      spawn: spawn as never,
      command: 'uv',
      args: ['run', 'python', '-m', 'shorts_sidecar'],
      cwd: '/tmp/sidecar',
      env: { HF_HOME: '/tmp/models' },
    });
  });

  afterEach(() => {
    sidecar.shutdown();
  });

  it('does not spawn until the first request', () => {
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns with configured command, args, cwd, and env on first request', async () => {
    const req = sidecar.request<{ ok: boolean }>('health');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0]!;
    expect(cmd).toBe('uv');
    expect(args).toEqual(['run', 'python', '-m', 'shorts_sidecar']);
    expect(opts.cwd).toBe('/tmp/sidecar');
    expect(opts.env).toMatchObject({ HF_HOME: '/tmp/models' });
    // Drive the response so the test can complete
    const sent = (child.stdin as PassThrough).read()?.toString() ?? '';
    const id = JSON.parse(sent.trim()).id;
    child.stdout.write(JSON.stringify({ id, result: { ok: true } }) + '\n');
    await expect(req).resolves.toEqual({ ok: true });
  });

  it('correlates concurrent requests by id', async () => {
    const a = sidecar.request<string>('health');
    const b = sidecar.request<string>('health');
    // Two writes → two ids
    const written = (child.stdin as PassThrough).read()!.toString().trim().split('\n');
    const idA = JSON.parse(written[0]!).id;
    const idB = JSON.parse(written[1]!).id;
    expect(idA).not.toEqual(idB);
    // Reply out of order
    child.stdout.write(JSON.stringify({ id: idB, result: 'B' }) + '\n');
    child.stdout.write(JSON.stringify({ id: idA, result: 'A' }) + '\n');
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('rejects when the response carries an error', async () => {
    const req = sidecar.request<unknown>('transcribe');
    const sent = (child.stdin as PassThrough).read()!.toString();
    const id = JSON.parse(sent.trim()).id;
    child.stdout.write(JSON.stringify({ id, error: { code: 'busy', message: 'try later' } }) + '\n');
    await expect(req).rejects.toMatchObject({ message: expect.stringContaining('busy') });
  });

  it('routes progress notifications to the subscriber', async () => {
    const events: unknown[] = [];
    sidecar.onProgress((p) => events.push(p));
    void sidecar.request<unknown>('transcribe', { audio_path: '/x' });
    (child.stdin as PassThrough).read(); // discard
    child.stdout.write(
      JSON.stringify({
        method: 'progress',
        params: { jobId: 'abc', processed: 1.5, total: 4.0 },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([{ jobId: 'abc', processed: 1.5, total: 4.0 }]);
  });

  it('handles the child exiting unexpectedly by failing in-flight requests and respawning on next call', async () => {
    const a = sidecar.request<unknown>('health');
    (child.stdin as PassThrough).read();
    child.emit('exit', 1);
    await expect(a).rejects.toThrow(/sidecar exited/i);

    // Next request must respawn
    const b = sidecar.request<unknown>('health');
    expect(spawn).toHaveBeenCalledTimes(2);
    void b.catch(() => undefined); // we don't drive a response, just confirm respawn
  });

  it('shutdown() sends EOF and waits for exit', async () => {
    sidecar.request<unknown>('health').catch(() => undefined);
    (child.stdin as PassThrough).read();
    sidecar.shutdown();
    // Either stdin was ended or the process killed — both observable
    await new Promise((r) => setTimeout(r, 0));
    expect(child.killed || (child.stdin as PassThrough).writableEnded).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — should fail (no PythonSidecar module yet)**

```bash
yarn test src/main/infra/PythonSidecar.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement `src/main/infra/PythonSidecar.ts`**

```ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

export interface PythonSidecarOptions {
  spawn: SpawnLike;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface ProgressMessage {
  jobId: string;
  processed: number;
  total: number;
}

type ProgressHandler = (p: ProgressMessage) => void;

/**
 * Spawns the Python sidecar lazily on first `request()`. Owns id-correlation
 * and progress dispatch. If the child exits, in-flight requests reject and
 * the next call respawns it.
 */
export class PythonSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private progressHandlers: ProgressHandler[] = [];

  constructor(private readonly opts: PythonSidecarOptions) {}

  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.push(handler);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((h) => h !== handler);
    };
  }

  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const child = this.ensureSpawned();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      child.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
    });
  }

  /**
   * Sends a notification (no id, no response). Used for cancel which we treat
   * as fire-and-forget — the in-flight transcribe request rejects with a
   * 'canceled' error from the sidecar instead.
   */
  notify(method: string, params?: Record<string, unknown>): void {
    const child = this.ensureSpawned();
    child.stdin.write(JSON.stringify({ method, params: params ?? {} }) + '\n');
  }

  shutdown(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    this.child = null;
    this.failAllPending(new Error('sidecar shutting down'));
  }

  private ensureSpawned(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = this.opts.spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      // Forward sidecar logs to our stderr for diagnostics.
      process.stderr.write(`[sidecar] ${chunk}`);
    });

    child.on('exit', (code) => {
      this.child = null;
      const err = new Error(`sidecar exited with code ${code}`);
      this.failAllPending(err);
    });

    child.on('error', (err) => {
      this.child = null;
      this.failAllPending(err);
    });

    return child;
  }

  private handleLine(line: string): void {
    let msg: { id?: string; method?: string; result?: unknown; error?: { message?: string }; params?: ProgressMessage };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === 'progress' && msg.params) {
      for (const h of this.progressHandlers) h(msg.params);
      return;
    }
    if (typeof msg.id === 'string') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? 'sidecar error'));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run tests — should pass 7/7**

```bash
yarn test src/main/infra/PythonSidecar.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Format + lint check on the new files**

```bash
yarn prettier --write src/main/infra/PythonSidecar.ts src/main/infra/PythonSidecar.test.ts
```

(Lint full repo will still warn until Tasks 11–12 land. Don't run `yarn lint` here.)

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/PythonSidecar.ts src/main/infra/PythonSidecar.test.ts
git commit -m "feat(m4): add PythonSidecar with id correlation and progress dispatch"
```

---

### Task 10: TranscribeService (orchestrator) — TDD

**Files:**

- Create: `src/main/services/TranscribeService.ts`
- Create: `src/main/services/TranscribeService.test.ts`

`TranscribeService` calls `PythonSidecar.request('transcribe', ...)`, validates the result against `TranscriptSchema`, and lets the caller subscribe to progress.

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/TranscribeService.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscribeService } from './TranscribeService';

const validRaw = {
  duration: 4.0,
  language: 'en',
  segments: [{ start: 0.0, end: 4.0, text: 'hi' }],
  words: [{ start: 0.0, end: 0.5, text: 'hi' }],
};

describe('TranscribeService', () => {
  let request: ReturnType<typeof vi.fn>;
  let onProgress: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let sidecar: { request: typeof request; notify: typeof notify; onProgress: typeof onProgress };
  let service: TranscribeService;

  beforeEach(() => {
    request = vi.fn();
    notify = vi.fn();
    onProgress = vi.fn(() => () => undefined);
    sidecar = { request, notify, onProgress };
    service = new TranscribeService(sidecar as never);
  });

  it('calls sidecar.request with the right method and params', async () => {
    request.mockResolvedValue(validRaw);
    const result = await service.transcribe('/tmp/a.mp4', { model: 'small', language: 'auto' });
    expect(request).toHaveBeenCalledWith('transcribe', {
      audio_path: '/tmp/a.mp4',
      model: 'small',
      language: 'auto',
    });
    expect(result.duration).toBe(4.0);
    expect(result.segments[0].text).toBe('hi');
  });

  it('rejects malformed sidecar payloads via the schema', async () => {
    request.mockResolvedValue({ duration: 'not a number' });
    await expect(service.transcribe('/x', { model: 'small' })).rejects.toThrow();
  });

  it('subscribes to sidecar progress and forwards it to the caller', async () => {
    request.mockResolvedValue(validRaw);
    const events: unknown[] = [];
    const unsub = service.onProgress((p) => events.push(p));
    expect(onProgress).toHaveBeenCalled();
    const sidecarHandler = onProgress.mock.calls[0]![0] as (p: unknown) => void;
    sidecarHandler({ jobId: 'x', processed: 1.0, total: 4.0 });
    expect(events).toEqual([{ jobId: 'x', processed: 1.0, total: 4.0 }]);
    unsub();
  });

  it('cancel() sends a cancel notification', async () => {
    await service.cancel();
    expect(notify).toHaveBeenCalledWith('cancel', {});
  });

  it('health() proxies to sidecar.request', async () => {
    request.mockResolvedValue({ ok: true, modelsLoaded: ['small'] });
    await expect(service.health()).resolves.toEqual({ ok: true, modelsLoaded: ['small'] });
    expect(request).toHaveBeenCalledWith('health');
  });
});
```

- [ ] **Step 2: Run tests — should fail**

```bash
yarn test src/main/services/TranscribeService.test.ts
```

- [ ] **Step 3: Implement `src/main/services/TranscribeService.ts`**

```ts
import type { TranscribeProgress } from '@shared/transcribe';
import { type Transcript, TranscriptSchema } from '@shared/transcript';

interface SidecarLike {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  onProgress(handler: (p: TranscribeProgress) => void): () => void;
}

export interface TranscribeOptions {
  model: string;
  language?: string;
}

export class TranscribeService {
  constructor(private readonly sidecar: SidecarLike) {}

  async transcribe(audioPath: string, opts: TranscribeOptions): Promise<Transcript> {
    const raw = await this.sidecar.request<unknown>('transcribe', {
      audio_path: audioPath,
      model: opts.model,
      language: opts.language ?? 'auto',
    });
    return TranscriptSchema.parse(raw);
  }

  async cancel(): Promise<void> {
    this.sidecar.notify('cancel', {});
  }

  async health(): Promise<{ ok: boolean; modelsLoaded: string[] }> {
    return this.sidecar.request<{ ok: boolean; modelsLoaded: string[] }>('health');
  }

  onProgress(handler: (p: TranscribeProgress) => void): () => void {
    return this.sidecar.onProgress(handler);
  }
}
```

- [ ] **Step 4: Run tests — should pass 5/5**

```bash
yarn test src/main/services/TranscribeService.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/TranscribeService.ts src/main/services/TranscribeService.test.ts
git add src/main/services/TranscribeService.ts src/main/services/TranscribeService.test.ts
git commit -m "feat(m4): add TranscribeService thin facade over PythonSidecar"
```

---

### Task 11: Wire IPC handlers in main.ts (transcribe + sidecar lifecycle + transcript persistence)

**Files:**

- Modify: `src/main/main.ts`

The handler:

1. Resolves the sidecar's working directory (`<repo>/sidecar` in dev, packaged path in prod — for M4 we only handle dev).
2. Reads current settings to pick the Whisper model + language.
3. Calls `transcribeService.transcribe(audioPath, ...)`.
4. Writes the result to `<audioPath>.transcript.json` (i.e., `Me at the zoo.webm.transcript.json`).
5. Returns `{ transcriptPath, transcript }`.

Progress events bubble from the service to the renderer via `webContents.send('transcribe:progress', ...)`.

- [ ] **Step 1: Add imports + sidecar/service init**

Edit `src/main/main.ts`. Near the existing imports, add:

```ts
import { writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

import { PythonSidecar } from './infra/PythonSidecar';
import { TranscribeService } from './services/TranscribeService';
```

Also add `dirname` and `resolvePath` to the `node:path` import if not already imported there (the file already imports `join`).

After the existing module-level lets (e.g. `let activeDownload`), add:

```ts
let pythonSidecar: PythonSidecar | null = null;
let transcribeService: TranscribeService | null = null;
let transcribeProgressUnsub: (() => void) | null = null;
```

- [ ] **Step 2: Helper to lazily build the sidecar**

Inside the same file (above `app.whenReady()`), add:

```ts
function getTranscribeService(): TranscribeService {
  if (transcribeService) return transcribeService;
  const repoRoot = resolvePath(__dirname, '../../');
  const modelsDir = join(app.getPath('userData'), 'whisper-models');
  pythonSidecar = new PythonSidecar({
    spawn,
    command: 'uv',
    args: ['run', 'python', '-m', 'shorts_sidecar'],
    cwd: join(repoRoot, 'sidecar'),
    env: { HF_HOME: modelsDir },
  });
  transcribeService = new TranscribeService(pythonSidecar);

  transcribeProgressUnsub = pythonSidecar.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('transcribe:progress', p);
    }
  });

  return transcribeService;
}
```

- [ ] **Step 3: Register the IPC handlers in `app.whenReady().then(...)`**

Add these AFTER the existing youtube/shell handlers, BEFORE `createMainWindow()`:

```ts
ipcMain.handle('transcribe:run', async (_e, audioPath: string) => {
  const service = getTranscribeService();
  const settings = settingsStore.get();
  const transcript = await service.transcribe(audioPath, {
    model: settings.whisper.model,
    language: settings.whisper.language,
  });
  const transcriptPath = `${audioPath}.transcript.json`;
  await writeFile(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');
  return { transcriptPath, transcript };
});

ipcMain.handle('transcribe:cancel', async () => {
  if (transcribeService) await transcribeService.cancel();
});

ipcMain.handle('sidecar:health', async () => {
  const service = getTranscribeService();
  return service.health();
});

ipcMain.handle('shell:openPath', async (_e, absolutePath: string) => {
  await shell.openPath(absolutePath);
});
```

- [ ] **Step 4: Cleanup on app quit**

Inside the existing `app.on('window-all-closed', ...)` block, BEFORE `app.quit()`, add:

```ts
transcribeProgressUnsub?.();
transcribeProgressUnsub = null;
pythonSidecar?.shutdown();
pythonSidecar = null;
transcribeService = null;
```

(If the existing block is just `if (process.platform !== 'darwin') app.quit();`, restructure it to:)

```ts
app.on('window-all-closed', () => {
  transcribeProgressUnsub?.();
  transcribeProgressUnsub = null;
  pythonSidecar?.shutdown();
  pythonSidecar = null;
  transcribeService = null;
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 5: Format + verify**

```bash
yarn prettier --write src/main/main.ts
yarn typecheck
```

Lint will still fail until preload is updated in Task 12. Skip lint here.

- [ ] **Step 6: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(m4): wire transcribe IPC + sidecar lifecycle + transcript persistence in main"
```

---

### Task 12: Update preload bridge

**Files:**

- Modify: `src/main/preload.ts`

- [ ] **Step 1: Replace the file content entirely**

```ts
import type { AppApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import type { TranscribeProgress } from '@shared/transcribe';
import type { DownloadProgress } from '@shared/youtube';
import { contextBridge, ipcRenderer } from 'electron';

const api: AppApi = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  hasApiKey: () => ipcRenderer.invoke('secure:hasKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('secure:setKey', key),
  clearApiKey: () => ipcRenderer.invoke('secure:clearKey'),

  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),

  fetchVideoPreview: (url: string) => ipcRenderer.invoke('youtube:fetchPreview', url),
  downloadVideo: (url: string) => ipcRenderer.invoke('youtube:download', url),
  cancelDownload: () => ipcRenderer.invoke('youtube:cancel'),
  onDownloadProgress: (callback: (p: DownloadProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: DownloadProgress) => callback(data);
    ipcRenderer.on('download:progress', handler);
    return () => {
      ipcRenderer.off('download:progress', handler);
    };
  },

  transcribeFile: (audioPath: string) => ipcRenderer.invoke('transcribe:run', audioPath),
  cancelTranscribe: () => ipcRenderer.invoke('transcribe:cancel'),
  onTranscribeProgress: (callback: (p: TranscribeProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: TranscribeProgress) => callback(data);
    ipcRenderer.on('transcribe:progress', handler);
    return () => {
      ipcRenderer.off('transcribe:progress', handler);
    };
  },
  sidecarHealth: () => ipcRenderer.invoke('sidecar:health'),

  revealInFolder: (absolutePath: string) => ipcRenderer.invoke('shell:reveal', absolutePath),
  openPath: (absolutePath: string) => ipcRenderer.invoke('shell:openPath', absolutePath),
};

contextBridge.exposeInMainWorld('api', api);
```

- [ ] **Step 2: Format + run full verification**

```bash
yarn prettier --write src/main/preload.ts
yarn lint && yarn typecheck && yarn test
```

Expected: lint exits 0 (1 known `__dirname` warning); typecheck exits 0. Tests will fail because `App.test.tsx` and `Settings.test.tsx` and `NewJob.test.tsx` stubs lack the new methods. The next step fixes that.

- [ ] **Step 3: Update existing test stubs to include the new methods**

In `tests/renderer/App.test.tsx`, find the `beforeAll` that installs `window.api`. Add these 5 properties to the api object:

```ts
transcribeFile: vi.fn(async () => ({ transcriptPath: '/tmp/x.transcript.json', transcript: { duration: 0, language: '', segments: [], words: [] } })),
cancelTranscribe: vi.fn(async () => undefined),
onTranscribeProgress: vi.fn(() => () => undefined),
sidecarHealth: vi.fn(async () => ({ ok: true, modelsLoaded: [] })),
openPath: vi.fn(async () => undefined),
```

In `tests/renderer/Settings.test.tsx`, find `installApiMock` and add the same 5 properties to its `api` object literal.

In `tests/renderer/NewJob.test.tsx`, find `installApiMock` and add the same 5 properties to its `api` object literal.

- [ ] **Step 4: Run tests — all should pass**

```bash
yarn test
```

Expected: 58 tests pass (15 from M2 + 17+9+3 from M3 = 44 + 0 new tests yet from M4 — Task 16 adds the smoke test).

Wait — the M3 plan reported 58 tests passing at end of M3. So this should still be 58. If your repo has a different count, just confirm "no regressions, all green".

- [ ] **Step 5: Commit**

```bash
git add src/main/preload.ts tests/renderer/App.test.tsx tests/renderer/Settings.test.tsx tests/renderer/NewJob.test.tsx
git commit -m "feat(m4): expose transcribe/health/openPath on window.api and update test stubs"
```

---

### Task 13: useTranscribe hook

**Files:**

- Create: `src/renderer/hooks/useTranscribe.ts`

- [ ] **Step 1: Create the file**

```ts
import { useCallback, useEffect, useState } from 'react';

import type { TranscribeProgress, TranscribeStatus } from '@shared/transcribe';
import type { Transcript } from '@shared/transcript';

export type TranscribeState =
  | { status: 'idle' }
  | { status: 'starting'; audioPath: string }
  | { status: 'transcribing'; audioPath: string; progress: TranscribeProgress }
  | { status: 'done'; audioPath: string; transcriptPath: string; transcript: Transcript }
  | { status: 'canceled'; audioPath: string }
  | { status: 'error'; audioPath: string; error: Error };

export type UseTranscribe = {
  state: TranscribeState;
  status: TranscribeStatus;
  start: (audioPath: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
};

export function useTranscribe(): UseTranscribe {
  const [state, setState] = useState<TranscribeState>({ status: 'idle' });

  useEffect(() => {
    const unsubscribe = window.api.onTranscribeProgress((p) => {
      setState((current) => {
        if (current.status === 'starting' || current.status === 'transcribing') {
          return { status: 'transcribing', audioPath: current.audioPath, progress: p };
        }
        return current;
      });
    });
    return unsubscribe;
  }, []);

  const start = useCallback(async (audioPath: string) => {
    setState({ status: 'starting', audioPath });
    try {
      const { transcriptPath, transcript } = await window.api.transcribeFile(audioPath);
      setState({ status: 'done', audioPath, transcriptPath, transcript });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (/canceled/i.test(message)) {
        setState({ status: 'canceled', audioPath });
      } else {
        setState({
          status: 'error',
          audioPath,
          error: e instanceof Error ? e : new Error(message),
        });
      }
    }
  }, []);

  const cancel = useCallback(async () => {
    await window.api.cancelTranscribe();
  }, []);

  const reset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return { state, status: state.status, start, cancel, reset };
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/hooks/useTranscribe.ts
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useTranscribe.ts
git commit -m "feat(m4): add useTranscribe hook with progress subscription"
```

---

### Task 14: TranscribeCard component

**Files:**

- Create: `src/renderer/components/newjob/TranscribeCard.tsx`

Renders five visual states matching `TranscribeState`. Uses Tailwind tokens consistent with `DownloadProgress`.

- [ ] **Step 1: Create the file**

```tsx
import type { TranscribeProgress as Progress } from '@shared/transcribe';
import type { Transcript } from '@shared/transcript';

function formatPercent(p: Progress): string {
  if (p.total <= 0) return '...';
  const pct = (p.processed / p.total) * 100;
  return `${pct.toFixed(1)}%`;
}

type Props =
  | { status: 'idle'; onStart: () => void }
  | { status: 'starting' }
  | { status: 'transcribing'; progress: Progress; onCancel: () => void }
  | {
      status: 'done';
      transcriptPath: string;
      transcript: Transcript;
      onOpen: () => void;
      onReset: () => void;
    }
  | { status: 'canceled'; onReset: () => void }
  | { status: 'error'; error: Error; onReset: () => void };

export function TranscribeCard(props: Props) {
  return (
    <section className="border-hairline bg-canvas p-xxl shadow-1 rounded-xl border">
      {props.status === 'idle' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">전사</h3>
          <p className="text-body-sm text-slate">
            다운로드된 영상의 음성을 텍스트로 변환합니다. 처음 실행 시 Whisper 모델이 다운로드됩니다.
          </p>
          <button
            type="button"
            onClick={props.onStart}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            STT 시작
          </button>
        </div>
      ) : null}

      {props.status === 'starting' ? (
        <p className="text-body-md text-slate">사이드카 시작 + 모델 로딩 중... (최초 1회 수십 초 소요)</p>
      ) : null}

      {props.status === 'transcribing' ? (
        <div className="gap-md flex flex-col">
          <div className="gap-md flex items-baseline justify-between">
            <h3 className="text-card-title text-ink font-semibold">전사 중 {formatPercent(props.progress)}</h3>
            <p className="text-body-sm text-slate">
              {props.progress.processed.toFixed(1)}s / {props.progress.total.toFixed(1)}s
            </p>
          </div>
          <div className="bg-surface h-2 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-[width]"
              style={{
                width:
                  props.progress.total > 0
                    ? `${Math.min(100, (props.progress.processed / props.progress.total) * 100)}%`
                    : '0%',
              }}
            />
          </div>
          <button
            type="button"
            onClick={props.onCancel}
            className="border-ink px-xl text-button-md text-ink h-10 self-start rounded-full border bg-transparent font-semibold"
          >
            취소
          </button>
        </div>
      ) : null}

      {props.status === 'done' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-success-text font-semibold">전사 완료</h3>
          <p className="text-body-sm text-slate">
            {props.transcript.segments.length}개 세그먼트 · {props.transcript.words.length}개 단어 ·{' '}
            {props.transcript.duration.toFixed(1)}초
          </p>
          <p className="text-body-sm text-slate break-all">{props.transcriptPath}</p>
          <div className="gap-sm flex">
            <button
              type="button"
              onClick={props.onOpen}
              className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
            >
              transcript 열기
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
            >
              새 전사
            </button>
          </div>
        </div>
      ) : null}

      {props.status === 'canceled' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">전사 취소됨</h3>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            다시 시도
          </button>
        </div>
      ) : null}

      {props.status === 'error' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-brand-coral font-semibold">전사 실패</h3>
          <p className="text-body-sm text-slate break-all">{props.error.message}</p>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            다시 시도
          </button>
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
yarn prettier --write src/renderer/components/newjob/TranscribeCard.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/newjob/TranscribeCard.tsx
git commit -m "feat(m4): add TranscribeCard with idle/starting/transcribing/done/canceled/error states"
```

---

### Task 15: Compose into NewJob.tsx

**Files:**

- Modify: `src/renderer/pages/NewJob.tsx`

After the download `done` block, add the TranscribeCard. The card pulls its own state from `useTranscribe`. We pass `download.state.outputPath` as the audio source.

- [ ] **Step 1: Read the current NewJob.tsx**

(Skim it so you know where the download `done` block is.)

- [ ] **Step 2: Add the imports + hook**

Near the top, add:

```ts
import { TranscribeCard } from '@renderer/components/newjob/TranscribeCard';
import { useTranscribe } from '@renderer/hooks/useTranscribe';
```

Inside the `NewJobPage` component, just below `const download = useDownload();`, add:

```ts
const transcribe = useTranscribe();
```

- [ ] **Step 3: Render TranscribeCard when download is done**

Find the existing block:

```tsx
{
  download.state.status === 'done' ? (
    <DownloadProgress
      status="done"
      outputPath={download.state.outputPath}
      onReveal={() => void window.api.revealInFolder(download.state.outputPath)}
      onReset={() => {
        download.reset();
        preview.reset();
      }}
    />
  ) : null;
}
```

Wrap this and the new TranscribeCard in a fragment so both render together when download is done:

```tsx
{
  download.state.status === 'done' ? (
    <>
      <DownloadProgress
        status="done"
        outputPath={download.state.outputPath}
        onReveal={() => void window.api.revealInFolder(download.state.outputPath)}
        onReset={() => {
          download.reset();
          preview.reset();
          transcribe.reset();
        }}
      />
      {transcribe.state.status === 'idle' ? (
        <TranscribeCard
          status="idle"
          onStart={() => void transcribe.start(download.state.status === 'done' ? download.state.outputPath : '')}
        />
      ) : null}
      {transcribe.state.status === 'starting' ? <TranscribeCard status="starting" /> : null}
      {transcribe.state.status === 'transcribing' ? (
        <TranscribeCard
          status="transcribing"
          progress={transcribe.state.progress}
          onCancel={() => void transcribe.cancel()}
        />
      ) : null}
      {transcribe.state.status === 'done' ? (
        <TranscribeCard
          status="done"
          transcriptPath={transcribe.state.transcriptPath}
          transcript={transcribe.state.transcript}
          onOpen={() => void window.api.openPath(transcribe.state.transcriptPath)}
          onReset={() => transcribe.reset()}
        />
      ) : null}
      {transcribe.state.status === 'canceled' ? (
        <TranscribeCard status="canceled" onReset={() => transcribe.reset()} />
      ) : null}
      {transcribe.state.status === 'error' ? (
        <TranscribeCard status="error" error={transcribe.state.error} onReset={() => transcribe.reset()} />
      ) : null}
    </>
  ) : null;
}
```

> Note the cosmetic narrowing trick: inside the inner ternary the type-narrowing of `download.state.status === 'done'` is already established; we re-check inside the closure to satisfy TypeScript without restructuring.

- [ ] **Step 4: Format + verify**

```bash
yarn prettier --write src/renderer/pages/NewJob.tsx
yarn lint && yarn typecheck && yarn test
```

Expected: all green; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/pages/NewJob.tsx
git commit -m "feat(m4): render TranscribeCard chain after download completes"
```

---

### Task 16: Smoke test for the transcribe button

**Files:**

- Modify: `tests/renderer/NewJob.test.tsx`

Add one test: after a successful download, the "전사 시작" button is visible and clicking it calls `transcribeFile`.

- [ ] **Step 1: Add the test inside the existing `describe('NewJobPage', ...)`**

After the existing 3 tests, append:

```tsx
it('shows the STT 시작 button after download completes and triggers transcribeFile on click', async () => {
  const calls = installApiMock();
  const user = userEvent.setup();
  render(<NewJobPage />);
  await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
  await user.click(screen.getByRole('button', { name: '미리보기' }));
  await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
  await user.click(screen.getByRole('button', { name: '다운로드' }));
  await waitFor(() => screen.getByRole('button', { name: 'STT 시작' }));
  await user.click(screen.getByRole('button', { name: 'STT 시작' }));
  await waitFor(() => expect(calls.transcribeFile).toHaveBeenCalledWith('/tmp/dQw4w9WgXcQ.mp4'));
});
```

The `installApiMock` helper already returns the `calls` object. We need to extend it to include `transcribeFile` in the returned calls:

In `tests/renderer/NewJob.test.tsx`, find the `installApiMock` function. Inside, `calls` is currently:

```ts
const calls = {
  fetchVideoPreview: vi.fn(async () => baseMeta),
  downloadVideo: vi.fn(async () => ({ outputPath: '/tmp/dQw4w9WgXcQ.mp4' })),
  cancelDownload: vi.fn(async () => undefined),
  onDownloadProgress: vi.fn(() => () => undefined),
  revealInFolder: vi.fn(async () => undefined),
};
```

Add a `transcribeFile` entry:

```ts
transcribeFile: vi.fn(async () => ({
  transcriptPath: '/tmp/dQw4w9WgXcQ.mp4.transcript.json',
  transcript: { duration: 19, language: 'en', segments: [], words: [] },
})),
```

And in the api object that uses these calls, replace the existing `transcribeFile: vi.fn(...)` (added in Task 12) with `transcribeFile: calls.transcribeFile`.

- [ ] **Step 2: Run the test**

```bash
yarn test tests/renderer/NewJob.test.tsx
```

Expected: 4 tests pass.

- [ ] **Step 3: Run the full suite**

```bash
yarn test
```

Expected: 59 tests pass (58 prior + 1 new).

- [ ] **Step 4: Commit**

```bash
git add tests/renderer/NewJob.test.tsx
git commit -m "test(m4): smoke test for 전사 시작 button after download done"
```

---

### Task 17: DoD verification + manual integration check + branch finalize

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Run all DoD checks**

```bash
yarn typecheck && yarn lint && yarn test && yarn build
cd sidecar && uv run pytest && cd ..
```

Expected: all green. The 16 sidecar pytest cases + 59 vitest cases all pass.

- [ ] **Step 2: Manual integration check (real model, real audio)**

Use the previously-downloaded test file from M3 dev runs (or download a fresh short video first):

```bash
ls "$HOME/Downloads/" | grep -E '\.(mp4|webm)$' | head
```

Pick one (e.g., `Me at the zoo.webm`). In another terminal, run:

```bash
yarn dev
```

In the app:

1. Settings page — confirm `whisper.model` defaults to `small` (or pick `tiny` to make this fast).
2. NewJob page — paste the original YouTube URL, click 미리보기, click 다운로드 (wait for completion).
3. Click "전사 시작". Within ~30s (first run includes model download — could take longer for `small`) you should see progress events tick up.
4. When done, click "transcript 열기" — the JSON should open in your default editor showing segments + words.

If the sidecar hangs or errors, check `[sidecar] ...` lines in the dev console (these come from Python stderr).

If something goes wrong, fix and re-test BEFORE committing.

- [ ] **Step 3: Update README status**

Edit `README.md` `## Status`:

```markdown
## Status

- ✅ M1: Project Skeleton
- ✅ M2: Settings page
- ✅ M3: YouTube preview + download
- ✅ M4: Python sidecar + STT — uv-managed sidecar with faster-whisper, JSON-RPC stdio, lazy boot, transcript.json next to source.
- ⏳ M5: LLM highlight extraction (next)
```

- [ ] **Step 4: Commit + push branch**

```bash
yarn prettier --write README.md
git add README.md
git commit -m "docs(m4): mark milestone 4 complete in README"
git push -u origin m4-python-sidecar-stt
```

- [ ] **Step 5: Merge to master + tag**

(Done by the controller via `superpowers:finishing-a-development-branch` skill — see Definition of Done below.)

---

## Definition of Done (M4)

All of these must be true:

1. `yarn typecheck`, `yarn lint` (only known `__dirname` warning), `yarn test`, `yarn build` all exit 0.
2. `cd sidecar && uv run pytest` reports all sidecar tests passing (16+).
3. `yarn test` reports 59 tests passing on the TS side (58 prior + 1 new transcribe smoke).
4. Manual integration: real `yarn dev` run downloads a short video, clicks 전사 시작, sees progress, sees transcript completion, opens transcript.json successfully.
5. Branch `m4-python-sidecar-stt` is pushed to origin.
6. After review, branch merged to master with `--no-ff` and tagged `m4-complete` on master.

## What's NOT in M4 (intentionally deferred)

- **GPU acceleration**: faster-whisper supports CUDA + Metal but we run CPU only for v1. Performance tuning in M10.
- **Sidecar bundling**: dev relies on `mise`-installed Python + `uv`. Packaged-app distribution needs PyInstaller or a frozen Python — that's an M10 concern.
- **MediaPipe face tracking**: deferred to M7. The sidecar gets a second method `track_faces` then.
- **Model auto-download UX**: the first transcribe with a new Whisper model triggers a HuggingFace download silently. M9 (history) gets a proper progress UI.
- **Cancel during model load**: SIGTERM-only at this stage — the sidecar process dies. Cooperative cancel during `WhisperModel.__init__()` is impractical. M5+ tracks model load as a separate state.
- **Transcript viewer UI**: M4 just opens the JSON in the user's default editor. M9 history view gets a proper inline transcript browser.

## Notes for the implementing agent

- Keep both projects' lints clean. The bob-park ESLint config bans `../*` parent imports — use `@renderer/*`, `@shared/*` aliases.
- The Python side has no equivalent strict lint config in M4. If you add `ruff` or similar, do it in a separate follow-up commit.
- Don't try to mock `faster_whisper.WhisperModel` at module level; inject via `model_factory` argument as the tests already do.
- The sidecar's `[sidecar] ...` log prefix on stderr is intentional — it makes Python log noise easy to spot in the Electron console.
- If `uv sync` fails on `faster-whisper`'s native deps (CTranslate2 wheels), confirm Python 3.11 is active (`which python`) and try `uv pip install --no-cache faster-whisper` in the sidecar venv to force a fresh install.
