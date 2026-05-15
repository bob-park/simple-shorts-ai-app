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


# Mirrors faster_whisper.utils.download_model's allow_patterns — the only
# files a CTranslate2 Whisper model needs. Kept here so our progress-enabled
# prefetch downloads exactly the same set faster-whisper would.
_WHISPER_ALLOW_PATTERNS = [
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
]


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

    @staticmethod
    def _repo_folder_name(repo_id: str) -> str:
        # huggingface_hub cache layout: models--<org>--<name>
        return "models--" + repo_id.replace("/", "--")

    def _cleanup_stale_cache(self, hf_cache_dir: str, repo_id: str) -> None:
        """Remove a prior interrupted download's debris for this repo.

        Killing the app mid-download leaves `*.incomplete` blobs and stale
        `.locks/` entries. faster-whisper would try to resume the partial
        blob; if it is corrupt that can wedge or loop, so a clean refetch is
        safer. Best-effort — never raises.
        """
        from pathlib import Path  # noqa: PLC0415

        base = Path(hf_cache_dir)
        folder = self._repo_folder_name(repo_id)
        blobs = base / folder / "blobs"
        if blobs.is_dir():
            for p in blobs.glob("*.incomplete"):
                try:
                    p.unlink()
                except OSError:
                    pass
        locks = base / ".locks" / folder
        if locks.is_dir():
            for p in locks.iterdir():
                try:
                    if p.is_file():
                        p.unlink()
                except OSError:
                    pass

    def _progress_tqdm(self, on_progress: Callable[[int, int], None]) -> type:
        """A tqdm subclass that aggregates byte counts across every per-file
        tqdm huggingface_hub creates and forwards cumulative (done, total) to
        `on_progress`. Subclasses hf's own tqdm so it stays fully compatible
        with snapshot_download's usage (context manager, kwargs, disabled
        mode) while we only hook construction + update.
        """
        from huggingface_hub.utils import tqdm as _hf_tqdm  # noqa: PLC0415

        state = {"done": 0, "total": 0}

        def emit() -> None:
            try:
                on_progress(state["done"], state["total"])
            except Exception:
                pass

        class _ProgressTqdm(_hf_tqdm):  # type: ignore[misc, valid-type]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, **kwargs)
                state["total"] += int(self.total or 0)

            def update(self, n: float = 1) -> Any:
                ret = super().update(n)
                state["done"] += int(n or 0)
                emit()
                return ret

        return _ProgressTqdm

    def ensure_model(
        self,
        model: str,
        *,
        on_progress: Callable[[int, int], None],
        snapshot_download: Callable[..., Any] | None = None,
        hf_cache_dir: str | None = None,
    ) -> None:
        """Prefetch the faster-whisper model into the HF cache WITH byte
        progress, before `WhisperModel(...)` loads it.

        faster-whisper's own `download_model` passes `tqdm_class=disabled_tqdm`,
        so a multi-minute first-run download is completely invisible — the
        user cannot tell "downloading" from "hung" and kills the app. We
        download the identical file set via `snapshot_download` with a
        progress tqdm into the same HF_HOME cache; the subsequent
        `WhisperModel(...)` then loads from cache with no second download.
        """
        if "/" in model:
            repo_id = model
        else:
            from faster_whisper.utils import _MODELS  # noqa: PLC0415

            repo_id = _MODELS.get(model)
            if repo_id is None:
                raise ValueError(f"unknown whisper model size: {model!r}")

        if hf_cache_dir is None:
            from huggingface_hub.constants import HF_HUB_CACHE  # noqa: PLC0415

            hf_cache_dir = HF_HUB_CACHE

        self._cleanup_stale_cache(hf_cache_dir, repo_id)

        if snapshot_download is None:
            from huggingface_hub import (  # noqa: PLC0415
                snapshot_download as snapshot_download,
            )

        snapshot_download(
            repo_id,
            allow_patterns=_WHISPER_ALLOW_PATTERNS,
            tqdm_class=self._progress_tqdm(on_progress),
        )

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
