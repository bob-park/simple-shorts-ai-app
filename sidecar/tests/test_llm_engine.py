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
