import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the macOS setup failure root cause (2026-05-15).
 *
 * `llama-cpp-python` was floated `>=0.3.22`, so uv resolved to the newest
 * abetlen-prebuilt CPU wheel. The abetlen GitHub-Releases `py3-none`
 * macOS-arm64 wheels for 0.3.21 / 0.3.22 / 0.3.23 are CORRUPT at the source
 * (download byte-exact to GitHub's recorded size yet fail zip/deflate
 * extraction — `deflate decompression error: invalid block type`), which
 * crashed `uv pip install` during first-run setup.
 *
 * 0.3.19 is the newest version whose abetlen CPU wheels are VALID for BOTH
 * macosx_11_0_arm64 and win_amd64 (cp311), and its bundled llama.cpp still
 * carries full Gemma 3 support (the app loads gemma-3-4b-it). Pin it exactly
 * so the float can never silently drift back onto a corrupt upstream wheel.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REQUIREMENTS = readFileSync(join(REPO_ROOT, 'sidecar', 'requirements.txt'), 'utf8');

describe('sidecar/requirements.txt llama-cpp-python pin', () => {
  it('pins llama-cpp-python to exactly ==0.3.19 (not a >= float)', () => {
    const line = REQUIREMENTS.split(/\r?\n/).find((l) => /^\s*llama-cpp-python\s*[=<>!~]/.test(l));
    expect(line).toBeDefined();
    expect(line!.trim()).toBe('llama-cpp-python==0.3.19');
  });

  it('does not float llama-cpp-python with >= (would drift onto corrupt upstream wheels)', () => {
    expect(REQUIREMENTS).not.toMatch(/llama-cpp-python\s*>=/);
  });
});
