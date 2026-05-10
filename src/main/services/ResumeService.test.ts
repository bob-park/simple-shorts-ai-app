import { describe, expect, it, vi } from 'vitest';

import { ResumeService } from './ResumeService';

function makeStubFs() {
  return {
    readdir: vi.fn(async (_d: string) => [] as string[]),
    readFile: vi.fn(async (_p: string, _e: 'utf8') => ''),
    access: vi.fn(async (_p: string) => undefined),
    stat: vi.fn(async (_p: string) => ({ mtimeMs: 0 })),
  };
}

function makeStubSettings(downloads = '/dl', outputs = '/out') {
  return { get: () => ({ paths: { downloads, outputs } }) };
}

describe('ResumeService', () => {
  it('detect returns null when downloads dir is empty', async () => {
    const fs = makeStubFs();
    const svc = new ResumeService(makeStubSettings(), fs);
    expect(await svc.detect('any-id')).toBeNull();
  });

  it('hydrate returns null when meta.json is missing', async () => {
    const fs = makeStubFs();
    fs.readFile.mockRejectedValue(new Error('ENOENT'));
    const svc = new ResumeService(makeStubSettings(), fs);
    expect(await svc.hydrate('/dl/missing.mp4')).toBeNull();
  });
});
