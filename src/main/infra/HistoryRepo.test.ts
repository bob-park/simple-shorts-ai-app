import type { Job, Short } from '@shared/history';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { HistoryRepo } from './HistoryRepo';

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    url: 'https://youtu.be/abc',
    videoId: 'abc',
    title: 'My Talk',
    channel: 'Bob Park',
    durationSec: 600,
    sourcePath: '/tmp/My Talk.webm',
    sourceThumb: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
    status: 'done',
    errorMessage: null,
    optionsJson: '{}',
    llmModel: 'anthropic/claude-sonnet-4.5',
    whisperModel: 'small',
    createdAt: 1000,
    finishedAt: 1100,
    ...overrides,
  };
}

function fakeShort(overrides: Partial<Short> = {}): Short {
  return {
    id: 's1',
    jobId: 'j1',
    idx: 1,
    title: 'Opener',
    hook: 'Strong start',
    startSec: 0,
    endSec: 30,
    outputPath: '/tmp/out/short_1.mp4',
    thumbPath: '/tmp/thumbs/s1.png',
    width: 1080,
    height: 1920,
    sizeBytes: 1234567,
    ...overrides,
  };
}

describe('HistoryRepo', () => {
  let repo: HistoryRepo;

  beforeEach(() => {
    repo = new HistoryRepo(new Database(':memory:'));
  });

  it('creates jobs + shorts + search_idx tables on first instantiation', () => {
    const tables = repo._db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('jobs');
    expect(names).toContain('shorts');
    expect(names).toContain('search_idx');
  });

  it('insertJob persists a job and getJob returns it', () => {
    const job = fakeJob();
    repo.insertJob(job);
    const got = repo.getJob('j1');
    expect(got).toEqual(job);
  });

  it('insertShorts persists shorts and getShortsByJob returns them in idx order', () => {
    repo.insertJob(fakeJob());
    repo.insertShorts([fakeShort({ id: 's2', idx: 2, title: 'B' }), fakeShort({ id: 's1', idx: 1, title: 'A' })]);
    const got = repo.getShortsByJob('j1');
    expect(got.map((s) => s.idx)).toEqual([1, 2]);
    expect(got[0]!.title).toBe('A');
  });

  it('listSummaries returns one row per job, newest first by default, with shortCount', () => {
    repo.insertJob(fakeJob({ id: 'j1', createdAt: 1000, title: 'Older' }));
    repo.insertJob(fakeJob({ id: 'j2', createdAt: 2000, title: 'Newer' }));
    repo.insertShorts([fakeShort({ id: 's1', jobId: 'j1' }), fakeShort({ id: 's2', jobId: 'j1', idx: 2 })]);
    repo.insertShorts([fakeShort({ id: 's3', jobId: 'j2' })]);

    const list = repo.listSummaries({ search: '', sortBy: 'newest', statusFilter: [] });
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe('j2'); // newer first
    expect(list[1]!.id).toBe('j1');
    expect(list.find((j) => j.id === 'j1')!.shortCount).toBe(2);
    expect(list.find((j) => j.id === 'j2')!.shortCount).toBe(1);
  });

  it('listSummaries with sortBy=title orders alphabetically', () => {
    repo.insertJob(fakeJob({ id: 'j1', title: 'Bravo' }));
    repo.insertJob(fakeJob({ id: 'j2', title: 'Alpha' }));
    const list = repo.listSummaries({ search: '', sortBy: 'title', statusFilter: [] });
    expect(list.map((j) => j.title)).toEqual(['Alpha', 'Bravo']);
  });

  it('listSummaries with sortBy=duration orders longest first', () => {
    repo.insertJob(fakeJob({ id: 'j1', durationSec: 100 }));
    repo.insertJob(fakeJob({ id: 'j2', durationSec: 600 }));
    const list = repo.listSummaries({ search: '', sortBy: 'duration', statusFilter: [] });
    expect(list.map((j) => j.id)).toEqual(['j2', 'j1']);
  });

  it('listSummaries filters by statusFilter (multi-status OR)', () => {
    repo.insertJob(fakeJob({ id: 'j1', status: 'done' }));
    repo.insertJob(fakeJob({ id: 'j2', status: 'failed' }));
    repo.insertJob(fakeJob({ id: 'j3', status: 'partial_done' }));
    const list = repo.listSummaries({ search: '', sortBy: 'newest', statusFilter: ['failed', 'partial_done'] });
    expect(list.map((j) => j.id).sort()).toEqual(['j2', 'j3']);
  });

  it('listSummaries with search uses FTS5 over title + channel + short titles + hooks', () => {
    repo.insertJob(fakeJob({ id: 'j1', title: 'Talk on AI', channel: 'Bob' }));
    repo.insertJob(fakeJob({ id: 'j2', title: 'Cat videos', channel: 'Alice' }));
    repo.insertShorts([fakeShort({ id: 's1', jobId: 'j1', title: 'GPT highlights', hook: 'shocking' })]);

    expect(repo.listSummaries({ search: 'AI', sortBy: 'newest', statusFilter: [] })).toHaveLength(1);
    expect(repo.listSummaries({ search: 'shocking', sortBy: 'newest', statusFilter: [] })).toHaveLength(1);
    expect(repo.listSummaries({ search: 'cats', sortBy: 'newest', statusFilter: [] })).toHaveLength(0);
  });

  it('deleteJob removes the job and its shorts and FTS rows (CASCADE)', () => {
    repo.insertJob(fakeJob());
    repo.insertShorts([fakeShort({ id: 's1' }), fakeShort({ id: 's2', idx: 2 })]);
    repo.deleteJob('j1');
    expect(repo.getJob('j1')).toBeNull();
    expect(repo.getShortsByJob('j1')).toEqual([]);
    // FTS row gone too — search returns nothing
    expect(repo.listSummaries({ search: 'My', sortBy: 'newest', statusFilter: [] })).toHaveLength(0);
  });

  it('migration is idempotent — second instantiation against same DB does not fail', () => {
    const db = new Database(':memory:');
    const first = new HistoryRepo(db);
    first.insertJob(fakeJob());
    const second = new HistoryRepo(db);
    expect(second.getJob('j1')).toBeTruthy();
  });
});
