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

from .llm_engine import LlmEngine
from .whisper_engine import TranscribeProgress, TranscribeResult, WhisperEngine


class Server:
    def __init__(
        self,
        engine: Any | None = None,
        face_tracker: Any | None = None,
        llm_engine: Any | None = None,
    ) -> None:
        self._engine = engine if engine is not None else WhisperEngine()
        self._face_tracker = face_tracker
        self._llm_engine = llm_engine if llm_engine is not None else LlmEngine()
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
        if method == "track_faces":
            self._handle_track_faces(msg, outbound)
            return
        if method == "llm_model_status":
            self._handle_llm_model_status(msg, outbound)
            return
        if method == "llm_download_model":
            self._start_llm_download(msg, outbound)
            return
        # Unknown method
        outbound.put(
            {
                "id": msg.get("id"),
                "error": {"code": "unknown_method", "message": f"unknown method: {method!r}"},
            }
        )

    def _get_face_tracker(self):
        if self._face_tracker is None:
            from .face_tracker import FaceTracker

            self._face_tracker = FaceTracker()
        return self._face_tracker

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

    def _start_llm_download(self, msg: dict, outbound: Queue) -> None:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                outbound.put(
                    {
                        "id": msg.get("id"),
                        "error": {"code": "busy", "message": "another long-running job is in progress"},
                    }
                )
                return
            job_id = str(msg.get("id"))
            self._active_job_id = job_id
            self._cancel_event.clear()
            self._worker = threading.Thread(
                target=self._run_llm_download,
                args=(job_id, msg.get("params") or {}, outbound),
                daemon=True,
            )
            self._worker.start()

    def _run_llm_download(self, job_id: str, params: dict, outbound: Queue) -> None:
        model_path = params.get("modelPath")
        repo = params.get("source") or params.get("repo")
        filename = params.get("filename")
        if not isinstance(model_path, str) or not isinstance(repo, str) or not isinstance(filename, str):
            outbound.put(
                {
                    "id": job_id,
                    "error": {"code": "invalid_params", "message": "modelPath, source, filename required"},
                }
            )
            with self._lock:
                if self._active_job_id == job_id:
                    self._active_job_id = None
            return
        try:
            def emit(processed: int, total: int) -> None:
                outbound.put(
                    {
                        "method": "progress",
                        "params": {
                            "jobId": "llm-download",
                            "processed": processed,
                            "total": total,
                        },
                    }
                )
            self._llm_engine.download_model(
                model_path=model_path,
                repo=repo,
                filename=filename,
                progress_callback=emit,
            )
            outbound.put({"id": job_id, "result": {"ok": True}})
        except Exception as e:
            outbound.put(
                {
                    "id": job_id,
                    "error": {
                        "code": "llm_download_failed",
                        "message": f"{type(e).__name__}: {e}\n{traceback.format_exc()}",
                    },
                }
            )
        finally:
            with self._lock:
                if self._active_job_id == job_id:
                    self._active_job_id = None

    def _handle_llm_model_status(self, msg: dict, outbound: Queue) -> None:
        params = msg.get("params") or {}
        model_path = params.get("modelPath")
        if not isinstance(model_path, str) or not model_path:
            outbound.put(
                {
                    "id": msg.get("id"),
                    "error": {"code": "invalid_params", "message": "modelPath is required"},
                }
            )
            return
        try:
            result = self._llm_engine.model_status(model_path)
            outbound.put({"id": msg.get("id"), "result": result})
        except Exception as e:
            outbound.put(
                {
                    "id": msg.get("id"),
                    "error": {
                        "code": "llm_model_status_failed",
                        "message": f"{type(e).__name__}: {e}",
                    },
                }
            )

    def _handle_track_faces(self, msg: dict, outbound: Queue) -> None:
        params = msg.get("params") or {}
        try:
            tracker = self._get_face_tracker()
            result = tracker.track(
                params.get("video_path"),
                fps_sample=params.get("fps_sample", 2.0),
                start_sec=params.get("start_sec", 0.0),
                end_sec=params.get("end_sec"),
            )
            outbound.put(
                {
                    "id": msg.get("id"),
                    "result": {
                        "sourceWidth": result.source_width,
                        "sourceHeight": result.source_height,
                        "frames": [
                            {"t": f.t, "cx": f.cx, "cy": f.cy}
                            for f in result.frames
                        ],
                    },
                }
            )
        except Exception as e:
            outbound.put(
                {
                    "id": msg.get("id"),
                    "error": {
                        "code": "track_faces_failed",
                        "message": f"{type(e).__name__}: {e}",
                    },
                }
            )
