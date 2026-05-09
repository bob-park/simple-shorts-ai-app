"""Local LLM engine using llama-cpp-python with GBNF JSON enforcement.

Owns model load + cache, GGUF download via huggingface-hub, and JSON-grammar-
constrained chat completion. The caller (sidecar server) is responsible for
threading: long-running download_model and chat calls should run on the
same worker-thread pattern used by transcribe.
"""

from __future__ import annotations

import os
from typing import Any


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
