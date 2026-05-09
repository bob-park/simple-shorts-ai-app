from __future__ import annotations

import threading
import time
from queue import Queue, Empty

import pytest

from shorts_sidecar.server import Server
from shorts_sidecar.whisper_engine import TranscribeProgress, TranscribeResult


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
