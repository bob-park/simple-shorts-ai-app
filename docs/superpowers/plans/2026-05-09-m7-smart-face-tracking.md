# M7: Smart Face Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M6's static center crop with a per-clip MediaPipe face tracker. For each highlight: the Python sidecar samples ~2 frames/sec across the clip's time window, picks the largest face per frame, and returns a Gaussian-smoothed sequence of crop centers. The TypeScript side translates that sequence into an ffmpeg `sendcmd` file that drives a dynamic crop in a single pass. If no faces are detected for a clip, the renderer transparently falls back to M6's center crop and notes it on the per-clip result.

**Architecture:** Adds a `face_tracker.py` module to the existing Python sidecar (alongside `whisper_engine.py`) and wires a new `track_faces` RPC method into `server.py`. Mediapipe + opencv-python become sidecar dependencies. On the TypeScript side, a new `TrackingService` (a thin facade over `PythonSidecar.request('track_faces', ...)`) gets injected into `RenderService` as an optional dependency. A pure `SendcmdGenerator` converts track frames to ffmpeg sendcmd file content. `RenderService.render()` now: (1) tracks per clip → (2) writes `<outputDir>/short_N.track.json` + `short_N.cmd` → (3) builds tracked ffmpeg args (sendcmd + named crop) or falls back to center-crop args, (4) records the choice on `RenderClipResult.tracking` for the UI. Existing M6 behavior is preserved when no tracker is injected, so the existing 6 RenderService unit tests keep passing.

**Tech Stack:** `mediapipe ^0.10` (Apache 2.0; bundles its own face detection model), `opencv-python ^4.10` (BSD; for frame seeking + iteration). Both go in `sidecar/pyproject.toml` `dependencies`. The Python tracker exposes a constructor-injected `reader_factory` and `detector_factory` so unit tests can run without the real native libs. The new ffmpeg filter chain becomes `sendcmd=f=path,crop@c=ih*9/16:ih:0:0,scale=1080:1920` where the `crop@c` named filter is updated by the sendcmd file with `<t> crop@c x <px>;` lines. Cancel + concurrency guards inherit from M6's RenderService.

---

## File Structure

```
sidecar/
├── pyproject.toml                          # MODIFY: add mediapipe + opencv-python
├── src/shorts_sidecar/
│   ├── face_tracker.py                     # NEW: VideoFrameReader + FaceTracker (DI)
│   └── server.py                           # MODIFY: add track_faces dispatch
└── tests/
    └── test_face_tracker.py                # NEW: pytest with mocked detector + reader

src/shared/
├── track.ts                                # NEW: TrackFrame, TrackResult zod schemas
└── render.ts                               # MODIFY: extend RenderClipResult.tracking field

src/main/
├── main.ts                                 # MODIFY: inject TrackingService into RenderService
├── services/
│   ├── TrackingService.ts                  # NEW: thin facade over PythonSidecar
│   ├── TrackingService.test.ts             # NEW: vitest with mocked sidecar
│   ├── SendcmdGenerator.ts                 # NEW: pure track→sendcmd content
│   ├── SendcmdGenerator.test.ts            # NEW: vitest pure tests
│   ├── RenderService.ts                    # MODIFY: optional tracker, track-or-center per clip
│   └── RenderService.test.ts               # MODIFY: existing 6 stay green; +3 new tracker tests

src/renderer/
└── components/newjob/RenderCard.tsx        # MODIFY: per-clip 'tracked N frames' / 'center crop fallback' note
```

**Decomposition rationale:**

- `face_tracker.py` keeps two clearly separated responsibilities: `VideoFrameReader` knows about cv2 (read dimensions, seek, iterate frames at a sample rate) while `FaceTracker` knows about MediaPipe (detect faces in a frame, pick the largest, smooth a sequence). Both accept factories via constructor so tests don't import cv2 or mediapipe at all.
- `SendcmdGenerator` is pure logic with no IO — it takes a `TrackResult` and emits the `<t> crop@c x <px>; <t> crop@c y <py>;` lines. Easy to unit test exhaustively.
- `TrackingService` mirrors `TranscribeService`: thin facade over the existing `PythonSidecar.request(...)` plumbing, validates the response with `TrackResultSchema`. No new sidecar transport work needed.
- `RenderService` is extended (not refactored): the constructor takes an optional `tracker` and the per-clip loop picks tracked vs center-crop args based on whether the tracker returned frames. Existing tests pass unchanged with no tracker injected.
- `RenderClipResult` grows a `tracking?: { frames: number; trackPath: string } | null` field — `null` means center-crop was used (no faces or tracker absent), object with frames > 0 means tracked. UI surfaces this as a tiny note in the `done` state.

---

## Tasks

### Task 1: Add mediapipe + opencv-python deps to sidecar

**Files:**

- Modify: `sidecar/pyproject.toml`
- Modify: `sidecar/uv.lock`

- [ ] **Step 1: Add the deps**

Edit `sidecar/pyproject.toml`. Find the `dependencies` block:

```toml
dependencies = [
  "faster-whisper>=1.0.3",
]
```

Replace with:

```toml
dependencies = [
  "faster-whisper>=1.0.3",
  "mediapipe>=0.10.18",
  "opencv-python>=4.10",
]
```

- [ ] **Step 2: Resolve + lock**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar
uv sync 2>&1 | tail -10
```

Expected: uv resolves both deps and writes them into `uv.lock`. Heavy native install (~200MB across mediapipe + opencv + their transitive deps like protobuf, numpy). First sync may take 60–120s.

If `uv sync` fails on macOS arm64 (mediapipe sometimes lags Apple Silicon wheels), confirm Python 3.11 is active (`mise current python` should show 3.11.x) and check the error. If it's a "no wheel for platform", report DONE_WITH_CONCERNS — we may need to switch to `mediapipe-silicon` fork or pin a specific version.

- [ ] **Step 3: Smoke probe**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar
uv run python -c 'import mediapipe; import cv2; print(mediapipe.__version__, cv2.__version__)'
```

Expected: prints something like `0.10.18 4.10.0`.

- [ ] **Step 4: Confirm existing pytest still passes**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar && uv run pytest 2>&1 | tail -3
```

Expected: 16 passed (no regression from M4-era tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
git add sidecar/pyproject.toml sidecar/uv.lock
git commit -m "chore(m7): add mediapipe + opencv-python sidecar deps"
```

---

### Task 2: Python face_tracker module (TDD)

**Files:**

- Create: `sidecar/src/shorts_sidecar/face_tracker.py`
- Create: `sidecar/tests/test_face_tracker.py`

`FaceTracker` is a generator/iterator-style class that takes a path + window + sample rate, walks the video at the requested fps, picks the largest detected face per sampled frame, and returns a Gaussian-smoothed sequence of `(t, cx, cy)` keyframes plus the source dimensions. Both the OpenCV reader AND the MediaPipe detector are constructor-injected via factories so tests don't need either native lib.

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_face_tracker.py` with EXACTLY this content:

```python
from __future__ import annotations

from dataclasses import dataclass

import pytest

from shorts_sidecar.face_tracker import FaceTracker, TrackResult


@dataclass
class FakeBox:
    """Mimics MediaPipe's relative bounding box (xmin/ymin/width/height as 0..1)."""

    xmin: float
    ymin: float
    width: float
    height: float


@dataclass
class FakeDetection:
    location_data_relative_bounding_box: FakeBox

    @property
    def location_data(self):
        # MediaPipe's actual API nests this — the tracker reads
        # `det.location_data.relative_bounding_box`.
        class _LD:
            relative_bounding_box = self.location_data_relative_bounding_box

        return _LD()


class FakeDetector:
    """Returns a fixed sequence of detection lists, one per process() call."""

    def __init__(self, sequence: list[list[FakeDetection]]):
        self._sequence = list(sequence)
        self.calls = 0

    def process(self, _frame):
        self.calls += 1
        if not self._sequence:
            return _Result(detections=[])
        return _Result(detections=self._sequence.pop(0))


@dataclass
class _Result:
    detections: list


class FakeReader:
    """Minimal video reader that exposes dimensions + a fixed frame count."""

    def __init__(self, width: int, height: int, frame_count: int):
        self.width = width
        self.height = height
        self.frame_count = frame_count

    def get_dimensions(self):
        return (self.width, self.height)

    def iter_frames_at(self, fps_sample: float, start_sec: float, end_sec: float | None):
        # Emit `frame_count` frames at 1.0s spacing (sample rate ignored for fakes).
        for i in range(self.frame_count):
            t = start_sec + i * 1.0
            if end_sec is not None and t > end_sec:
                break
            yield (t, f"frame_{i}")


def _bb(xmin: float, ymin: float, width: float, height: float) -> FakeDetection:
    return FakeDetection(location_data_relative_bounding_box=FakeBox(xmin, ymin, width, height))


def test_returns_source_dimensions_and_pixel_keyframes():
    detector = FakeDetector(
        [
            [_bb(0.4, 0.3, 0.2, 0.3)],  # face center: (0.5, 0.45)
            [_bb(0.4, 0.3, 0.2, 0.3)],  # same
        ]
    )
    reader = FakeReader(width=1920, height=1080, frame_count=2)
    tracker = FaceTracker(
        reader_factory=lambda _path: reader,
        detector_factory=lambda: detector,
    )
    result = tracker.track("/x.mp4", fps_sample=2.0, start_sec=0, end_sec=None)
    assert isinstance(result, TrackResult)
    assert result.source_width == 1920
    assert result.source_height == 1080
    assert len(result.frames) == 2
    # Pixel center: cx = 0.5 * 1920 = 960, cy = 0.45 * 1080 = 486
    assert result.frames[0].cx == pytest.approx(960.0, abs=1.0)
    assert result.frames[0].cy == pytest.approx(486.0, abs=1.0)


def test_picks_the_largest_face_when_multiple_detected():
    # Two faces in one frame: small (area 0.04) vs big (area 0.16). Big wins.
    detector = FakeDetector(
        [
            [
                _bb(0.1, 0.1, 0.2, 0.2),  # area 0.04, center (0.2, 0.2)
                _bb(0.5, 0.4, 0.4, 0.4),  # area 0.16, center (0.7, 0.6)
            ],
        ]
    )
    reader = FakeReader(width=1000, height=1000, frame_count=1)
    tracker = FaceTracker(
        reader_factory=lambda _path: reader,
        detector_factory=lambda: detector,
    )
    result = tracker.track("/x.mp4", fps_sample=1.0, start_sec=0, end_sec=None)
    assert len(result.frames) == 1
    assert result.frames[0].cx == pytest.approx(700.0, abs=1.0)
    assert result.frames[0].cy == pytest.approx(600.0, abs=1.0)


def test_skips_frames_with_no_detections():
    detector = FakeDetector(
        [
            [],  # no face
            [_bb(0.4, 0.3, 0.2, 0.3)],  # face
            [],  # no face
        ]
    )
    reader = FakeReader(width=1000, height=1000, frame_count=3)
    tracker = FaceTracker(
        reader_factory=lambda _path: reader,
        detector_factory=lambda: detector,
    )
    result = tracker.track("/x.mp4", fps_sample=1.0, start_sec=0, end_sec=None)
    # Only the middle frame had a face, but the tracker emits 3 keyframes total
    # — empty frames inherit the last valid coordinate (or stay at the next valid
    # one if no prior). All 3 should be present so the sendcmd timeline aligns
    # with the source video timestamps.
    assert len(result.frames) == 3
    # frame 0 (no detection) inherits frame 1's coordinate (forward-fill at start)
    assert result.frames[0].cx == pytest.approx(500.0, abs=1.0)
    # frame 1: detected
    assert result.frames[1].cx == pytest.approx(500.0, abs=1.0)
    # frame 2 (no detection) inherits frame 1's coordinate
    assert result.frames[2].cx == pytest.approx(500.0, abs=1.0)


def test_returns_empty_frames_when_no_face_ever_detected():
    detector = FakeDetector([[], [], []])
    reader = FakeReader(width=1000, height=1000, frame_count=3)
    tracker = FaceTracker(
        reader_factory=lambda _path: reader,
        detector_factory=lambda: detector,
    )
    result = tracker.track("/x.mp4", fps_sample=1.0, start_sec=0, end_sec=None)
    # No face anywhere → empty frames list (caller falls back to center crop).
    assert result.frames == []
    assert result.source_width == 1000
    assert result.source_height == 1000


def test_smoothing_dampens_jitter_between_keyframes():
    # Three frames with face jumping around. Smoothed output should be closer
    # to a moving average than to the raw values.
    detector = FakeDetector(
        [
            [_bb(0.0, 0.0, 0.2, 0.2)],  # cx=0.1
            [_bb(0.8, 0.0, 0.2, 0.2)],  # cx=0.9
            [_bb(0.0, 0.0, 0.2, 0.2)],  # cx=0.1
        ]
    )
    reader = FakeReader(width=1000, height=1000, frame_count=3)
    tracker = FaceTracker(
        reader_factory=lambda _path: reader,
        detector_factory=lambda: detector,
    )
    result = tracker.track("/x.mp4", fps_sample=1.0, start_sec=0, end_sec=None)
    # Middle frame raw cx would be 900 (0.9 * 1000). Smoothed should be pulled
    # toward the neighbours' 100 → middle smoothed cx is between 100 and 900.
    middle = result.frames[1].cx
    assert 200 < middle < 800, f"middle cx {middle} should be smoothed away from 900"


def test_passes_start_and_end_sec_through_to_reader():
    captured = {}

    def fake_reader_factory(path):
        class R:
            def get_dimensions(self):
                return (1000, 1000)

            def iter_frames_at(self, fps_sample, start_sec, end_sec):
                captured["fps_sample"] = fps_sample
                captured["start_sec"] = start_sec
                captured["end_sec"] = end_sec
                return iter([])

        return R()

    tracker = FaceTracker(
        reader_factory=fake_reader_factory,
        detector_factory=lambda: FakeDetector([]),
    )
    tracker.track("/x.mp4", fps_sample=2.0, start_sec=10, end_sec=40)
    assert captured == {"fps_sample": 2.0, "start_sec": 10, "end_sec": 40}
```

- [ ] **Step 2: Run tests — they should fail**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar
uv run pytest tests/test_face_tracker.py -v
```

Expected: ImportError on `shorts_sidecar.face_tracker`.

- [ ] **Step 3: Implement `sidecar/src/shorts_sidecar/face_tracker.py`**

```python
"""Per-clip face tracking with MediaPipe + Gaussian smoothing.

Both the OpenCV reader and the MediaPipe detector are injected via factories
so unit tests can run without either native dep.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Protocol


class _ReaderLike(Protocol):
    def get_dimensions(self) -> tuple[int, int]: ...
    def iter_frames_at(
        self,
        fps_sample: float,
        start_sec: float,
        end_sec: float | None,
    ) -> Iterator[tuple[float, Any]]: ...


class _DetectorLike(Protocol):
    def process(self, frame: Any) -> Any: ...


ReaderFactory = Callable[[str], _ReaderLike]
DetectorFactory = Callable[[], _DetectorLike]


@dataclass
class TrackFrame:
    """One sampled keyframe. cx/cy are in pixel coordinates of the source."""

    t: float
    cx: float
    cy: float


@dataclass
class TrackResult:
    source_width: int
    source_height: int
    frames: list[TrackFrame] = field(default_factory=list)


def _default_reader(path: str) -> _ReaderLike:  # pragma: no cover - integration only
    import cv2

    class _CvReader:
        def __init__(self, p: str):
            self._cap = cv2.VideoCapture(p)
            self._fps = self._cap.get(cv2.CAP_PROP_FPS) or 30.0
            self._width = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            self._height = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        def get_dimensions(self) -> tuple[int, int]:
            return (self._width, self._height)

        def iter_frames_at(
            self,
            fps_sample: float,
            start_sec: float,
            end_sec: float | None,
        ) -> Iterator[tuple[float, Any]]:
            self._cap.set(cv2.CAP_PROP_POS_MSEC, start_sec * 1000.0)
            interval = 1.0 / fps_sample
            current_t = start_sec
            while True:
                if end_sec is not None and current_t > end_sec:
                    return
                ok, frame = self._cap.read()
                if not ok:
                    return
                actual_t = self._cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
                if actual_t < current_t - interval:
                    continue  # haven't reached the next sample yet
                yield (current_t, frame)
                current_t += interval

    return _CvReader(path)


def _default_detector() -> _DetectorLike:  # pragma: no cover - integration only
    import mediapipe as mp

    return mp.solutions.face_detection.FaceDetection(
        model_selection=1,  # 1 = full-range (works at any distance)
        min_detection_confidence=0.5,
    )


def _gaussian_kernel(window: int = 5, sigma: float = 1.0) -> list[float]:
    """Pure-Python Gaussian kernel — no numpy needed."""
    import math

    half = window // 2
    weights = [math.exp(-(i - half) ** 2 / (2 * sigma ** 2)) for i in range(window)]
    total = sum(weights)
    return [w / total for w in weights]


def _smooth(values: list[float], kernel: list[float]) -> list[float]:
    if not values:
        return []
    half = len(kernel) // 2
    n = len(values)
    out: list[float] = []
    for i in range(n):
        acc = 0.0
        wsum = 0.0
        for k, w in enumerate(kernel):
            j = i + k - half
            if j < 0 or j >= n:
                continue
            acc += w * values[j]
            wsum += w
        out.append(acc / wsum if wsum > 0 else values[i])
    return out


class FaceTracker:
    """Walks a video clip, picks the largest face per sampled frame, smooths."""

    def __init__(
        self,
        reader_factory: ReaderFactory = _default_reader,
        detector_factory: DetectorFactory = _default_detector,
        smoothing_window: int = 5,
        smoothing_sigma: float = 1.0,
    ) -> None:
        self._reader_factory = reader_factory
        self._detector_factory = detector_factory
        self._kernel = _gaussian_kernel(smoothing_window, smoothing_sigma)

    def track(
        self,
        video_path: str,
        *,
        fps_sample: float,
        start_sec: float,
        end_sec: float | None,
    ) -> TrackResult:
        reader = self._reader_factory(video_path)
        width, height = reader.get_dimensions()
        detector = self._detector_factory()

        # First pass: collect raw (t, cx_frac, cy_frac) per sampled frame, with
        # `None` when the detector returns no faces. We forward-fill on the
        # second pass.
        raw: list[tuple[float, tuple[float, float] | None]] = []
        for t, frame in reader.iter_frames_at(fps_sample, start_sec, end_sec):
            result = detector.process(frame)
            detections = getattr(result, "detections", None) or []
            if not detections:
                raw.append((t, None))
                continue
            largest = max(
                detections,
                key=lambda d: _box_area(d),
            )
            box = d_to_box(largest)
            cx_frac = box.xmin + box.width / 2.0
            cy_frac = box.ymin + box.height / 2.0
            raw.append((t, (cx_frac, cy_frac)))

        # Forward/backward fill empty samples. If every sample is empty, return
        # no frames so the caller can fall back to center crop.
        valid = [c for _t, c in raw if c is not None]
        if not valid:
            return TrackResult(source_width=width, source_height=height, frames=[])
        first_valid = valid[0]
        filled: list[tuple[float, tuple[float, float]]] = []
        last: tuple[float, float] = first_valid
        for t, c in raw:
            if c is not None:
                last = c
            filled.append((t, last))

        # Smooth cx and cy independently in pixel space.
        ts = [t for t, _ in filled]
        cx_px = [c[0] * width for _, c in filled]
        cy_px = [c[1] * height for _, c in filled]
        cx_smoothed = _smooth(cx_px, self._kernel)
        cy_smoothed = _smooth(cy_px, self._kernel)
        frames = [
            TrackFrame(t=ts[i], cx=cx_smoothed[i], cy=cy_smoothed[i])
            for i in range(len(ts))
        ]
        return TrackResult(source_width=width, source_height=height, frames=frames)


def _box_area(detection: Any) -> float:
    box = d_to_box(detection)
    return box.width * box.height


def d_to_box(detection: Any):
    """Extract the relative bounding box from a MediaPipe detection or fake."""
    return detection.location_data.relative_bounding_box
```

- [ ] **Step 4: Run tests — should pass 6/6**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar
uv run pytest tests/test_face_tracker.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Confirm full pytest suite passes**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar
uv run pytest -v 2>&1 | tail -5
```

Expected: 22 passed (16 prior + 6 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
git add sidecar/src/shorts_sidecar/face_tracker.py sidecar/tests/test_face_tracker.py
git commit -m "feat(m7): add FaceTracker with mediapipe + cv2 factories and gaussian smoothing"
```

---

### Task 3: Wire track_faces into the sidecar Server (TDD)

**Files:**

- Modify: `sidecar/src/shorts_sidecar/server.py`
- Modify: `sidecar/tests/test_server.py`

The Server already dispatches `health` / `transcribe` / `cancel`. Add `track_faces`. Tests use a stub tracker (same DI pattern as the existing StubEngine).

- [ ] **Step 1: Extend test file with new cases**

Open `sidecar/tests/test_server.py`. The current `Server(engine=...)` takes a single engine. We need to add an optional `face_tracker=...`. Add this stub class near `StubEngine` (top of the file, after the existing `StubEngine`):

```python
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
```

Add this import at the top of the test file (alongside the existing imports from `whisper_engine`):

```python
from shorts_sidecar.face_tracker import TrackFrame, TrackResult
```

Append two new tests to the end of the file (after the existing `test_unknown_method_returns_error`):

```python
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
```

- [ ] **Step 2: Run tests — should fail**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar
uv run pytest tests/test_server.py -v
```

Expected: TypeError or argument-not-recognized on `face_tracker=` kwarg, OR `unknown_method` error from the dispatch.

- [ ] **Step 3: Extend `sidecar/src/shorts_sidecar/server.py`**

Find the `Server` class. Update its `__init__`:

```python
def __init__(self, engine: Any | None = None, face_tracker: Any | None = None) -> None:
    self._engine = engine if engine is not None else WhisperEngine()
    self._face_tracker = face_tracker
    self._cancel_event = threading.Event()
    self._active_job_id: str | None = None
    self._worker: threading.Thread | None = None
    self._lock = threading.Lock()
```

Add a lazy default for `face_tracker` BELOW the existing methods (so tests can inject a stub but real usage gets a real tracker):

```python
def _get_face_tracker(self):
    if self._face_tracker is None:
        from .face_tracker import FaceTracker

        self._face_tracker = FaceTracker()
    return self._face_tracker
```

Find the `_dispatch` method. After the existing `if method == "cancel":` block and BEFORE the `# Unknown method` fallback, add:

```python
if method == "track_faces":
    self._handle_track_faces(msg, outbound)
    return
```

Add the handler method below `_run_transcribe`:

```python
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
```

(Note the snake_case → camelCase translation at the boundary: `source_width` → `sourceWidth`. The TypeScript side uses camelCase so the JSON-RPC payload follows JS conventions.)

- [ ] **Step 4: Run tests — should pass 6/6 server tests**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar
uv run pytest tests/test_server.py -v
```

Expected: 6 passed (4 prior + 2 new).

- [ ] **Step 5: Confirm full pytest suite passes**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app/sidecar
uv run pytest 2>&1 | tail -3
```

Expected: 24 passed (22 prior + 2 new server tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
git add sidecar/src/shorts_sidecar/server.py sidecar/tests/test_server.py
git commit -m "feat(m7): add track_faces RPC method to sidecar server"
```

---

### Task 4: Shared Track types (zod)

**Files:**

- Create: `src/shared/track.ts`

- [ ] **Step 1: Create `src/shared/track.ts` with EXACTLY this content**

```ts
import { z } from 'zod';

/** One sampled keyframe in source pixel coordinates. */
export const TrackFrameSchema = z.object({
  /** Seconds from the start of the source video (NOT clip-relative). */
  t: z.number().nonnegative(),
  /** Face center x in source pixels. */
  cx: z.number().nonnegative(),
  /** Face center y in source pixels. */
  cy: z.number().nonnegative(),
});
export type TrackFrame = z.infer<typeof TrackFrameSchema>;

/**
 * Result of a `track_faces` RPC call. `frames` is empty when no face was ever
 * detected in the requested window — the caller should fall back to center
 * crop in that case.
 */
export const TrackResultSchema = z.object({
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  frames: z.array(TrackFrameSchema),
});
export type TrackResult = z.infer<typeof TrackResultSchema>;
```

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/shared/track.ts
yarn lint && yarn typecheck
```

Expected: lint 0 errors (1 known `__dirname` warning OK), typecheck 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/track.ts
git commit -m "feat(m7): add shared Track zod schemas"
```

---

### Task 5: TrackingService thin facade (TDD)

**Files:**

- Create: `src/main/services/TrackingService.ts`
- Create: `src/main/services/TrackingService.test.ts`

`TrackingService` is the M7 analog of `TranscribeService`: thin facade over `PythonSidecar.request('track_faces', ...)` with zod validation.

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/TrackingService.test.ts` with EXACTLY this content:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TrackingService } from './TrackingService';

const validRaw = {
  sourceWidth: 1920,
  sourceHeight: 1080,
  frames: [
    { t: 0.0, cx: 960.0, cy: 540.0 },
    { t: 0.5, cx: 970.0, cy: 545.0 },
  ],
};

describe('TrackingService', () => {
  let request: ReturnType<typeof vi.fn>;
  let sidecar: { request: typeof request };
  let service: TrackingService;

  beforeEach(() => {
    request = vi.fn();
    sidecar = { request };
    service = new TrackingService(sidecar as never);
  });

  it('calls sidecar.request with track_faces and the right params', async () => {
    request.mockResolvedValue(validRaw);
    const result = await service.track('/tmp/x.mp4', { startSec: 5, endSec: 35, fpsSample: 2 });
    expect(request).toHaveBeenCalledWith('track_faces', {
      video_path: '/tmp/x.mp4',
      start_sec: 5,
      end_sec: 35,
      fps_sample: 2,
    });
    expect(result.sourceWidth).toBe(1920);
    expect(result.frames).toHaveLength(2);
  });

  it('defaults fps_sample to 2.0 when not provided', async () => {
    request.mockResolvedValue(validRaw);
    await service.track('/tmp/x.mp4', { startSec: 0, endSec: 10 });
    expect(request).toHaveBeenCalledWith('track_faces', {
      video_path: '/tmp/x.mp4',
      start_sec: 0,
      end_sec: 10,
      fps_sample: 2.0,
    });
  });

  it('rejects malformed payloads via the schema', async () => {
    request.mockResolvedValue({ sourceWidth: 'not a number' });
    await expect(service.track('/x.mp4', { startSec: 0, endSec: 10 })).rejects.toThrow();
  });

  it('accepts an empty frames array (no faces detected)', async () => {
    request.mockResolvedValue({ sourceWidth: 1920, sourceHeight: 1080, frames: [] });
    const result = await service.track('/x.mp4', { startSec: 0, endSec: 10 });
    expect(result.frames).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/TrackingService.test.ts
```

- [ ] **Step 3: Implement `src/main/services/TrackingService.ts` with EXACTLY this content**

```ts
import { type TrackResult, TrackResultSchema } from '@shared/track';

interface SidecarLike {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface TrackOptions {
  /** Seconds from start of source video (inclusive). */
  startSec: number;
  /** Seconds from start of source video (inclusive). */
  endSec: number;
  /** Frames sampled per second; default 2.0. */
  fpsSample?: number;
}

/**
 * Thin facade over the Python sidecar's `track_faces` RPC. Validates the
 * response with `TrackResultSchema` so downstream code can trust the shape.
 */
export class TrackingService {
  constructor(private readonly sidecar: SidecarLike) {}

  async track(videoPath: string, opts: TrackOptions): Promise<TrackResult> {
    const raw = await this.sidecar.request<unknown>('track_faces', {
      video_path: videoPath,
      start_sec: opts.startSec,
      end_sec: opts.endSec,
      fps_sample: opts.fpsSample ?? 2.0,
    });
    return TrackResultSchema.parse(raw);
  }
}
```

- [ ] **Step 4: Run — should pass 4/4**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/TrackingService.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/TrackingService.ts src/main/services/TrackingService.test.ts
git add src/main/services/TrackingService.ts src/main/services/TrackingService.test.ts
git commit -m "feat(m7): add TrackingService thin facade over PythonSidecar"
```

---

### Task 6: SendcmdGenerator pure logic (TDD)

**Files:**

- Create: `src/main/services/SendcmdGenerator.ts`
- Create: `src/main/services/SendcmdGenerator.test.ts`

Pure function that converts a `TrackResult` + clip start time into ffmpeg sendcmd file content. No IO. Time values in the output are clip-relative (sendcmd's `t` is the time in the filtered video, not the source video).

The crop box is `crop=ih*9/16:ih:x:y` where `x = clamp(cx - crop_w/2, 0, source_width - crop_w)` and `y` is fixed at 0 (we use the full source height). The named filter `crop@c` lets sendcmd address it.

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/SendcmdGenerator.test.ts` with EXACTLY this content:

```ts
import type { TrackResult } from '@shared/track';
import { describe, expect, it } from 'vitest';

import { buildSendcmd } from './SendcmdGenerator';

function track(frames: { t: number; cx: number; cy: number }[]): TrackResult {
  return { sourceWidth: 1920, sourceHeight: 1080, frames };
}

describe('buildSendcmd', () => {
  it('emits one crop@c x line per frame, time rebased to clip-relative', () => {
    // Source-time frames at 5.0 / 5.5 / 6.0; clip starts at 5.0.
    const out = buildSendcmd(
      track([
        { t: 5.0, cx: 960, cy: 540 },
        { t: 5.5, cx: 970, cy: 545 },
        { t: 6.0, cx: 980, cy: 550 },
      ]),
      5.0,
    );
    const lines = out.split('\n').filter((l) => l.trim());
    // Three frames → three sendcmd entries.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^0(?:\.0+)?\s+crop@c x \d+/);
    expect(lines[1]).toMatch(/^0\.5\s+crop@c x \d+/);
    expect(lines[2]).toMatch(/^1(?:\.0+)?\s+crop@c x \d+/);
  });

  it('computes crop x as clamp(cx - cropW/2, 0, sourceWidth - cropW)', () => {
    // crop_w = 1080 * 9/16 = 607.5 → use 607 (rounded down)
    // For cx = 960 (centered): x = 960 - 607/2 = 960 - 303 = 657 (rounded)
    const out = buildSendcmd(track([{ t: 0, cx: 960, cy: 540 }]), 0);
    expect(out).toMatch(/crop@c x 657/);
  });

  it('clamps crop x at 0 when cx is at the left edge', () => {
    const out = buildSendcmd(track([{ t: 0, cx: 50, cy: 540 }]), 0);
    expect(out).toMatch(/crop@c x 0/);
  });

  it('clamps crop x at sourceWidth - cropW when cx is at the right edge', () => {
    // crop_w = 607, source_width = 1920 → max x = 1920 - 607 = 1313
    const out = buildSendcmd(track([{ t: 0, cx: 1900, cy: 540 }]), 0);
    expect(out).toMatch(/crop@c x 1313/);
  });

  it('returns an empty string for empty frames (caller falls back to center)', () => {
    const out = buildSendcmd(track([]), 0);
    expect(out).toBe('');
  });

  it('throws when source aspect ratio is already vertical (cropW > sourceWidth)', () => {
    // 1080×1920 source: crop_w would be 1920 * 9/16 = 1080, equals source width
    // → still works (max x = 0). But 1000×2000: crop_w = 1125, > 1000 → throw.
    const portrait: TrackResult = {
      sourceWidth: 1000,
      sourceHeight: 2000,
      frames: [{ t: 0, cx: 500, cy: 1000 }],
    };
    expect(() => buildSendcmd(portrait, 0)).toThrow(/already 9:16 or taller/i);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/SendcmdGenerator.test.ts
```

- [ ] **Step 3: Implement `src/main/services/SendcmdGenerator.ts` with EXACTLY this content**

```ts
import type { TrackResult } from '@shared/track';

/**
 * Build the contents of an ffmpeg sendcmd file that drives a named `crop@c`
 * filter to follow the tracked face center over time.
 *
 * Time values in the output are clip-relative (rebased by `clipStartSec`)
 * because sendcmd's leading numeric column is the filter graph's time, not
 * the source video's time. Pixel `x` is clamped to `[0, sourceWidth - cropW]`
 * so the crop box never escapes the source frame. Returns an empty string
 * when frames is empty so the caller can fall back to the M6 center crop.
 */
export function buildSendcmd(track: TrackResult, clipStartSec: number): string {
  if (track.frames.length === 0) return '';
  const cropW = Math.floor((track.sourceHeight * 9) / 16);
  if (cropW > track.sourceWidth) {
    throw new Error(
      `SendcmdGenerator: source is already 9:16 or taller (sourceWidth=${track.sourceWidth}, ` +
        `sourceHeight=${track.sourceHeight}, cropW=${cropW})`,
    );
  }
  const maxX = track.sourceWidth - cropW;
  const lines: string[] = [];
  for (const frame of track.frames) {
    const tRel = Math.max(0, frame.t - clipStartSec);
    const xRaw = Math.round(frame.cx - cropW / 2);
    const xClamped = Math.min(maxX, Math.max(0, xRaw));
    lines.push(`${tRel} crop@c x ${xClamped};`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run — should pass 6/6**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/SendcmdGenerator.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/SendcmdGenerator.ts src/main/services/SendcmdGenerator.test.ts
git add src/main/services/SendcmdGenerator.ts src/main/services/SendcmdGenerator.test.ts
git commit -m "feat(m7): add SendcmdGenerator pure logic for ffmpeg dynamic crop"
```

---

### Task 7: Extend RenderClipResult with optional tracking field

**Files:**

- Modify: `src/shared/render.ts`

The UI will display "tracked N frames" or "center crop fallback" per clip. Add the optional field to the existing schema.

- [ ] **Step 1: Add the field**

Open `src/shared/render.ts`. Find the `RenderClipResultSchema` definition. Add this field BEFORE the closing `})`:

```ts
  /**
   * If face tracking was attempted: number of keyframes used and the path of
   * the persisted track JSON. Absent when tracker was not provided OR when no
   * faces were detected (caller used the M6 center-crop fallback).
   */
  tracking: z
    .object({
      frames: z.number().int().nonnegative(),
      trackPath: z.string().min(1),
    })
    .nullish(),
```

(`.nullish()` accepts both `null` and `undefined` for backward compat with existing test fixtures.)

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/shared/render.ts
yarn lint && yarn typecheck && yarn test 2>&1 | tail -5
```

Expected: lint clean, typecheck clean, all tests pass (existing fixtures don't include `tracking` — `.nullish()` makes that fine).

- [ ] **Step 3: Commit**

```bash
git add src/shared/render.ts
git commit -m "feat(m7): add optional tracking field to RenderClipResult schema"
```

---

### Task 8: Extend RenderService with optional tracker (TDD)

**Files:**

- Modify: `src/main/services/RenderService.ts`
- Modify: `src/main/services/RenderService.test.ts`

The flow per clip becomes:

1. If a tracker is configured AND we haven't been canceled, call `tracker.track(sourcePath, { startSec, endSec })`.
2. If `frames.length > 0`: build the sendcmd content via `buildSendcmd`, write it to `${outputDir}/short_N.cmd`, also write the raw track JSON to `${outputDir}/short_N.track.json`, build "tracked args" (sendcmd + named crop). Result records `tracking: { frames, trackPath }`.
3. If `frames.length === 0` OR tracker call throws: fall back to M6 center-crop args. Result records `tracking: null`.

Tracking failure (throw) does NOT fail the clip — we just fall back. The existing 6 tests in `RenderService.test.ts` use no tracker so they keep passing.

- [ ] **Step 1: Add new test cases to `src/main/services/RenderService.test.ts`**

After the existing tests (`'returns immediately with empty results when given an empty highlights list'`), append:

```ts
function fakeTracker(result: {
  sourceWidth: number;
  sourceHeight: number;
  frames: { t: number; cx: number; cy: number }[];
}) {
  return {
    track: vi.fn(async () => result),
  };
}

describe('RenderService with tracker', () => {
  let run: ReturnType<typeof vi.fn>;
  let runner: { run: typeof run };

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
  });

  it('uses sendcmd args when tracker returns frames and writes track + cmd files', async () => {
    const writeFile = vi.fn(async () => undefined);
    const fs = { writeFile };
    const tracker = fakeTracker({
      sourceWidth: 1920,
      sourceHeight: 1080,
      frames: [
        { t: 0, cx: 960, cy: 540 },
        { t: 0.5, cx: 970, cy: 545 },
      ],
    });
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
    });
    h._resolve();
    const result = await promise;

    // Two files written: short_1.cmd and short_1.track.json
    expect(writeFile).toHaveBeenCalledTimes(2);
    const writePaths = writeFile.mock.calls.map((c: unknown[]) => c[0]);
    expect(writePaths).toContain('/tmp/out/short_1.cmd');
    expect(writePaths).toContain('/tmp/out/short_1.track.json');

    // ffmpeg args use sendcmd + named crop
    const args: string[] = run.mock.calls[0]![0].args;
    const vfIndex = args.indexOf('-vf');
    expect(vfIndex).toBeGreaterThan(-1);
    expect(args[vfIndex + 1]).toMatch(/sendcmd=f=\/tmp\/out\/short_1\.cmd,crop@c=ih\*9\/16:ih:0:0,scale=1080:1920/);

    // RenderClipResult.tracking populated
    expect(result.results[0]!.tracking).toEqual({ frames: 2, trackPath: '/tmp/out/short_1.track.json' });
    expect(result.results[0]!.status).toBe('done');
  });

  it('falls back to center crop when tracker returns empty frames', async () => {
    const writeFile = vi.fn(async () => undefined);
    const fs = { writeFile };
    const tracker = fakeTracker({ sourceWidth: 1920, sourceHeight: 1080, frames: [] });
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
    });
    h._resolve();
    const result = await promise;

    // No track files written
    expect(writeFile).not.toHaveBeenCalled();
    // Args use the M6 static center crop
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.tracking).toBeNull();
    expect(result.results[0]!.status).toBe('done');
  });

  it('falls back to center crop when tracker.track throws (and clip still succeeds)', async () => {
    const writeFile = vi.fn(async () => undefined);
    const fs = { writeFile };
    const tracker = {
      track: vi.fn(async () => {
        throw new Error('tracker explosion');
      }),
    };
    const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
    const h = fakeRunHandle();
    run.mockReturnValue(h);

    const promise = service.render({
      sourcePath: '/tmp/in.mp4',
      outputDir: '/tmp/out',
      highlights: [fakeHighlight(1, 0, 30)],
    });
    h._resolve();
    const result = await promise;

    // Same fallback path as empty frames
    expect(writeFile).not.toHaveBeenCalled();
    const args: string[] = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
    expect(result.results[0]!.tracking).toBeNull();
    expect(result.results[0]!.status).toBe('done');
  });
});
```

(Note the existing `describe('RenderService', ...)` block stays untouched — its tests construct `new RenderService(runner)` with no second argument, so the existing 6 tests still cover the M6 center-crop path.)

- [ ] **Step 2: Run — should fail (3 new tests)**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/RenderService.test.ts
```

Expected: 6 existing pass, 3 new fail.

- [ ] **Step 3: Modify `src/main/services/RenderService.ts`**

Replace the file with EXACTLY this content (additive — preserves the buildArgs function for the center-crop path, adds buildTrackedArgs for the tracked path):

```ts
import type { Highlight } from '@shared/highlight';
import type { RenderClipResult, RenderProgress, RenderResult } from '@shared/render';
import type { TrackResult } from '@shared/track';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

import { buildSendcmd } from './SendcmdGenerator';

interface RunnerLike {
  run(opts: { args: readonly string[]; durationSec: number }): {
    onProgress(cb: (f: number) => void): void;
    cancel(): void;
    done: Promise<void>;
  };
}

interface TrackerLike {
  track(videoPath: string, opts: { startSec: number; endSec: number; fpsSample?: number }): Promise<TrackResult>;
}

type FsLike = Pick<typeof fsPromises, 'writeFile'>;

export interface RenderServiceOptions {
  /** When provided, each clip is tracked before rendering. */
  tracker?: TrackerLike;
  /** Injected for tests. Defaults to the real fs.promises. */
  fs?: FsLike;
}

export interface RenderOptions {
  sourcePath: string;
  outputDir: string;
  highlights: Highlight[];
}

type ProgressHandler = (p: RenderProgress) => void;

const CENTER_CROP_FILTER = 'crop=ih*9/16:ih,scale=1080:1920';

/**
 * Walks a highlights array sequentially, producing one .mp4 per highlight.
 * - If a tracker is configured, each clip is face-tracked and rendered with
 *   a dynamic sendcmd-driven crop. If tracking returns no frames or throws,
 *   the clip falls back to the M6 static center crop and its `tracking` field
 *   is `null`.
 * - Cancel aborts the active ffmpeg child + marks queue tail as 'canceled'.
 * - A failed clip (ffmpeg error) is recorded and the queue continues.
 */
export class RenderService {
  private progressHandlers: ProgressHandler[] = [];
  private activeHandle: ReturnType<RunnerLike['run']> | null = null;
  private canceled = false;
  private readonly tracker?: TrackerLike;
  private readonly fs: FsLike;

  constructor(
    private readonly runner: RunnerLike,
    options: RenderServiceOptions = {},
  ) {
    this.tracker = options.tracker;
    this.fs = options.fs ?? fsPromises;
  }

  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.push(handler);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((h) => h !== handler);
    };
  }

  cancel(): void {
    this.canceled = true;
    this.activeHandle?.cancel();
  }

  async render(opts: RenderOptions): Promise<RenderResult> {
    this.canceled = false;
    const results: RenderClipResult[] = [];
    const total = opts.highlights.length;

    for (let i = 0; i < opts.highlights.length; i++) {
      const h = opts.highlights[i]!;
      const clipIndex = i + 1;
      if (this.canceled) {
        results.push(this.buildClipResult(clipIndex, h, 'canceled', undefined, 'Render canceled'));
        continue;
      }
      const outputPath = join(opts.outputDir, `short_${clipIndex}.mp4`);
      const durationSec = h.end_sec - h.start_sec;

      const trackingInfo = await this.maybeTrackAndPersist(opts, h, clipIndex);
      const args =
        trackingInfo !== null
          ? buildTrackedArgs(opts.sourcePath, h, outputPath, trackingInfo.cmdPath)
          : buildCenterArgs(opts.sourcePath, h, outputPath);

      const handle = this.runner.run({ args, durationSec });
      this.activeHandle = handle;
      handle.onProgress((fraction) => {
        for (const cb of this.progressHandlers) {
          cb({ clipIndex, clipTotal: total, fraction });
        }
      });
      try {
        await handle.done;
        results.push(
          this.buildClipResult(
            clipIndex,
            h,
            'done',
            outputPath,
            undefined,
            trackingInfo ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath } : null,
          ),
        );
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        if (this.canceled || /canceled/i.test(message)) {
          results.push(this.buildClipResult(clipIndex, h, 'canceled', undefined, 'Render canceled'));
        } else {
          results.push(this.buildClipResult(clipIndex, h, 'failed', undefined, message));
        }
      } finally {
        this.activeHandle = null;
      }
    }

    return { outputDir: opts.outputDir, results };
  }

  private async maybeTrackAndPersist(
    opts: RenderOptions,
    h: Highlight,
    clipIndex: number,
  ): Promise<{ cmdPath: string; trackPath: string; frameCount: number } | null> {
    if (!this.tracker) return null;
    let track: TrackResult;
    try {
      track = await this.tracker.track(opts.sourcePath, {
        startSec: h.start_sec,
        endSec: h.end_sec,
      });
    } catch {
      // Tracking failure is non-fatal — clip falls back to center crop.
      return null;
    }
    if (track.frames.length === 0) return null;
    const cmdPath = join(opts.outputDir, `short_${clipIndex}.cmd`);
    const trackPath = join(opts.outputDir, `short_${clipIndex}.track.json`);
    const cmdContent = buildSendcmd(track, h.start_sec);
    await this.fs.writeFile(cmdPath, cmdContent, 'utf8');
    await this.fs.writeFile(trackPath, JSON.stringify(track, null, 2), 'utf8');
    return { cmdPath, trackPath, frameCount: track.frames.length };
  }

  private buildClipResult(
    index: number,
    h: Highlight,
    status: RenderClipResult['status'],
    outputPath?: string,
    error?: string,
    tracking?: RenderClipResult['tracking'],
  ): RenderClipResult {
    return {
      index,
      title: h.title,
      startSec: h.start_sec,
      endSec: h.end_sec,
      status,
      outputPath,
      error,
      tracking,
    };
  }
}

const COMMON_ENCODE_ARGS = [
  '-c:v',
  'libx264',
  '-preset',
  'fast',
  '-crf',
  '23',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-progress',
  'pipe:2',
];

function buildCenterArgs(sourcePath: string, h: Highlight, outputPath: string): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-ss',
    String(h.start_sec),
    '-to',
    String(h.end_sec),
    '-vf',
    CENTER_CROP_FILTER,
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}

function buildTrackedArgs(sourcePath: string, h: Highlight, outputPath: string, cmdPath: string): string[] {
  const filter = `sendcmd=f=${cmdPath},crop@c=ih*9/16:ih:0:0,scale=1080:1920`;
  return [
    '-y',
    '-i',
    sourcePath,
    '-ss',
    String(h.start_sec),
    '-to',
    String(h.end_sec),
    '-vf',
    filter,
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}
```

- [ ] **Step 4: Run — should pass 9/9**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/RenderService.test.ts
```

Expected: 9 passed (6 existing + 3 new).

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git add src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git commit -m "feat(m7): extend RenderService with optional tracker + sendcmd path"
```

---

### Task 9: Wire TrackingService into main.ts

**Files:**

- Modify: `src/main/main.ts`

`getRenderService()` currently builds `new RenderService(ffmpegRunner)`. Inject the tracker so M7 face tracking is on by default.

- [ ] **Step 1: Add TrackingService import**

In `src/main/main.ts`, add to the relative imports block (alphabetical placement — after `RenderService`):

```ts
import { TrackingService } from './services/TrackingService';
```

- [ ] **Step 2: Add module-level state**

After the existing `let renderInFlight = false;` line, add:

```ts
let trackingService: TrackingService | null = null;
```

- [ ] **Step 3: Update getRenderService**

Find the existing `getRenderService()` helper. Update it to construct + inject the tracker:

```ts
function getRenderService(): RenderService {
  if (renderService) return renderService;
  ffmpegRunner = new FfmpegRunner({ spawn });
  // Tracking goes through the same Python sidecar that owns transcribe (lazy
  // boot on first call). Reuse the existing PythonSidecar instance if it's
  // already been spun up by transcribe; otherwise this triggers it.
  const sidecar = pythonSidecar ?? (getTranscribeService(), pythonSidecar);
  if (!sidecar) {
    throw new Error('PythonSidecar failed to initialise');
  }
  trackingService = new TrackingService(sidecar);
  renderService = new RenderService(ffmpegRunner, { tracker: trackingService });
  renderProgressUnsub = renderService.onProgress((p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('render:progress', p);
    }
  });
  return renderService;
}
```

(Note: `pythonSidecar` is the module-level variable already declared in main.ts — set by `getTranscribeService()`. If transcribe hasn't been called yet, calling `getTranscribeService()` once boots the sidecar and assigns it.)

- [ ] **Step 4: Cleanup in window-all-closed**

Find the existing render cleanup block:

```ts
renderProgressUnsub?.();
renderProgressUnsub = null;
renderService?.cancel();
renderService = null;
ffmpegRunner = null;
```

Add `trackingService = null;` after `ffmpegRunner = null;`:

```ts
renderProgressUnsub?.();
renderProgressUnsub = null;
renderService?.cancel();
renderService = null;
ffmpegRunner = null;
trackingService = null;
```

- [ ] **Step 5: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/main/main.ts
yarn lint && yarn typecheck && yarn test 2>&1 | tail -8
```

Expected: lint 0 errors, typecheck 0 errors, all tests pass (no regressions). Test count should be 110 (M6 baseline) + 4 TrackingService + 6 SendcmdGenerator + 3 RenderService = 123 vitest. Plus 24 sidecar pytest.

- [ ] **Step 6: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(m7): inject TrackingService into RenderService at lazy-init time"
```

---

### Task 10: Surface per-clip tracking status in RenderCard

**Files:**

- Modify: `src/renderer/components/newjob/RenderCard.tsx`

Show a small note next to each `done` clip indicating whether tracking succeeded.

- [ ] **Step 1: Update the per-clip li in the done state**

In `src/renderer/components/newjob/RenderCard.tsx`, find the `props.status === 'done'` block. The current per-clip `<li>` looks like:

```tsx
<li key={r.index} className={`p-md rounded-lg ${r.status === 'done' ? 'bg-surface' : 'bg-warning-bg'}`}>
  <p className="text-body-md text-ink font-semibold">
    #{r.index} {r.title}{' '}
    <span className="text-body-sm text-slate font-normal">
      {r.status === 'done' ? '✓ 완료' : r.status === 'canceled' ? '⊘ 취소됨' : '✗ 실패'}
    </span>
  </p>
  {r.outputPath ? <p className="text-body-sm text-slate mt-xs break-all">{r.outputPath}</p> : null}
  {r.error ? <p className="text-body-sm text-brand-coral mt-xs">{r.error}</p> : null}
</li>
```

Add a tracking note line AFTER the outputPath line and BEFORE the error line:

```tsx
{
  r.status === 'done' && r.tracking ? (
    <p className="text-body-sm text-slate mt-xs">🎯 얼굴 추적 {r.tracking.frames}프레임</p>
  ) : null;
}
{
  r.status === 'done' && r.tracking === null ? (
    <p className="text-body-sm text-slate mt-xs">⊕ 중앙 크롭 폴백 (얼굴 미감지)</p>
  ) : null;
}
```

(`r.tracking === null` distinguishes "no faces detected" from `undefined`/`undefined` (no tracker run, e.g., test fixtures pre-Task 7) — both branches show or hide cleanly thanks to the `.nullish()` schema.)

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/renderer/components/newjob/RenderCard.tsx
yarn lint && yarn typecheck && yarn test 2>&1 | tail -8
```

Expected: all green. Existing tests don't pass `tracking` so neither note renders — no regression.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/newjob/RenderCard.tsx
git commit -m "feat(m7): show tracking note (frames or center fallback) per clip in RenderCard"
```

---

### Task 11: DoD verification + README + finalize branch

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Run all DoD checks**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn typecheck && yarn lint && yarn test && yarn build
cd sidecar && uv run pytest && cd ..
```

Expected: all green. Vitest count is 110 (M6 baseline) + 4 + 6 + 3 = 123. Pytest 24 (16 prior + 6 face_tracker + 2 server).

- [ ] **Step 2: Manual integration check (real mediapipe + ffmpeg + real video)**

In one terminal:

```bash
yarn dev
```

In the app:

1. NewJob page — paste a short YouTube URL with a clear talking-head subject (not a music video / animation), click 미리보기, 다운로드, wait.
2. Click STT 시작, wait for transcript.
3. Click 하이라이트 추출, wait for highlights.
4. Click 숏츠 만들기. **First call** triggers the Python sidecar's lazy mediapipe import — adds ~3-5 seconds to the first clip. Subsequent clips are faster.
5. When done, each clip card should show "🎯 얼굴 추적 N프레임" (typically 60+ frames for a 30s clip at 2fps). If a clip shows "⊕ 중앙 크롭 폴백", that clip had no detectable faces — common for B-roll / scenery cuts.
6. Click 폴더 열기. Each `short_N.mp4` should now have the talking head centered in the 1080×1920 frame, even if the speaker moves around in the source. Compare against M6 (which always center-cropped) — for a speaker who walks left-to-right, M7 should follow them.
7. Verify the sidecar files: `${outputDir}/short_1.cmd` and `short_1.track.json` should exist next to the .mp4.

If mediapipe fails to import at runtime (most common: macOS + Apple Silicon + missing wheels), the IPC will surface the error — clip falls back to center crop and shows the polite fallback message. Not a hard failure.

If the rendered crop "jumps" sharply, the smoothing window may need bumping. Acceptable for M7; can tune in M9.

If something is broken, fix and re-test BEFORE committing.

- [ ] **Step 3: Update README status**

Edit `README.md` `## Status`:

```markdown
## Status

- ✅ M1: Project Skeleton
- ✅ M2: Settings page
- ✅ M3: YouTube preview + download
- ✅ M4: Python sidecar + STT
- ✅ M5: LLM highlight extraction
- ✅ M6: First end-to-end render — system ffmpeg, center-crop 9:16, sequential per-clip queue, partial success on per-clip failure.
- ✅ M7: Smart face tracking — MediaPipe per-clip face tracking, Gaussian-smoothed sendcmd-driven dynamic crop, auto-fallback to center on detection failure.
- ⏳ M8: Subtitle burn-in (next)
```

- [ ] **Step 4: Commit + push branch**

```bash
yarn prettier --write README.md
git add README.md
git commit -m "docs(m7): mark milestone 7 complete in README"
git push -u origin m7-smart-face-tracking
```

- [ ] **Step 5: Merge to master + tag**

(Done by the controller via `superpowers:finishing-a-development-branch` skill — see DoD below.)

---

## Definition of Done (M7)

All of these must be true:

1. `yarn typecheck`, `yarn lint` (only known `__dirname` warning), `yarn test`, `yarn build` all exit 0.
2. `cd sidecar && uv run pytest` reports all sidecar tests passing (24 total: 16 prior + 6 face_tracker + 2 server).
3. `yarn test` includes new test files: `TrackingService.test.ts` (4), `SendcmdGenerator.test.ts` (6), and 3 new RenderService tests (the existing 6 still pass). Total expected: 110 prior + 13 new = 123. No regressions.
4. Manual integration: real `yarn dev` run downloads a talking-head video, renders shorts that visibly track the speaker's face. Both `.cmd` and `.track.json` are written next to the .mp4. Falls back gracefully when faces are not detected.
5. Branch `m7-smart-face-tracking` pushed to origin.
6. After review, branch merged to master with `--no-ff` and tagged `m7-complete` on master.

## What's NOT in M7 (intentionally deferred)

- **GPU/Metal acceleration for MediaPipe** (M10): we use the CPU model_selection=1. Performance is acceptable at 2fps sampling for 30s clips.
- **Configurable sample rate / smoothing**: hardcoded fps_sample=2.0, gaussian window=5, sigma=1.0. Tunable settings is M9.
- **Multi-face speaker selection** (M9+): largest-face heuristic is the M7 choice. Allowing user to pick a face is later.
- **Face tracking quality metrics**: no telemetry on detection rate, smoothing artifacts, etc. M9 history view could surface these.
- **vertical-source handling**: SendcmdGenerator throws if the source is already 9:16 or taller. The renderer surfaces the error per-clip; that source video would simply not render cleanly. Real fix is to skip the crop entirely for already-vertical sources — minor, deferred.
- **Cancel mid-tracking**: M7's tracker.track() is awaited in full per clip. If a render takes >10s of tracking before ffmpeg starts, cancel during that window has to wait for the track to complete. The Python sidecar's existing cancel mechanism (M4) covers transcribe but not track_faces — adding it requires similar threading + event plumbing. Deferred.
- **Track JSON cleanup**: `.cmd` and `.track.json` files persist next to outputs. No auto-cleanup; user can delete the output dir to remove everything. M9 history view is the natural place to manage these.
- **MediaPipe license review** (M10): Apache 2.0 for the framework, but specific model weights may need a separate license review before distribution.

## Notes for the implementing agent

- Start the milestone branch BEFORE Task 1: `git checkout master && git pull && git checkout -b m7-smart-face-tracking` (already done by the plan author at write time — confirm `git branch --show-current` shows `m7-smart-face-tracking` before starting).
- The bob-park ESLint config bans `../*` parent imports — use `@renderer/*`, `@shared/*` aliases.
- mediapipe's import is heavy (~1-2s on first call). The face_tracker module's `_default_detector` defers the import until first use — keep it that way so cold-start app launch isn't penalized.
- `track_faces` RPC is added to the existing PythonSidecar transport (no contract change needed) — `PythonSidecar.request('track_faces', ...)` already passes through any params/result.
- The existing `getTranscribeService()` helper in main.ts boots the PythonSidecar lazily. M7's `getRenderService()` reuses it (calling getTranscribeService for its side effect of populating `pythonSidecar`). This avoids double-spawning the Python child process when both transcribe and render run in the same app session.
- The sendcmd file path goes into the ffmpeg `-vf` argument as an absolute path — no escaping concerns at the shell level since spawn passes it as a single argv entry. (sendcmd's own parser requires escaping in a few cases — see ffmpeg docs — but our generated content uses only digits, dots, and ASCII identifiers, so we're safe.)
