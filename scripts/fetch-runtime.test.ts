// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseTargetsArg } from './fetch-runtime';

describe('parseTargetsArg', () => {
  it('returns the single target from --target=win-x64', () => {
    expect(parseTargetsArg(['node', 'fetch-runtime.ts', '--target=win-x64'], 'darwin', 'arm64')).toEqual([
      'win-x64',
    ]);
  });

  it('splits a comma-separated --target list in order', () => {
    expect(
      parseTargetsArg(['node', 'fetch-runtime.ts', '--target=mac-arm64,win-x64'], 'darwin', 'arm64'),
    ).toEqual(['mac-arm64', 'win-x64']);
  });

  it('defaults to mac-arm64 when host is darwin-arm64 and no --target given', () => {
    expect(parseTargetsArg(['node', 'fetch-runtime.ts'], 'darwin', 'arm64')).toEqual(['mac-arm64']);
  });

  it('throws when host is not auto-mappable and no --target given', () => {
    expect(() => parseTargetsArg(['node', 'fetch-runtime.ts'], 'linux', 'x64')).toThrow(/--target/);
  });

  it('throws on an unknown target', () => {
    expect(() =>
      parseTargetsArg(['node', 'fetch-runtime.ts', '--target=lin-x64'], 'darwin', 'arm64'),
    ).toThrow(/unknown target/i);
  });
});
