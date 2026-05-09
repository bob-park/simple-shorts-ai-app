# shorts-sidecar

Long-running Python process that speaks line-delimited JSON-RPC over stdio.
Spawned by the Electron main process on demand; never run directly by users.

## Local development

```bash
cd sidecar
uv sync                     # creates .venv with deps
uv run pytest               # runs the test suite
uv run python -m shorts_sidecar < /dev/null  # smoke (immediate EOF → exits 0)
```

Send a request manually:

```bash
echo '{"id":"1","method":"health"}' | uv run python -m shorts_sidecar
```

Expected output: `{"id":"1","result":{"ok":true,"modelsLoaded":[]}}`.
