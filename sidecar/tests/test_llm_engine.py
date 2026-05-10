"""Unit tests for the LLM engine (model status, download, chat)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from shorts_sidecar.llm_engine import LlmEngine


def test_model_status_reports_missing_when_file_absent(tmp_path: Path) -> None:
    engine = LlmEngine()
    model_path = str(tmp_path / "no-such-model.gguf")
    status = engine.model_status(model_path)
    assert status == {"exists": False, "sizeBytes": 0, "loaded": False}


def test_model_status_reports_present_with_size(tmp_path: Path) -> None:
    engine = LlmEngine()
    model_path = tmp_path / "fake-model.gguf"
    model_path.write_bytes(b"x" * 4096)
    status = engine.model_status(str(model_path))
    assert status == {"exists": True, "sizeBytes": 4096, "loaded": False}


def test_model_status_ignores_partial_file(tmp_path: Path) -> None:
    """A bare `.partial` file (no real model) means the previous download
    was interrupted — we should still report exists=False so the caller
    triggers a fresh download."""
    engine = LlmEngine()
    model_path = tmp_path / "model.gguf"
    (tmp_path / "model.gguf.partial").write_bytes(b"x" * 100)
    # No model.gguf — only .partial
    status = engine.model_status(str(model_path))
    assert status == {"exists": False, "sizeBytes": 0, "loaded": False}


class _FakeStreamResponse:
    """Mimics requests.Response in stream=True mode."""

    def __init__(self, chunks: list[bytes], status: int = 200, content_length: int | None = None):
        self._chunks = chunks
        self.status_code = status
        total = sum(len(c) for c in chunks) if content_length is None else content_length
        self.headers = {"content-length": str(total)}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size: int):
        for c in self._chunks:
            yield c

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_download_model_writes_then_atomically_renames(tmp_path, monkeypatch):
    """Successful streaming download: per-chunk progress fires, .partial gets renamed to final."""
    engine = LlmEngine()
    model_path = str(tmp_path / "model.gguf")
    progress_calls: list[tuple[int, int]] = []

    # 3MB total in 1MB chunks → engine should emit (0, total) start +
    # one progress event per chunk that crosses the 1MB threshold + a final emit.
    chunks = [b"x" * (1024 * 1024)] * 3

    def fake_get(url, stream, allow_redirects, timeout):
        return _FakeStreamResponse(chunks)

    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng.requests, "get", fake_get)

    engine.download_model(
        model_path=model_path,
        repo="unsloth/gemma-3-4b-it-GGUF",
        filename="gemma-3-4b-it-Q4_K_M.gguf",
        progress_callback=lambda processed, total: progress_calls.append((processed, total)),
    )
    assert os.path.exists(model_path)
    assert not os.path.exists(model_path + ".partial-dir"), "partial-dir must be removed on success"
    assert os.path.getsize(model_path) == 3 * 1024 * 1024
    # First emit is (0, total); last must reach (total, total).
    assert progress_calls[0] == (0, 3 * 1024 * 1024)
    assert progress_calls[-1] == (3 * 1024 * 1024, 3 * 1024 * 1024)
    # At least 4 events (start + 3 chunks completing); more is fine.
    assert len(progress_calls) >= 4


def test_download_model_handles_unknown_content_length(tmp_path, monkeypatch):
    """If the server doesn't send Content-Length, fall back to using the
    downloaded count itself as 'total' (so the bar at least lands at 100%)."""
    engine = LlmEngine()
    model_path = str(tmp_path / "model.gguf")
    progress_calls: list[tuple[int, int]] = []

    chunks = [b"x" * (1024 * 1024)] * 2

    def fake_get(url, stream, allow_redirects, timeout):
        # content_length=0 simulates a missing/unknown Content-Length header.
        return _FakeStreamResponse(chunks, content_length=0)

    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng.requests, "get", fake_get)

    engine.download_model(
        model_path=model_path,
        repo="unsloth/gemma-3-4b-it-GGUF",
        filename="gemma-3-4b-it-Q4_K_M.gguf",
        progress_callback=lambda p, t: progress_calls.append((p, t)),
    )
    assert os.path.exists(model_path)
    # Final emit should have processed == total (both = downloaded count).
    assert progress_calls[-1] == (2 * 1024 * 1024, 2 * 1024 * 1024)


def test_download_model_cleans_up_partial_on_exception(tmp_path, monkeypatch):
    """If the stream raises mid-download, the .partial-dir must be deleted."""
    engine = LlmEngine()
    model_path = str(tmp_path / "model.gguf")
    partial_dir = model_path + ".partial-dir"

    class FailingResponse(_FakeStreamResponse):
        def iter_content(self, chunk_size: int):
            yield b"x" * 1024
            raise RuntimeError("network error")

    def failing_get(url, stream, allow_redirects, timeout):
        return FailingResponse([b"x" * 1024], content_length=1024 * 1024)

    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng.requests, "get", failing_get)

    with pytest.raises(RuntimeError, match="network error"):
        engine.download_model(
            model_path=model_path,
            repo="unsloth/gemma-3-4b-it-GGUF",
            filename="gemma-3-4b-it-Q4_K_M.gguf",
            progress_callback=lambda *_: None,
        )
    # Neither final nor partial should remain.
    assert not os.path.exists(model_path)
    assert not os.path.exists(partial_dir)


def test_chat_passes_json_schema_response_format(tmp_path, monkeypatch):
    """chat() must request response_format json_object with the highlights schema
    so llama-cpp constrains output to the right shape — bypasses the grammar=
    sampler chain that segfaults on Gemma 3 4B in llama-cpp-python 0.3.22."""
    from shorts_sidecar.llm_engine import HIGHLIGHTS_JSON_SCHEMA

    engine = LlmEngine()
    fake_model_path = str(tmp_path / "model.gguf")
    Path(fake_model_path).write_bytes(b"x")

    captured: list[dict] = []

    class FakeLlama:
        def __init__(self, **kwargs):
            pass
        def create_chat_completion(self, **kwargs):
            captured.append(kwargs)
            return {"choices": [{"message": {"content": '{"highlights":[]}'}}], "usage": {}}

    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng, "Llama", FakeLlama)

    engine.chat(model_path=fake_model_path, system="s", user="u", schema_id="highlights",
                temperature=0.7, max_tokens=128)
    assert captured[0]["response_format"] == {"type": "json_object", "schema": HIGHLIGHTS_JSON_SCHEMA}
    assert "grammar" not in captured[0], "must NOT pass grammar= (segfault path)"


def test_chat_rejects_unknown_schema_id(tmp_path, monkeypatch):
    engine = LlmEngine()
    fake_model_path = str(tmp_path / "model.gguf")
    Path(fake_model_path).write_bytes(b"x")

    class FakeLlama:
        def __init__(self, **kwargs):
            pass
        def create_chat_completion(self, **kwargs):
            return {"choices": [{"message": {"content": "{}"}}], "usage": {}}

    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng, "Llama", FakeLlama)

    with pytest.raises(ValueError, match="unknown schema_id"):
        engine.chat(model_path=fake_model_path, system="s", user="u", schema_id="bogus",
                    temperature=0.7, max_tokens=128)


def test_chat_loads_model_once_for_repeated_calls(tmp_path, monkeypatch):
    """Two chat calls with the same model path should reuse the cached Llama instance."""
    engine = LlmEngine()
    fake_model_path = str(tmp_path / "model.gguf")
    Path(fake_model_path).write_bytes(b"x")  # llama-cpp won't actually load this; we monkeypatch

    construct_count = 0
    class FakeLlama:
        def __init__(self, **kwargs):
            nonlocal construct_count
            construct_count += 1
        def create_chat_completion(self, **kwargs):
            return {
                "choices": [{"message": {"content": '{"highlights":[]}'}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            }

    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng, "Llama", FakeLlama)

    r1 = engine.chat(model_path=fake_model_path, system="s", user="u", schema_id="highlights",
                    temperature=0.7, max_tokens=128)
    r2 = engine.chat(model_path=fake_model_path, system="s", user="u", schema_id="highlights",
                    temperature=0.7, max_tokens=128)
    assert r1["json"] == {"highlights": []}
    assert r2["json"] == {"highlights": []}
    assert construct_count == 1, "model should be loaded once"


def test_chat_reloads_model_when_path_changes(tmp_path, monkeypatch):
    engine = LlmEngine()
    p1 = str(tmp_path / "a.gguf")
    p2 = str(tmp_path / "b.gguf")
    Path(p1).write_bytes(b"x")
    Path(p2).write_bytes(b"x")

    construct_count = 0
    class FakeLlama:
        def __init__(self, **kwargs):
            nonlocal construct_count
            construct_count += 1
        def create_chat_completion(self, **kwargs):
            return {"choices": [{"message": {"content": '{"highlights":[]}'}}], "usage": {}}

    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng, "Llama", FakeLlama)

    engine.chat(model_path=p1, system="s", user="u", schema_id="highlights", temperature=0.7, max_tokens=128)
    engine.chat(model_path=p2, system="s", user="u", schema_id="highlights", temperature=0.7, max_tokens=128)
    assert construct_count == 2
