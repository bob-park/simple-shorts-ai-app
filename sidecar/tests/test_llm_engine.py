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


def test_download_model_writes_then_atomically_renames(tmp_path, monkeypatch):
    """Successful download path: progress fires, .partial gets renamed to final."""
    engine = LlmEngine()
    model_path = str(tmp_path / "model.gguf")
    progress_calls = []

    def fake_hf_download(*, repo_id, filename, local_dir, **kwargs):
        # Simulate hf writing the file directly into local_dir/filename
        out = Path(local_dir) / filename
        out.write_bytes(b"FAKE_GGUF_CONTENTS" * 1000)
        return str(out)

    # Patch the hf_hub_download symbol the engine imports
    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng, "hf_hub_download", fake_hf_download)

    engine.download_model(
        model_path=model_path,
        repo="unsloth/gemma-3-4b-it-GGUF",
        filename="gemma-3-4b-it-Q4_K_M.gguf",
        progress_callback=lambda processed, total: progress_calls.append((processed, total)),
    )
    assert os.path.exists(model_path)
    # Final file matches the simulated content; .partial is gone
    assert not os.path.exists(model_path + ".partial-dir")
    # Two progress emissions: (0, 0) start + (size, size) end
    assert len(progress_calls) == 2
    assert progress_calls[0] == (0, 0)
    assert progress_calls[1][0] == progress_calls[1][1]  # processed == total at completion
    assert progress_calls[1][0] > 0


def test_download_model_cleans_up_partial_on_exception(tmp_path, monkeypatch):
    """If hf_hub_download raises, the .partial-dir contents must be deleted."""
    engine = LlmEngine()
    model_path = str(tmp_path / "model.gguf")
    partial_dir = model_path + ".partial-dir"

    def failing_hf(*, local_dir, filename, **kwargs):
        # Simulate a partially-written file then a failure
        out = Path(local_dir) / filename
        out.write_bytes(b"PARTIAL")
        raise RuntimeError("network error")

    import shorts_sidecar.llm_engine as eng
    monkeypatch.setattr(eng, "hf_hub_download", failing_hf)

    with pytest.raises(RuntimeError, match="network error"):
        engine.download_model(
            model_path=model_path,
            repo="unsloth/gemma-3-4b-it-GGUF",
            filename="gemma-3-4b-it-Q4_K_M.gguf",
            progress_callback=lambda *_: None,
        )
    # Neither final nor partial should remain
    assert not os.path.exists(model_path)
    assert not os.path.exists(partial_dir)
