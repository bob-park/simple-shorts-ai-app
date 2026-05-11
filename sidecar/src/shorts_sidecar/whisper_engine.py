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
    """Loads models lazily on first use, caches by (model, device).

    `transcribe()` is a generator that yields `TranscribeProgress` per segment
    and finally a `TranscribeResult`. If `is_canceled()` ever returns True,
    raises `InterruptedError` mid-iteration.

    `device` is plumbed through to `WhisperModel(device=...)`. Using the
    faster-whisper default `'auto'` on Windows triggers CTranslate2's CUDA
    probe which eagerly loads `cublas64_12.dll` — on a machine without the
    NVIDIA stack installed that fails with the user-visible error
    `Library cublas64_12.dll is not found or cannot be loaded`. Passing
    `'cpu'` skips the CUDA probe entirely. The caller (main.ts) is
    responsible for resolving `'auto'` to a concrete device per platform.
    """

    def __init__(self, model_factory: ModelFactory = _default_factory) -> None:
        self._factory = model_factory
        self._cache: dict[tuple[str, str], _ModelLike] = {}

    @property
    def loaded_models(self) -> list[str]:
        # Distinct model names (a single model loaded for two devices is still one model).
        return sorted({name for (name, _device) in self._cache})

    def _get(self, model: str, device: str) -> _ModelLike:
        key = (model, device)
        if key not in self._cache:
            self._cache[key] = self._factory(model, device=device)
        return self._cache[key]

    def transcribe(
        self,
        audio_path: str,
        *,
        model: str,
        language: str | None = None,
        device: str = "auto",
        is_canceled: Callable[[], bool] | None = None,
    ) -> Iterator[TranscribeProgress | TranscribeResult]:
        whisper = self._get(model, device)
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
