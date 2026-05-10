import { promises as fsPromises } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function withTempDl(): Promise<{ dl: string; cleanup: () => Promise<void> }> {
  const dl = await mkdtemp(join(tmpdir(), 'resume-test-'));
  return { dl, cleanup: () => rm(dl, { recursive: true, force: true }) };
}

const baseMeta = {
  id: 'abc123',
  title: 'Test',
  channel: 'C',
  durationSec: 60,
  thumbnailUrl: 'https://example.com/t.jpg',
  webpageUrl: 'https://youtu.be/abc123',
};

describe('ResumeService.detect (real fs)', () => {
  it('returns snapshot when meta.json matches videoId and source file exists', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'video.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.detect('abc123');
      expect(snap).not.toBeNull();
      expect(snap!.sourcePath).toBe(sourcePath);
      expect(snap!.meta.id).toBe('abc123');
      expect(snap!.download.outputPath).toBe(sourcePath);
      expect(snap!.transcript).toBeUndefined();
      expect(snap!.highlights).toBeUndefined();
      expect(snap!.render).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('returns null when no meta.json matches the videoId', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      await writeFile(join(dl, 'video.webm'), 'fake');
      await writeFile(join(dl, 'video.webm.meta.json'), JSON.stringify({ ...baseMeta, id: 'other' }));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      expect(await svc.detect('abc123')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('returns null when meta matches but source file is missing', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      await writeFile(join(dl, 'gone.webm.meta.json'), JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      expect(await svc.detect('abc123')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('returns null without throwing when downloads dir does not exist', async () => {
    const svc = new ResumeService(
      { get: () => ({ paths: { downloads: '/nonexistent/path', outputs: '/out' } }) },
      fsPromises,
    );
    expect(await svc.detect('abc123')).toBeNull();
  });

  it('skips meta.json files that fail to parse', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      await writeFile(join(dl, 'a.webm.meta.json'), 'not-json');
      const sourcePath = join(dl, 'b.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.detect('abc123');
      expect(snap?.sourcePath).toBe(sourcePath);
    } finally {
      await cleanup();
    }
  });

  it('picks the most recent on duplicate videoId matches', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const oldPath = join(dl, 'old.webm');
      const newPath = join(dl, 'new.webm');
      await writeFile(oldPath, 'fake');
      await writeFile(newPath, 'fake');
      await writeFile(`${oldPath}.meta.json`, JSON.stringify(baseMeta));
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(`${newPath}.meta.json`, JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.detect('abc123');
      expect(snap?.sourcePath).toBe(newPath);
    } finally {
      await cleanup();
    }
  });
});
