"""Local LLM engine using llama-cpp-python with GBNF JSON enforcement.

Owns model load + cache, GGUF download via huggingface-hub, and JSON-grammar-
constrained chat completion. The caller (sidecar server) is responsible for
threading: long-running download_model and chat calls should run on the
same worker-thread pattern used by transcribe.
"""

from __future__ import annotations

import json
import os
import shutil
from typing import Any, Callable

import requests
from huggingface_hub import hf_hub_url
from llama_cpp import Llama, LlamaGrammar

# Emit a progress event every ~1MB downloaded. Smaller = smoother UI but more
# IPC noise; 1MB on a 2.5GB file ≈ 2500 events over a multi-minute download.
_PROGRESS_EMIT_BYTES = 1024 * 1024


HIGHLIGHTS_GBNF = r'''
root        ::= "{" ws "\"highlights\"" ws ":" ws highlights ws "}"
highlights  ::= "[" ws (highlight (ws "," ws highlight)*)? ws "]"
highlight   ::= "{" ws
                  "\"segment_indices\"" ws ":" ws indices ws "," ws
                  "\"title\"" ws ":" ws string ws "," ws
                  "\"hook\"" ws ":" ws string
                ws "}"
indices     ::= "[" ws (integer (ws "," ws integer)*)? ws "]"
integer     ::= [0-9]+
string      ::= "\"" char* "\""
char        ::= [^"\\] | "\\" ["\\/bfnrt] | "\\u" hex hex hex hex
hex         ::= [0-9a-fA-F]
ws          ::= [ \t\n]*
'''


class LlmEngine:
    def __init__(self) -> None:
        # Cached model + path so repeated chat calls don't reload from disk.
        self._loaded_model: Any | None = None
        self._loaded_model_path: str | None = None

    def model_status(self, model_path: str) -> dict[str, Any]:
        """Report whether the GGUF exists on disk and (separately) whether the
        engine has it loaded in memory. A bare `.partial` file is ignored —
        only the final file counts as 'exists'.
        """
        try:
            size = os.path.getsize(model_path)
            exists = True
        except OSError:
            size = 0
            exists = False
        return {
            "exists": exists,
            "sizeBytes": size,
            "loaded": exists and self._loaded_model_path == model_path,
        }

    def download_model(
        self,
        model_path: str,
        repo: str,
        filename: str,
        progress_callback: Callable[[int, int], None],
    ) -> None:
        """Download `filename` from HuggingFace `repo` into `model_path`.

        Strategy: stream the file directly via `requests.get(stream=True)` so
        we get byte-level progress (huggingface_hub's `hf_hub_download` doesn't
        expose a callback hook). Write to `<model_path>.partial-dir/<filename>`
        and atomically rename on success; clean up the staging dir in `finally`
        so a partial file is never mistaken for a valid model.
        """
        url = hf_hub_url(repo_id=repo, filename=filename)
        partial_dir = model_path + ".partial-dir"
        partial_file = os.path.join(partial_dir, filename)
        os.makedirs(partial_dir, exist_ok=True)
        try:
            with requests.get(url, stream=True, allow_redirects=True, timeout=30) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("content-length", 0))
                progress_callback(0, total)
                downloaded = 0
                last_emitted = 0
                with open(partial_file, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=_PROGRESS_EMIT_BYTES):
                        if not chunk:
                            continue
                        f.write(chunk)
                        downloaded += len(chunk)
                        if downloaded - last_emitted >= _PROGRESS_EMIT_BYTES:
                            progress_callback(downloaded, total or downloaded)
                            last_emitted = downloaded
            # Final emit so the UI lands at exactly 100% even if the last
            # chunk was smaller than _PROGRESS_EMIT_BYTES.
            progress_callback(downloaded, total or downloaded)
            os.replace(partial_file, model_path)
        finally:
            # Best-effort recursive cleanup. Removes the partial file on
            # success (after rename, only the empty dir remains) and any
            # half-written file on exception.
            shutil.rmtree(partial_dir, ignore_errors=True)

    # Pre-compile grammars at first use (lazy so tests can patch).
    _grammars: dict[str, Any] = {}

    @classmethod
    def _grammar(cls, schema_id: str) -> Any:
        if schema_id not in cls._grammars:
            if schema_id in ("highlights", "highlights_rerank"):
                cls._grammars[schema_id] = LlamaGrammar.from_string(HIGHLIGHTS_GBNF)
            else:
                raise ValueError(f"unknown schema_id: {schema_id!r}")
        return cls._grammars[schema_id]

    def _ensure_loaded(self, model_path: str) -> Any:
        if self._loaded_model is None or self._loaded_model_path != model_path:
            if self._loaded_model is not None:
                # Release reference so GC + llama-cpp can free GPU memory.
                self._loaded_model = None
            self._loaded_model = Llama(
                model_path=model_path,
                n_ctx=8192,
                n_gpu_layers=-1,
                verbose=False,
            )
            self._loaded_model_path = model_path
        return self._loaded_model

    def chat(
        self,
        model_path: str,
        system: str,
        user: str,
        schema_id: str,
        temperature: float,
        max_tokens: int,
    ) -> dict[str, Any]:
        model = self._ensure_loaded(model_path)
        grammar = self._grammar(schema_id)
        out = model.create_chat_completion(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            grammar=grammar,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        text = out["choices"][0]["message"]["content"]
        return {
            "json": json.loads(text),
            "usage": out.get("usage", {}),
        }
