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

describe('ResumeService.hydrate (real fs)', () => {
  it('returns null when meta.json does not exist for sourcePath', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      expect(await svc.hydrate(join(dl, 'no-meta.webm'))).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('builds download-only snapshot when only meta + source exist', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'a.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.download.outputPath).toBe(sourcePath);
      expect(snap?.transcript).toBeUndefined();
      expect(snap?.highlights).toBeUndefined();
      expect(snap?.render).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('includes transcript when transcript.json exists and parses', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'a.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await writeFile(
        `${sourcePath}.transcript.json`,
        JSON.stringify({
          duration: 60,
          language: 'en',
          segments: [{ start: 0, end: 5, text: 'hi' }],
          words: [{ start: 0, end: 1, text: 'hi' }],
        }),
      );
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.transcript?.path).toBe(`${sourcePath}.transcript.json`);
      expect(snap?.transcript?.data.segments).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('skips transcript when JSON is corrupt', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'a.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await writeFile(`${sourcePath}.transcript.json`, 'not-json');
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.transcript).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('includes highlights when highlights.json exists', async () => {
    const { dl, cleanup } = await withTempDl();
    try {
      const sourcePath = join(dl, 'a.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await writeFile(
        `${sourcePath}.highlights.json`,
        JSON.stringify({
          generatedAt: '2026-05-10T00:00:00Z',
          model: 'gemma-3-4b',
          audioPath: sourcePath,
          highlights: [{ segments: [{ start_sec: 0, end_sec: 5 }], title: 'T', hook: 'h' }],
        }),
      );
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: '/out' } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.highlights?.data.highlights).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('rebuilds render result from outputs/<stem>/short_*.mp4 when present', async () => {
    const { dl, cleanup } = await withTempDl();
    const out = await mkdtemp(join(tmpdir(), 'resume-out-'));
    try {
      const sourcePath = join(dl, 'video.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await writeFile(
        `${sourcePath}.highlights.json`,
        JSON.stringify({
          generatedAt: '2026-05-10T00:00:00Z',
          model: 'gemma-3-4b',
          audioPath: sourcePath,
          highlights: [
            { segments: [{ start_sec: 0, end_sec: 5 }], title: 'A', hook: 'a' },
            { segments: [{ start_sec: 10, end_sec: 15 }], title: 'B', hook: 'b' },
          ],
        }),
      );
      const stemOut = join(out, 'video');
      await fsPromises.mkdir(stemOut, { recursive: true });
      await writeFile(join(stemOut, 'short_1.mp4'), 'mp4-1');
      await writeFile(join(stemOut, 'short_2.mp4'), 'mp4-2');
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: out } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.render).toBeDefined();
      expect(snap!.render!.result.results).toHaveLength(2);
      expect(snap!.render!.result.results[0]!.outputPath).toBe(join(stemOut, 'short_1.mp4'));
      expect(snap!.render!.result.results[0]!.title).toBe('A');
      expect(snap!.render!.result.results[1]!.title).toBe('B');
      expect(snap!.render!.result.results[0]!.status).toBe('done');
    } finally {
      await cleanup();
      await rm(out, { recursive: true, force: true });
    }
  });

  it('omits render when outputs/<stem>/ has no mp4 files', async () => {
    const { dl, cleanup } = await withTempDl();
    const out = await mkdtemp(join(tmpdir(), 'resume-out-'));
    try {
      const sourcePath = join(dl, 'video.webm');
      await writeFile(sourcePath, 'fake');
      await writeFile(`${sourcePath}.meta.json`, JSON.stringify(baseMeta));
      await fsPromises.mkdir(join(out, 'video'), { recursive: true });
      const svc = new ResumeService({ get: () => ({ paths: { downloads: dl, outputs: out } }) }, fsPromises);
      const snap = await svc.hydrate(sourcePath);
      expect(snap?.render).toBeUndefined();
    } finally {
      await cleanup();
      await rm(out, { recursive: true, force: true });
    }
  });
});

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
