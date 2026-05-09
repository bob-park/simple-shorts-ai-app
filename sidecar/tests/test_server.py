from __future__ import annotations

import threading
import time
from queue import Queue, Empty

import pytest

from shorts_sidecar.server import Server
from shorts_sidecar.whisper_engine import TranscribeProgress, TranscribeResult
from shorts_sidecar.face_tracker import TrackFrame, TrackResult


class StubTracker:
    def __init__(self, result):
        self._result = result
        self.last_args: dict | None = None

    def track(self, video_path, *, fps_sample, start_sec, end_sec):
        self.last_args = {
            "video_path": video_path,
            "fps_sample": fps_sample,
            "start_sec": start_sec,
            "end_sec": end_sec,
        }
        return self._result


class StubEngine:
    """Replays a fixed yield sequence; observes cancel via callback."""

    def __init__(self, sequence):
        self._sequence = sequence
        self.last_args: dict | None = None

    @property
    def loaded_models(self):
        return ["stub"]

    def transcribe(self, audio_path, *, model, language=None, is_canceled=None):
        self.last_args = {"audio_path": audio_path, "model": model, "language": language}
        for item in self._sequence:
            if is_canceled and is_canceled():
                raise InterruptedError
            yield item


def _run_server_with(messages):
    inbound: Queue = Queue()
    outbound: Queue = Queue()
    for m in messages:
        inbound.put(m)
    inbound.put(None)  # sentinel: shut down after these
    return inbound, outbound


def _drain(outbound: Queue, timeout: float = 1.0) -> list[dict]:
    out: list[dict] = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            out.append(outbound.get(timeout=0.05))
        except Empty:
            if not out:
                continue
            break
    return out


def test_health_returns_ok_with_loaded_models_list():
    inbound, outbound = _run_server_with([{"id": "1", "method": "health"}])
    server = Server(engine=StubEngine([]))
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    assert any(m == {"id": "1", "result": {"ok": True, "modelsLoaded": ["stub"]}} for m in msgs)


def test_transcribe_emits_progress_then_final_result():
    seq = [
        TranscribeProgress(processed=1.0, total=4.0),
        TranscribeProgress(processed=4.0, total=4.0),
        TranscribeResult(segments=[{"start": 0.0, "end": 4.0, "text": "hi"}], words=[], duration=4.0, language="en"),
    ]
    inbound, outbound = _run_server_with([
        {"id": "abc", "method": "transcribe", "params": {"audio_path": "/x.mp4", "model": "small"}}
    ])
    server = Server(engine=StubEngine(seq))
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    progress_msgs = [m for m in msgs if m.get("method") == "progress"]
    final = [m for m in msgs if m.get("id") == "abc" and "result" in m]
    assert len(progress_msgs) == 2
    assert progress_msgs[0]["params"] == {"jobId": "abc", "processed": 1.0, "total": 4.0}
    assert len(final) == 1
    assert final[0]["result"]["segments"][0]["text"] == "hi"


def test_cancel_during_transcribe_emits_canceled_error():
    # Stub yields one progress then sleeps; cancel arrives mid-iteration.
    class SlowEngine:
        loaded_models = []

        def transcribe(self, audio_path, *, model, language=None, is_canceled=None):
            yield TranscribeProgress(processed=1.0, total=10.0)
            for _ in range(50):
                if is_canceled and is_canceled():
                    raise InterruptedError
                time.sleep(0.01)
            yield TranscribeResult(segments=[], words=[], duration=10.0, language="en")

    inbound: Queue = Queue()
    outbound: Queue = Queue()
    inbound.put({"id": "abc", "method": "transcribe", "params": {"audio_path": "/x.mp4", "model": "small"}})

    server = Server(engine=SlowEngine())
    server_thread = threading.Thread(target=server.run, args=(inbound, outbound), daemon=True)
    server_thread.start()

    # Wait for the first progress event to confirm transcribe is running.
    deadline = time.monotonic() + 1.0
    saw_progress = False
    while time.monotonic() < deadline and not saw_progress:
        try:
            msg = outbound.get(timeout=0.05)
            if msg.get("method") == "progress":
                saw_progress = True
            else:
                outbound.put(msg)  # not the one we wanted; put back
                break
        except Empty:
            continue
    assert saw_progress

    inbound.put({"id": "cancel-1", "method": "cancel", "params": {"jobId": "abc"}})
    inbound.put(None)
    server_thread.join(timeout=2.0)
    assert not server_thread.is_alive()

    msgs = _drain(outbound, timeout=0.3)
    cancel_resp = [m for m in msgs if m.get("id") == "abc" and "error" in m]
    assert cancel_resp and cancel_resp[0]["error"]["code"] == "canceled"


def test_unknown_method_returns_error():
    inbound, outbound = _run_server_with([{"id": "1", "method": "nope"}])
    server = Server(engine=StubEngine([]))
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    err = [m for m in msgs if m.get("id") == "1" and "error" in m]
    assert err and err[0]["error"]["code"] == "unknown_method"


def test_track_faces_returns_source_dimensions_and_frames():
    tracker = StubTracker(
        TrackResult(
            source_width=1920,
            source_height=1080,
            frames=[TrackFrame(t=0.0, cx=960.0, cy=540.0), TrackFrame(t=0.5, cx=970.0, cy=545.0)],
        )
    )
    inbound, outbound = _run_server_with(
        [
            {
                "id": "abc",
                "method": "track_faces",
                "params": {
                    "video_path": "/x.mp4",
                    "fps_sample": 2.0,
                    "start_sec": 5.0,
                    "end_sec": 35.0,
                },
            }
        ]
    )
    server = Server(engine=StubEngine([]), face_tracker=tracker)
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    final = [m for m in msgs if m.get("id") == "abc" and "result" in m]
    assert len(final) == 1
    payload = final[0]["result"]
    assert payload["sourceWidth"] == 1920
    assert payload["sourceHeight"] == 1080
    assert len(payload["frames"]) == 2
    assert payload["frames"][0] == {"t": 0.0, "cx": 960.0, "cy": 540.0}
    assert tracker.last_args == {
        "video_path": "/x.mp4",
        "fps_sample": 2.0,
        "start_sec": 5.0,
        "end_sec": 35.0,
    }


def test_track_faces_returns_empty_frames_when_no_faces_detected():
    tracker = StubTracker(TrackResult(source_width=1920, source_height=1080, frames=[]))
    inbound, outbound = _run_server_with(
        [
            {
                "id": "abc",
                "method": "track_faces",
                "params": {
                    "video_path": "/x.mp4",
                    "fps_sample": 2.0,
                    "start_sec": 0.0,
                    "end_sec": 10.0,
                },
            }
        ]
    )
    server = Server(engine=StubEngine([]), face_tracker=tracker)
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    final = [m for m in msgs if m.get("id") == "abc" and "result" in m]
    assert len(final) == 1
    assert final[0]["result"]["frames"] == []


def test_dispatches_llm_model_status_to_engine():
    class StubLlm:
        def __init__(self):
            self.called_with = None
        def model_status(self, model_path):
            self.called_with = model_path
            return {"exists": True, "sizeBytes": 999, "loaded": False}

    stub = StubLlm()
    inbound, outbound = _run_server_with([
        {"id": "x1", "method": "llm_model_status", "params": {"modelPath": "/tmp/m.gguf"}}
    ])
    server = Server(engine=StubEngine([]), llm_engine=stub)
    server.run(inbound, outbound)
    msgs = _drain(outbound)
    assert {"id": "x1", "result": {"exists": True, "sizeBytes": 999, "loaded": False}} in msgs
    assert stub.called_with == "/tmp/m.gguf"
