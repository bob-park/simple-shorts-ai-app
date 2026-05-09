"""Dispatcher: pulls messages from `inbound`, services them, pushes results to `outbound`.

Transcribe runs on a worker thread so cancel/health requests can be handled
while a transcription is in progress.
"""

from __future__ import annotations

import threading
import traceback
from dataclasses import asdict
from queue import Queue, Empty
from typing import Any

from .whisper_engine import TranscribeProgress, TranscribeResult, WhisperEngine


class Server:
    def __init__(self, engine: Any | None = None) -> None:
        self._engine = engine if engine is not None else WhisperEngine()
        self._cancel_event = threading.Event()
        self._active_job_id: str | None = None
        self._worker: threading.Thread | None = None
        self._lock = threading.Lock()

    # Public entry: drain `inbound`, push outputs to `outbound`. Returns when
    # a sentinel `None` is received from `inbound`.
    def run(self, inbound: Queue, outbound: Queue) -> None:
        while True:
            msg = inbound.get()
            if msg is None:
                # Wait for any in-flight job to finish/cancel before exiting.
                self._cancel_event.set()
                if self._worker is not None:
                    self._worker.join(timeout=2.0)
                return
            self._dispatch(msg, outbound)

    # --- private ----------------------------------------------------------

    def _dispatch(self, msg: dict, outbound: Queue) -> None:
        method = msg.get("method")
        if method == "health":
            outbound.put(
                {
                    "id": msg.get("id"),
                    "result": {"ok": True, "modelsLoaded": self._engine.loaded_models},
                }
            )
            return
        if method == "transcribe":
            self._start_transcribe(msg, outbound)
            return
        if method == "cancel":
            with self._lock:
                target = (msg.get("params") or {}).get("jobId") or self._active_job_id
                if target and target == self._active_job_id:
                    self._cancel_event.set()
            return
        # Unknown method
        outbound.put(
            {
                "id": msg.get("id"),
                "error": {"code": "unknown_method", "message": f"unknown method: {method!r}"},
            }
        )

    def _start_transcribe(self, msg: dict, outbound: Queue) -> None:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                outbound.put(
                    {
                        "id": msg.get("id"),
                        "error": {"code": "busy", "message": "another transcribe job is in progress"},
                    }
                )
                return
            job_id = str(msg.get("id"))
            self._active_job_id = job_id
            self._cancel_event.clear()
            self._worker = threading.Thread(
                target=self._run_transcribe,
                args=(job_id, msg.get("params") or {}, outbound),
                daemon=True,
            )
            self._worker.start()

    def _run_transcribe(self, job_id: str, params: dict, outbound: Queue) -> None:
        try:
            stream = self._engine.transcribe(
                params.get("audio_path"),
                model=params.get("model", "small"),
                language=params.get("language"),
                is_canceled=self._cancel_event.is_set,
            )
            for item in stream:
                if isinstance(item, TranscribeProgress):
                    outbound.put(
                        {
                            "method": "progress",
                            "params": {
                                "jobId": job_id,
                                "processed": item.processed,
                                "total": item.total,
                            },
                        }
                    )
                elif isinstance(item, TranscribeResult):
                    payload = asdict(item)
                    payload.pop("kind", None)
                    outbound.put({"id": job_id, "result": payload})
        except InterruptedError:
            outbound.put(
                {
                    "id": job_id,
                    "error": {"code": "canceled", "message": "Transcription canceled"},
                }
            )
        except Exception as e:
            outbound.put(
                {
                    "id": job_id,
                    "error": {
                        "code": "transcribe_failed",
                        "message": f"{type(e).__name__}: {e}\n{traceback.format_exc()}",
                    },
                }
            )
        finally:
            with self._lock:
                if self._active_job_id == job_id:
                    self._active_job_id = None
