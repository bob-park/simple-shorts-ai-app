"""Entrypoint: `python -m shorts_sidecar` — line-JSON over stdio."""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from queue import Queue


def _add_nvidia_dll_directories() -> None:
    """Make NVIDIA's CUDA DLLs (cublas64_12.dll, cudnn_*.dll, cudart64_12.dll)
    discoverable by the OS DLL loader on Windows.

    The `nvidia-cublas-cu12`, `nvidia-cudnn-cu12`, and `nvidia-cuda-runtime-cu12`
    Python wheels drop their DLLs at `<venv>/Lib/site-packages/nvidia/<lib>/bin/`,
    which is NOT in the default LoadLibrary search path. CTranslate2 ≥ 4.4 and
    llama-cpp-python ≥ 0.3 both *try* to auto-add these directories at import
    time, but older transitive versions don't, so we do it explicitly here
    BEFORE the first ctranslate2 / llama-cpp import (which happens inside
    `.server` → faster_whisper / llama_cpp). The Path.is_dir guard makes this
    a no-op when the packages aren't installed (CPU-only configurations).
    """
    if sys.platform != "win32":
        return
    site_packages = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    for subdir in ("cublas", "cudnn", "cuda_runtime"):
        bin_dir = site_packages / subdir / "bin"
        if bin_dir.is_dir():
            os.add_dll_directory(str(bin_dir))


_add_nvidia_dll_directories()

from .rpc import encode_message, parse_line  # noqa: E402
from .server import Server  # noqa: E402


def _stdin_reader(inbound: Queue) -> None:
    for raw in sys.stdin:
        try:
            msg = parse_line(raw)
        except ValueError:
            continue
        if msg is None:
            continue
        inbound.put(msg)
    inbound.put(None)  # EOF → shutdown


def _stdout_writer(outbound: Queue) -> None:
    while True:
        msg = outbound.get()
        if msg is None:
            return
        sys.stdout.write(encode_message(msg))
        sys.stdout.flush()


def main() -> int:
    inbound: Queue = Queue()
    outbound: Queue = Queue()

    reader = threading.Thread(target=_stdin_reader, args=(inbound,), daemon=True)
    writer = threading.Thread(target=_stdout_writer, args=(outbound,), daemon=True)
    reader.start()
    writer.start()

    server = Server()
    server.run(inbound, outbound)

    outbound.put(None)
    writer.join(timeout=1.0)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
