"""Line-delimited JSON-RPC protocol helpers (pure, no IO)."""

from __future__ import annotations

import json
from typing import Any


def parse_line(line: str) -> dict[str, Any] | None:
    """Parse one input line into a message dict.

    Returns None for blank lines (so the caller can ignore them).
    Raises ValueError for malformed JSON.
    """
    stripped = line.strip()
    if not stripped:
        return None
    try:
        msg = json.loads(stripped)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON line: {e.msg}") from e
    if not isinstance(msg, dict):
        raise ValueError("Expected a JSON object at the top level")
    return msg


def encode_message(msg: dict[str, Any]) -> str:
    """Serialize a message dict into one JSON line terminated by '\n'."""
    return json.dumps(msg, ensure_ascii=False) + "\n"


def response(request_id: str, result: Any) -> dict[str, Any]:
    return {"id": request_id, "result": result}


def error_response(request_id: str, code: str, message: str) -> dict[str, Any]:
    return {"id": request_id, "error": {"code": code, "message": message}}


def notification(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Server-initiated notification (no id, so the client ignores any ack semantics)."""
    return {"method": method, "params": params}
