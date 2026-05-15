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


def test_engine_forwards_device_kwarg_to_factory():
    """Device must reach WhisperModel(device=…). Without this plumbing the
    factory falls back to faster-whisper's default 'auto', which on Windows
    triggers CTranslate2's CUDA probe and fails on machines without cublas."""
    received_kwargs: list[dict] = []

    def factory(model: str, **kwargs):
        received_kwargs.append(kwargs)
        return FakeWhisperModel(model)

    engine = WhisperEngine(model_factory=factory)
    list(engine.transcribe("/tmp/a.mp4", model="small", device="cpu"))
    assert received_kwargs == [{"device": "cpu"}]


def test_engine_caches_separately_by_device():
    """Same model name with different device must construct two underlying
    WhisperModel instances — the cache key is (model, device)."""
    created: list[tuple[str, str]] = []

    def factory(model: str, **kwargs):
        created.append((model, kwargs["device"]))
        return FakeWhisperModel(model)

    engine = WhisperEngine(model_factory=factory)
    list(engine.transcribe("/tmp/a.mp4", model="small", device="cpu"))
    list(engine.transcribe("/tmp/b.mp4", model="small", device="cpu"))  # cache hit
    list(engine.transcribe("/tmp/c.mp4", model="small", device="cuda"))  # cache miss
    assert created == [("small", "cpu"), ("small", "cuda")]


# --- ensure_model: byte-level download progress + stale-cache cleanup -------


def test_ensure_model_resolves_size_to_repo_and_calls_snapshot():
    captured: dict = {}

    def fake_snapshot(repo_id, *, allow_patterns, tqdm_class):
        captured["repo_id"] = repo_id
        captured["allow_patterns"] = allow_patterns

    engine = WhisperEngine(model_factory=lambda *a, **k: FakeWhisperModel("x"))
    engine.ensure_model(
        "small",
        on_progress=lambda d, t: None,
        snapshot_download=fake_snapshot,
        hf_cache_dir="/tmp/does-not-exist-cache",
    )
    # faster-whisper maps 'small' → Systran/faster-whisper-small
    assert captured["repo_id"] == "Systran/faster-whisper-small"
    assert "model.bin" in captured["allow_patterns"]


def test_ensure_model_passes_through_explicit_repo_id():
    captured: dict = {}

    def fake_snapshot(repo_id, *, allow_patterns, tqdm_class):
        captured["repo_id"] = repo_id

    engine = WhisperEngine(model_factory=lambda *a, **k: FakeWhisperModel("x"))
    engine.ensure_model(
        "deepdml/faster-whisper-large-v3-turbo-ct2",
        on_progress=lambda d, t: None,
        snapshot_download=fake_snapshot,
        hf_cache_dir="/tmp/does-not-exist-cache",
    )
    assert captured["repo_id"] == "deepdml/faster-whisper-large-v3-turbo-ct2"


def test_ensure_model_unknown_size_raises():
    engine = WhisperEngine(model_factory=lambda *a, **k: FakeWhisperModel("x"))
    with pytest.raises(ValueError):
        engine.ensure_model(
            "not-a-real-size",
            on_progress=lambda d, t: None,
            snapshot_download=lambda *a, **k: None,
            hf_cache_dir="/tmp/does-not-exist-cache",
        )


def test_ensure_model_forwards_aggregated_byte_progress():
    seen: list[tuple[int, int]] = []

    def fake_snapshot(repo_id, *, allow_patterns, tqdm_class):
        # Simulate huggingface_hub: one tqdm per file, .update(n) per chunk.
        t1 = tqdm_class(total=200)
        t1.update(50)
        t1.update(150)
        t2 = tqdm_class(total=100)
        t2.update(100)

    engine = WhisperEngine(model_factory=lambda *a, **k: FakeWhisperModel("x"))
    engine.ensure_model(
        "small",
        on_progress=lambda d, t: seen.append((d, t)),
        snapshot_download=fake_snapshot,
        hf_cache_dir="/tmp/does-not-exist-cache",
    )
    # Cumulative across both files; final = (300, 300)
    assert seen[-1] == (300, 300)
    assert seen[0] == (50, 200)


def test_ensure_model_cleans_stale_incomplete_and_lock_files(tmp_path):
    repo_folder = "models--Systran--faster-whisper-small"
    blobs = tmp_path / repo_folder / "blobs"
    blobs.mkdir(parents=True)
    incomplete = blobs / "abc123.incomplete"
    incomplete.write_text("partial")
    good_blob = blobs / "abc123"
    good_blob.write_text("complete")
    locks = tmp_path / ".locks" / repo_folder
    locks.mkdir(parents=True)
    lock = locks / "abc123.lock"
    lock.write_text("")

    engine = WhisperEngine(model_factory=lambda *a, **k: FakeWhisperModel("x"))
    engine.ensure_model(
        "small",
        on_progress=lambda d, t: None,
        snapshot_download=lambda *a, **k: None,
        hf_cache_dir=str(tmp_path),
    )
    assert not incomplete.exists()  # stale partial removed
    assert not lock.exists()  # stale lock removed
    assert good_blob.exists()  # completed blob untouched


# --- GPU device → CPU graceful fallback (Blackwell / unsupported CUDA) -------


def test_transcribe_falls_back_to_cpu_when_cuda_device_fails(capsys):
    calls: list[str] = []

    def factory(model: str, **kwargs):
        dev = kwargs["device"]
        calls.append(dev)
        if dev == "cuda":
            raise RuntimeError("no kernel image is available for execution on the device")
        return FakeWhisperModel(model)

    engine = WhisperEngine(model_factory=factory)
    out = list(engine.transcribe("/tmp/a.mp4", model="small", device="cuda"))

    assert calls == ["cuda", "cpu"]  # tried GPU, fell back to CPU
    assert isinstance(out[-1], TranscribeResult)
    err = capsys.readouterr().err
    assert "device='cuda' unavailable" in err
    assert "no kernel image" in err  # exact CUDA error is surfaced for diagnosis


def test_transcribe_cpu_failure_is_not_retried():
    def factory(model: str, **_kwargs):
        raise RuntimeError("boom")

    engine = WhisperEngine(model_factory=factory)
    with pytest.raises(RuntimeError, match="boom"):
        list(engine.transcribe("/tmp/a.mp4", model="small", device="cpu"))


def test_transcribe_no_cpu_fallback_when_requested_device_succeeds():
    calls: list[str] = []

    def factory(model: str, **kwargs):
        calls.append(kwargs["device"])
        return FakeWhisperModel(model)

    engine = WhisperEngine(model_factory=factory)
    list(engine.transcribe("/tmp/a.mp4", model="small", device="cuda"))
    assert calls == ["cuda"]  # no needless CPU re-attempt when GPU works
