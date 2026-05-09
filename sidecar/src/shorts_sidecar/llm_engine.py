"""Local LLM engine using llama-cpp-python with GBNF JSON enforcement.

Owns model load + cache, GGUF download via huggingface-hub, and JSON-grammar-
constrained chat completion. The caller (sidecar server) is responsible for
threading: long-running download_model and chat calls should run on the
same worker-thread pattern used by transcribe.
"""

from __future__ import annotations

import os
from typing import Any, Callable

from huggingface_hub import hf_hub_download


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

        Strategy: download into `<model_path>.partial-dir/` directory first
        (so an interrupted download leaves only a `.partial-dir` artifact,
        never a half-written final file the next launch might mistake for
        valid). On success, atomically rename to the final path. On exception,
        delete the partial artifact.

        Note: `hf_hub_download` doesn't expose a byte-level progress callback
        in the pinned version, so we emit just two events — (0, 0) at start
        and (size, size) at end. Better-grained progress would require a raw
        `requests` download with `iter_content`; out of scope for v1.
        """
        partial_dir = model_path + ".partial-dir"
        os.makedirs(partial_dir, exist_ok=True)
        try:
            progress_callback(0, 0)
            downloaded_path = hf_hub_download(
                repo_id=repo,
                filename=filename,
                local_dir=partial_dir,
                local_dir_use_symlinks=False,
            )
            size = os.path.getsize(downloaded_path)
            progress_callback(size, size)
            # Atomically rename out of the partial dir
            os.replace(downloaded_path, model_path)
        except Exception:
            raise
        finally:
            # Best-effort dir cleanup — remove any leftover files + the dir
            try:
                if os.path.isdir(partial_dir):
                    for entry in os.listdir(partial_dir):
                        try:
                            os.unlink(os.path.join(partial_dir, entry))
                        except OSError:
                            pass
                    os.rmdir(partial_dir)
            except OSError:
                pass
