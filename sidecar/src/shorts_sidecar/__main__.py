"""Entrypoint: `python -m shorts_sidecar` — line-JSON over stdio."""

from __future__ import annotations

import sys
import threading
from queue import Queue

from .rpc import encode_message, parse_line
from .server import Server


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
