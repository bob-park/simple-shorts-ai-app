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
