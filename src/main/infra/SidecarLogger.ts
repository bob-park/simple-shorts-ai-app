import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SidecarLoggerFs {
  mkdirSync(path: string, opts?: { recursive: true }): void;
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
}

const NODE_FS: SidecarLoggerFs = {
  mkdirSync: (p, o) => void mkdirSync(p, o),
  writeFileSync: (p, d) => writeFileSync(p, d),
  appendFileSync: (p, d) => appendFileSync(p, d),
};

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Best-effort append-only sidecar log. Truncated on construction (one file
 * per app launch), byte-capped, and guaranteed never to throw — a logging
 * failure must not crash the app or break the pipeline.
 */
export class SidecarLogger {
  private written = 0;
  private capped = false;

  constructor(
    private readonly logPath: string,
    private readonly fs: SidecarLoggerFs = NODE_FS,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {
    try {
      this.fs.mkdirSync(dirname(logPath), { recursive: true });
      this.fs.writeFileSync(logPath, '');
    } catch {
      /* best-effort */
    }
  }

  append(chunk: string): void {
    if (this.capped) return;
    try {
      const remaining = this.maxBytes - this.written;
      if (remaining <= 0) {
        this.capped = true;
        return;
      }
      // chunk.length is UTF-16 code units; for ASCII sidecar output this equals byte count.
      const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      this.fs.appendFileSync(this.logPath, slice);
      this.written += slice.length;
    } catch {
      /* best-effort: never throw */
    }
  }

  get sink(): (chunk: string) => void {
    return (chunk: string) => this.append(chunk);
  }
}
