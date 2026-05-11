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
