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
                if actual_t < current_t:
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
