import json
import pytest

from shorts_sidecar.rpc import (
    encode_message,
    parse_line,
    response,
    error_response,
    notification,
)


def test_parse_line_decodes_a_request():
    line = '{"id":"abc","method":"transcribe","params":{"audio_path":"/tmp/x.mp4"}}'
    msg = parse_line(line)
    assert msg == {
        "id": "abc",
        "method": "transcribe",
        "params": {"audio_path": "/tmp/x.mp4"},
    }


def test_parse_line_returns_none_on_blank_line():
    assert parse_line("") is None
    assert parse_line("   \n") is None


def test_parse_line_raises_on_invalid_json():
    with pytest.raises(ValueError):
        parse_line("not json")


def test_encode_message_returns_single_line_json_with_trailing_newline():
    out = encode_message({"id": "1", "result": {"ok": True}})
    assert out.endswith("\n")
    assert "\n" not in out[:-1]
    assert json.loads(out) == {"id": "1", "result": {"ok": True}}


def test_response_builds_id_plus_result():
    assert response("abc", {"x": 1}) == {"id": "abc", "result": {"x": 1}}


def test_error_response_builds_id_plus_error():
    err = error_response("abc", code="canceled", message="Transcription canceled")
    assert err == {
        "id": "abc",
        "error": {"code": "canceled", "message": "Transcription canceled"},
    }


def test_notification_has_no_id():
    note = notification("progress", {"job_id": "abc", "processed": 1.0, "total": 10.0})
    assert "id" not in note
    assert note["method"] == "progress"
    assert note["params"]["job_id"] == "abc"
