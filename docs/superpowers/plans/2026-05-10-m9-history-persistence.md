# M9: History Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every render durable. After `RenderService.render()` resolves, write a `jobs` row + N `shorts` rows to a SQLite history database, extract a per-short PNG thumbnail via ffmpeg, and update an FTS5 search index. Replace the existing `HistoryPage` stub with a working list/thumbnail-toggle view backed by `history:list` + `history:getDetail` IPC. Honor the `settings.ui.historyView` toggle. Search via FTS5, sort by newest/title/length, filter by status.

**Architecture:** A new `HistoryRepo` (Node, infra layer) wraps `better-sqlite3` with synchronous CRUD + lazy schema migration. `ThumbnailService` reuses `FfmpegRunner` to extract a single still per short. `HistoryService` orchestrates: thumb extraction → repo writes → FTS index sync (via SQL triggers). The existing `render:run` IPC handler calls `HistoryService.recordJob(...)` after `RenderService.render()` resolves — it sources video metadata from a new `<audioPath>.meta.json` sidecar that the download handler writes in M9. New IPC methods `history:list / :getDetail / :delete` drive a rewritten `HistoryPage` with a `useHistory` hook, two view components (`HistoryListView`, `HistoryGridView`), and an inline `JobDetailDrawer` that opens on row click.

**Tech Stack:** `better-sqlite3` ^11 (synchronous SQLite native binding; ships prebuilt Electron binaries via `prebuild-install`). FTS5 is bundled with the SQLite library. No ULID dep — `crypto.randomUUID()` is fine for jobs (sortable-by-time isn't critical when we have `created_at` index). Thumbnails saved to `app.getPath('userData')/thumbs/<shortId>.png`. The `<audioPath>.meta.json` artifact joins the existing `.transcript.json` / `.highlights.json` family next to the source video.

---

## File Structure

```
package.json                                 # MODIFY: add better-sqlite3 + @types/better-sqlite3
yarn.lock                                    # MODIFY: regenerated

src/
├── shared/
│   ├── history.ts                           # NEW: Job, Short, JobSummary, JobDetail zod schemas
│   ├── youtube.ts                           # MODIFY: re-export VideoMeta if needed (it already is)
│   └── ipc.ts                               # MODIFY: history:list/:getDetail/:delete
├── main/
│   ├── main.ts                              # MODIFY: write meta.json on download; recordJob after render; register 3 new IPC
│   ├── preload.ts                           # MODIFY: bridge new methods
│   ├── infra/
│   │   ├── HistoryRepo.ts                   # NEW: better-sqlite3 wrapper + schema migration
│   │   └── HistoryRepo.test.ts              # NEW: vitest using better-sqlite3 ':memory:'
│   └── services/
│       ├── ThumbnailService.ts              # NEW: ffmpeg single-frame extract
│       ├── ThumbnailService.test.ts         # NEW: vitest with mocked FfmpegRunner
│       ├── HistoryService.ts                # NEW: orchestrate thumbs + repo writes
│       ├── HistoryService.test.ts           # NEW: vitest with mocked deps
│       └── YouTubeService.ts                # MODIFY: writeMetaSidecar option (one new helper)
└── renderer/
    ├── hooks/
    │   └── useHistory.ts                    # NEW: state machine + IPC subscription
    ├── components/history/
    │   ├── HistoryToolbar.tsx               # NEW: search + sort + view toggle + filter chips
    │   ├── HistoryListView.tsx              # NEW: data-table style rows
    │   ├── HistoryGridView.tsx              # NEW: 4-col thumbnail grid
    │   └── JobDetailDrawer.tsx              # NEW: side drawer with shorts + open-folder
    └── pages/History.tsx                    # MODIFY: replace stub with full implementation

tests/renderer/
├── App.test.tsx                             # MODIFY: extend api mock with history methods
├── Settings.test.tsx                        # MODIFY: same
├── NewJob.test.tsx                          # MODIFY: same
└── History.test.tsx                         # NEW: smoke test for list+search
```

**Decomposition rationale:**

- `HistoryRepo` owns ALL SQL — schema migration, prepared statements, FTS triggers. The service layer never sees raw SQL. Easy to unit-test against `:memory:` DB.
- `ThumbnailService` is a thin wrapper around `FfmpegRunner` — same DI pattern as `TranscribeService` over `PythonSidecar`. Args are static so no separate generator.
- `HistoryService.recordJob` is the single orchestration entry point: takes the inputs (videoMeta + highlights + render result), produces side effects (thumbs + DB rows). Pure facade — no IPC, no UI.
- The `<audioPath>.meta.json` sidecar is the cleanest way to get the original URL/title/channel into the render-time context without renderer state plumbing or re-fetching from YouTube. It joins `.transcript.json` + `.highlights.json` as a sibling artifact.
- The History UI splits into 3 small components (toolbar / listView / gridView / drawer) so each renders independently.

---

## Tasks

### Task 1: Add better-sqlite3 dependency

**Files:**

- Modify: `package.json`
- Modify: `yarn.lock`

- [ ] **Step 1: Add the dep**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn add better-sqlite3@^11.5.0
yarn add --dev @types/better-sqlite3
```

`better-sqlite3` ships prebuilt binaries for the Node ABI Electron uses. If the install logs "prebuild-install" lines that succeed, no rebuild is needed.

- [ ] **Step 2: Verify the binding loads under Electron's Node**

```bash
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('CREATE VIRTUAL TABLE x USING fts5(t)'); console.log('FTS5 OK', db.pragma('compile_options').filter(o => /FTS5|UNICODE/.test(o)));"
```

Expected: prints `FTS5 OK [ ... ENABLE_FTS5 ... ]`. If FTS5 is missing, the prebuilt SQLite was compiled without it — escalate to me with the error.

- [ ] **Step 3: Confirm the existing build still works**

```bash
yarn typecheck && yarn lint && yarn test 2>&1 | tail -5
```

Expected: typecheck 0 errors, lint 1 known warning, all 142 tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore(m9): add better-sqlite3 + @types/better-sqlite3"
```

---

### Task 2: Shared History zod schemas

**Files:**

- Create: `src/shared/history.ts`

- [ ] **Step 1: Create `src/shared/history.ts` with EXACTLY this content**

```ts
import { z } from 'zod';

export const JobStatusSchema = z.enum(['queued', 'running', 'done', 'partial_done', 'failed', 'canceled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Persisted in `jobs` table; mirrors the spec's section 6.1 schema. */
export const JobSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  videoId: z.string().min(1),
  title: z.string().min(1),
  channel: z.string().nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  sourcePath: z.string().nullable(),
  /** YouTube CDN thumbnail URL (no fetch — the renderer uses it as <img src>). */
  sourceThumb: z.string().nullable(),
  status: JobStatusSchema,
  errorMessage: z.string().nullable(),
  /** JSON-serialized render options (fontSize, count, model, etc.). */
  optionsJson: z.string(),
  llmModel: z.string().nullable(),
  whisperModel: z.string().nullable(),
  /** Unix epoch seconds. */
  createdAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const ShortSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  /** 1-based clip index within the job. */
  idx: z.number().int().positive(),
  title: z.string().min(1),
  hook: z.string().nullable(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  outputPath: z.string().min(1),
  /** Absolute path to per-short PNG thumb in <userData>/thumbs/. */
  thumbPath: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export type Short = z.infer<typeof ShortSchema>;

/** Lightweight row shape for the list view (joins job + short count). */
export const JobSummarySchema = z.object({
  id: z.string().min(1),
  videoId: z.string().min(1),
  title: z.string().min(1),
  channel: z.string().nullable(),
  durationSec: z.number().int().nonnegative().nullable(),
  sourceThumb: z.string().nullable(),
  status: JobStatusSchema,
  shortCount: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

/** Full detail returned by `history:getDetail`. */
export const JobDetailSchema = z.object({
  job: JobSchema,
  shorts: z.array(ShortSchema),
});
export type JobDetail = z.infer<typeof JobDetailSchema>;

export const HistoryListQuerySchema = z.object({
  /** Free-text query against FTS5 (title/channel/short titles/hooks). Empty = no filter. */
  search: z.string(),
  sortBy: z.enum(['newest', 'title', 'duration']),
  statusFilter: z.array(JobStatusSchema),
});
export type HistoryListQuery = z.infer<typeof HistoryListQuerySchema>;
```

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/shared/history.ts
yarn lint && yarn typecheck
```

Expected: lint 0 errors (1 known warning), typecheck 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/history.ts
git commit -m "feat(m9): add shared History zod schemas (Job, Short, JobSummary, JobDetail)"
```

---

### Task 3: HistoryRepo (TDD with `:memory:` DB)

**Files:**

- Create: `src/main/infra/HistoryRepo.ts`
- Create: `src/main/infra/HistoryRepo.test.ts`

`HistoryRepo` owns the SQL surface. Tests use `better-sqlite3` `:memory:` so they're real DB calls but ephemeral. Schema migration runs on first instantiation. FTS5 sync uses INSERT/DELETE triggers on `jobs` and `shorts`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/infra/HistoryRepo.test.ts` with EXACTLY this content:

```ts
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
```

- [ ] **Step 2: Run — should fail**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/infra/HistoryRepo.test.ts
```

Expected: cannot find HistoryRepo module.

- [ ] **Step 3: Implement `src/main/infra/HistoryRepo.ts` with EXACTLY this content**

```ts
import type { Job, JobStatus, JobSummary, Short } from '@shared/history';
import type Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  url             TEXT NOT NULL,
  video_id        TEXT NOT NULL,
  title           TEXT NOT NULL,
  channel         TEXT,
  duration_sec    INTEGER,
  source_path     TEXT,
  source_thumb    TEXT,
  status          TEXT NOT NULL,
  error_message   TEXT,
  options_json    TEXT NOT NULL,
  llm_model       TEXT,
  whisper_model   TEXT,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_video   ON jobs(video_id);

CREATE TABLE IF NOT EXISTS shorts (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  hook            TEXT,
  start_sec       REAL NOT NULL,
  end_sec         REAL NOT NULL,
  output_path     TEXT NOT NULL,
  thumb_path      TEXT,
  width           INTEGER,
  height          INTEGER,
  size_bytes      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_shorts_job ON shorts(job_id);

CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(
  job_id UNINDEXED,
  title, channel, short_titles, hooks,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

type JobRow = {
  id: string;
  url: string;
  video_id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  source_path: string | null;
  source_thumb: string | null;
  status: JobStatus;
  error_message: string | null;
  options_json: string;
  llm_model: string | null;
  whisper_model: string | null;
  created_at: number;
  finished_at: number | null;
};

type ShortRow = {
  id: string;
  job_id: string;
  idx: number;
  title: string;
  hook: string | null;
  start_sec: number;
  end_sec: number;
  output_path: string;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
};

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    url: r.url,
    videoId: r.video_id,
    title: r.title,
    channel: r.channel,
    durationSec: r.duration_sec,
    sourcePath: r.source_path,
    sourceThumb: r.source_thumb,
    status: r.status,
    errorMessage: r.error_message,
    optionsJson: r.options_json,
    llmModel: r.llm_model,
    whisperModel: r.whisper_model,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

function rowToShort(r: ShortRow): Short {
  return {
    id: r.id,
    jobId: r.job_id,
    idx: r.idx,
    title: r.title,
    hook: r.hook,
    startSec: r.start_sec,
    endSec: r.end_sec,
    outputPath: r.output_path,
    thumbPath: r.thumb_path,
    width: r.width,
    height: r.height,
    sizeBytes: r.size_bytes,
  };
}

export interface HistoryListQuery {
  search: string;
  sortBy: 'newest' | 'title' | 'duration';
  statusFilter: JobStatus[];
}

export class HistoryRepo {
  /** Exposed for direct introspection in tests; do NOT use from production code. */
  readonly _db: Database.Database;

  constructor(db: Database.Database) {
    this._db = db;
    this._db.pragma('foreign_keys = ON');
    this._db.exec(SCHEMA);
  }

  insertJob(j: Job): void {
    this._db
      .prepare(
        `INSERT INTO jobs (id, url, video_id, title, channel, duration_sec, source_path, source_thumb,
                           status, error_message, options_json, llm_model, whisper_model, created_at, finished_at)
         VALUES (@id, @url, @videoId, @title, @channel, @durationSec, @sourcePath, @sourceThumb,
                 @status, @errorMessage, @optionsJson, @llmModel, @whisperModel, @createdAt, @finishedAt)`,
      )
      .run(j);
    this.refreshSearchIndex(j.id);
  }

  insertShorts(shorts: Short[]): void {
    if (shorts.length === 0) return;
    const insert = this._db.prepare(
      `INSERT INTO shorts (id, job_id, idx, title, hook, start_sec, end_sec, output_path,
                           thumb_path, width, height, size_bytes)
       VALUES (@id, @jobId, @idx, @title, @hook, @startSec, @endSec, @outputPath,
               @thumbPath, @width, @height, @sizeBytes)`,
    );
    const tx = this._db.transaction((rows: Short[]) => {
      for (const s of rows) insert.run(s);
    });
    tx(shorts);
    // Refresh FTS for the parent job (which now has more short titles to index).
    const jobId = shorts[0]!.jobId;
    this.refreshSearchIndex(jobId);
  }

  getJob(id: string): Job | null {
    const row = this._db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  getShortsByJob(jobId: string): Short[] {
    const rows = this._db.prepare('SELECT * FROM shorts WHERE job_id = ? ORDER BY idx ASC').all(jobId) as ShortRow[];
    return rows.map(rowToShort);
  }

  listSummaries(q: HistoryListQuery): JobSummary[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (q.search.trim()) {
      where.push('jobs.id IN (SELECT job_id FROM search_idx WHERE search_idx MATCH @search)');
      // FTS5 NEAR / phrase / prefix not exposed yet — pass raw query.
      params.search = q.search.trim();
    }

    if (q.statusFilter.length > 0) {
      const placeholders = q.statusFilter.map((_, i) => `@status${i}`).join(', ');
      where.push(`jobs.status IN (${placeholders})`);
      q.statusFilter.forEach((s, i) => {
        params[`status${i}`] = s;
      });
    }

    const orderBy =
      q.sortBy === 'title'
        ? 'jobs.title COLLATE NOCASE ASC'
        : q.sortBy === 'duration'
          ? 'jobs.duration_sec DESC'
          : 'jobs.created_at DESC';

    const sql = `
      SELECT jobs.*, COALESCE(short_counts.n, 0) AS short_count
      FROM jobs
      LEFT JOIN (SELECT job_id, COUNT(*) AS n FROM shorts GROUP BY job_id) short_counts
        ON short_counts.job_id = jobs.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${orderBy}
    `;

    const rows = this._db.prepare(sql).all(params) as (JobRow & { short_count: number })[];
    return rows.map((r) => ({
      id: r.id,
      videoId: r.video_id,
      title: r.title,
      channel: r.channel,
      durationSec: r.duration_sec,
      sourceThumb: r.source_thumb,
      status: r.status,
      shortCount: r.short_count,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    }));
  }

  deleteJob(id: string): void {
    // CASCADE removes shorts; FTS row removed manually (FTS5 has no FK).
    this._db.prepare('DELETE FROM search_idx WHERE job_id = ?').run(id);
    this._db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  /**
   * Rebuild the FTS row for a single job. Cheaper than a full re-index, called
   * from insertJob / insertShorts. Idempotent — DELETEs the prior row first.
   */
  private refreshSearchIndex(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job) return;
    const shorts = this.getShortsByJob(jobId);
    const shortTitles = shorts.map((s) => s.title).join(' ');
    const hooks = shorts.map((s) => s.hook ?? '').join(' ');
    const tx = this._db.transaction(() => {
      this._db.prepare('DELETE FROM search_idx WHERE job_id = ?').run(jobId);
      this._db
        .prepare('INSERT INTO search_idx (job_id, title, channel, short_titles, hooks) VALUES (?, ?, ?, ?, ?)')
        .run(jobId, job.title, job.channel ?? '', shortTitles, hooks);
    });
    tx();
  }
}
```

- [ ] **Step 4: Run — should pass 10/10**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/infra/HistoryRepo.test.ts
```

If a test fails:

- "FTS5 search" — verify `better-sqlite3`'s SQLite was compiled with FTS5 (Task 1 step 2). If not, escalate.
- "deleteJob CASCADE" — `pragma foreign_keys = ON` must run before any DML. The constructor sets it; verify.

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/infra/HistoryRepo.ts src/main/infra/HistoryRepo.test.ts
git add src/main/infra/HistoryRepo.ts src/main/infra/HistoryRepo.test.ts
git commit -m "feat(m9): add HistoryRepo with sqlite schema, FTS5 search, sort, and filter"
```

---

### Task 4: ThumbnailService (TDD)

**Files:**

- Create: `src/main/services/ThumbnailService.ts`
- Create: `src/main/services/ThumbnailService.test.ts`

Tiny wrapper that runs `ffmpeg -i <video> -ss <t> -vframes 1 <out.png>` via `FfmpegRunner`. Returns the path on success, `null` on failure (non-fatal — the UI just shows a placeholder).

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/ThumbnailService.test.ts` with EXACTLY this content:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThumbnailService } from './ThumbnailService';

function fakeRunHandle(succeed: boolean) {
  return {
    onProgress: vi.fn(),
    cancel: vi.fn(),
    done: succeed ? Promise.resolve() : Promise.reject(new Error('ffmpeg failed')),
  };
}

describe('ThumbnailService', () => {
  let run: ReturnType<typeof vi.fn>;
  let runner: { run: typeof run };
  let service: ThumbnailService;

  beforeEach(() => {
    run = vi.fn();
    runner = { run };
    service = new ThumbnailService(runner as never);
  });

  it('builds ffmpeg args with -ss, -i, -vframes 1, png output', async () => {
    run.mockReturnValue(fakeRunHandle(true));
    await service.extractMidpoint('/tmp/in.mp4', '/tmp/thumbs/s1.png', { startSec: 5, endSec: 35 });
    expect(run).toHaveBeenCalledTimes(1);
    const args: string[] = run.mock.calls[0]![0].args;
    // midpoint = 20s
    expect(args).toContain('-ss');
    expect(args[args.indexOf('-ss') + 1]).toBe('20');
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/in.mp4');
    expect(args).toContain('-vframes');
    expect(args[args.indexOf('-vframes') + 1]).toBe('1');
    expect(args[args.length - 1]).toBe('/tmp/thumbs/s1.png');
  });

  it('returns the output path on success', async () => {
    run.mockReturnValue(fakeRunHandle(true));
    const got = await service.extractMidpoint('/tmp/in.mp4', '/tmp/thumbs/s1.png', { startSec: 0, endSec: 10 });
    expect(got).toBe('/tmp/thumbs/s1.png');
  });

  it('returns null on ffmpeg failure (non-fatal)', async () => {
    run.mockReturnValue(fakeRunHandle(false));
    const got = await service.extractMidpoint('/tmp/in.mp4', '/tmp/thumbs/s1.png', { startSec: 0, endSec: 10 });
    expect(got).toBeNull();
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/ThumbnailService.test.ts
```

- [ ] **Step 3: Implement `src/main/services/ThumbnailService.ts` with EXACTLY this content**

```ts
interface RunnerLike {
  run(opts: { args: readonly string[]; durationSec: number }): {
    onProgress(cb: (f: number) => void): void;
    cancel(): void;
    done: Promise<void>;
  };
}

export interface ExtractOptions {
  startSec: number;
  endSec: number;
}

/**
 * Extracts a single PNG frame at the midpoint of a clip range. Failures are
 * non-fatal — returns null so the caller can skip the thumb without aborting
 * the whole history-record flow.
 */
export class ThumbnailService {
  constructor(private readonly runner: RunnerLike) {}

  async extractMidpoint(videoPath: string, outPath: string, opts: ExtractOptions): Promise<string | null> {
    const midpoint = (opts.startSec + opts.endSec) / 2;
    const args = ['-y', '-ss', String(midpoint), '-i', videoPath, '-vframes', '1', outPath];
    const handle = this.runner.run({ args, durationSec: 1 });
    try {
      await handle.done;
      return outPath;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run — should pass 3/3**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/ThumbnailService.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/ThumbnailService.ts src/main/services/ThumbnailService.test.ts
git add src/main/services/ThumbnailService.ts src/main/services/ThumbnailService.test.ts
git commit -m "feat(m9): add ThumbnailService for ffmpeg single-frame extraction"
```

---

### Task 5: HistoryService (TDD)

**Files:**

- Create: `src/main/services/HistoryService.ts`
- Create: `src/main/services/HistoryService.test.ts`

The single entry point for "save a finished render to history." Takes the inputs (job metadata, render result, output dir for shorts), generates per-short thumbs, writes job + shorts rows. Pure facade — no IPC, no UI.

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/HistoryService.test.ts` with EXACTLY this content:

```ts
import type { Highlight, HighlightSet } from '@shared/highlight';
import type { RenderResult } from '@shared/render';
import type { VideoMeta } from '@shared/youtube';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryService } from './HistoryService';

function fakeMeta(overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    id: 'abc',
    title: 'My Talk',
    channel: 'Bob Park',
    durationSec: 600,
    thumbnailUrl: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
    webpageUrl: 'https://youtu.be/abc',
    ...overrides,
  };
}

function fakeHighlight(start: number, end: number, title: string, hook = 'h'): Highlight {
  return { start_sec: start, end_sec: end, title, hook };
}

function fakeHighlightSet(highlights: Highlight[]): HighlightSet {
  return {
    generatedAt: '2026-05-10T00:00:00Z',
    model: 'anthropic/claude-sonnet-4.5',
    audioPath: '/tmp/My Talk.webm',
    highlights,
  };
}

function fakeRenderResult(
  specs: { idx: number; status: 'done' | 'failed' | 'canceled'; outputPath?: string }[],
): RenderResult {
  return {
    outputDir: '/tmp/out/My Talk',
    results: specs.map((s) => ({
      index: s.idx,
      title: `Short ${s.idx}`,
      startSec: 0,
      endSec: 30,
      status: s.status,
      outputPath: s.outputPath,
      error: s.status === 'failed' ? 'oops' : undefined,
      tracking: null,
      subtitles: null,
    })),
  };
}

describe('HistoryService', () => {
  let repo: { insertJob: ReturnType<typeof vi.fn>; insertShorts: ReturnType<typeof vi.fn> };
  let thumbs: { extractMidpoint: ReturnType<typeof vi.fn> };
  let mkdir: ReturnType<typeof vi.fn>;
  let service: HistoryService;

  beforeEach(() => {
    repo = { insertJob: vi.fn(), insertShorts: vi.fn() };
    thumbs = { extractMidpoint: vi.fn(async (_v, out) => out) };
    mkdir = vi.fn(async () => undefined);
    service = new HistoryService({
      repo: repo as never,
      thumbs: thumbs as never,
      thumbsDir: '/data/thumbs',
      fs: { mkdir } as never,
      now: () => 5000,
      idGen: (() => {
        let n = 0;
        return () => `id${++n}`;
      })(),
    });
  });

  it('records a job + shorts when render had at least one done clip', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/My Talk.webm',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'Opener'), fakeHighlight(60, 90, 'Mid')]),
      renderResult: fakeRenderResult([
        { idx: 1, status: 'done', outputPath: '/tmp/out/My Talk/short_1.mp4' },
        { idx: 2, status: 'done', outputPath: '/tmp/out/My Talk/short_2.mp4' },
      ]),
      whisperModel: 'small',
    });

    expect(repo.insertJob).toHaveBeenCalledTimes(1);
    const job = repo.insertJob.mock.calls[0]![0];
    expect(job.id).toBe('id1');
    expect(job.title).toBe('My Talk');
    expect(job.channel).toBe('Bob Park');
    expect(job.url).toBe('https://youtu.be/abc');
    expect(job.videoId).toBe('abc');
    expect(job.status).toBe('done');
    expect(job.llmModel).toBe('anthropic/claude-sonnet-4.5');
    expect(job.whisperModel).toBe('small');
    expect(job.createdAt).toBe(5000);
    expect(job.finishedAt).toBe(5000);

    expect(repo.insertShorts).toHaveBeenCalledTimes(1);
    const shorts = repo.insertShorts.mock.calls[0]![0];
    expect(shorts).toHaveLength(2);
    expect(shorts[0].idx).toBe(1);
    expect(shorts[0].outputPath).toBe('/tmp/out/My Talk/short_1.mp4');
    expect(shorts[0].thumbPath).toBe('/data/thumbs/id2.png'); // id1 = job, id2/id3 = shorts
    expect(shorts[1].thumbPath).toBe('/data/thumbs/id3.png');
  });

  it('marks job as partial_done when some clips failed', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([
        { idx: 1, status: 'done', outputPath: '/tmp/out/short_1.mp4' },
        { idx: 2, status: 'failed' },
      ]),
      whisperModel: 'small',
    });
    expect(repo.insertJob.mock.calls[0]![0].status).toBe('partial_done');
  });

  it('marks job as failed when no clip succeeded', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([{ idx: 1, status: 'failed' }]),
      whisperModel: 'small',
    });
    expect(repo.insertJob.mock.calls[0]![0].status).toBe('failed');
  });

  it('marks job as canceled when all results are canceled', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([{ idx: 1, status: 'canceled' }]),
      whisperModel: 'small',
    });
    expect(repo.insertJob.mock.calls[0]![0].status).toBe('canceled');
  });

  it('skips thumbnail extraction (and stores null thumbPath) for non-done shorts', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A'), fakeHighlight(60, 90, 'B')]),
      renderResult: fakeRenderResult([
        { idx: 1, status: 'done', outputPath: '/tmp/out/short_1.mp4' },
        { idx: 2, status: 'failed' },
      ]),
      whisperModel: 'small',
    });
    // Thumb only attempted for the 'done' clip
    expect(thumbs.extractMidpoint).toHaveBeenCalledTimes(1);
    const shorts = repo.insertShorts.mock.calls[0]![0];
    expect(shorts[1].thumbPath).toBeNull();
  });

  it('stores null thumbPath when the thumbnail extraction fails (non-fatal)', async () => {
    thumbs.extractMidpoint.mockResolvedValue(null);
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([{ idx: 1, status: 'done', outputPath: '/tmp/out/short_1.mp4' }]),
      whisperModel: 'small',
    });
    const shorts = repo.insertShorts.mock.calls[0]![0];
    expect(shorts[0].thumbPath).toBeNull();
  });

  it('mkdir -p the thumbsDir before extracting', async () => {
    await service.recordJob({
      meta: fakeMeta(),
      sourcePath: '/tmp/in.mp4',
      highlightSet: fakeHighlightSet([fakeHighlight(0, 30, 'A')]),
      renderResult: fakeRenderResult([{ idx: 1, status: 'done', outputPath: '/tmp/out/short_1.mp4' }]),
      whisperModel: 'small',
    });
    expect(mkdir).toHaveBeenCalledWith('/data/thumbs', { recursive: true });
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/HistoryService.test.ts
```

- [ ] **Step 3: Implement `src/main/services/HistoryService.ts` with EXACTLY this content**

```ts
import type { HighlightSet } from '@shared/highlight';
import type { Job, JobStatus, Short } from '@shared/history';
import type { RenderResult } from '@shared/render';
import type { VideoMeta } from '@shared/youtube';
import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

interface RepoLike {
  insertJob(job: Job): void;
  insertShorts(shorts: Short[]): void;
}

interface ThumbsLike {
  extractMidpoint(
    videoPath: string,
    outPath: string,
    opts: { startSec: number; endSec: number },
  ): Promise<string | null>;
}

type FsLike = Pick<typeof fsPromises, 'mkdir'>;

export interface HistoryServiceOptions {
  repo: RepoLike;
  thumbs: ThumbsLike;
  /** Directory where per-short PNG thumbs are written. */
  thumbsDir: string;
  /** Injected for tests. Defaults to real fs.promises. */
  fs?: FsLike;
  /** Injected for tests. Defaults to Date.now()/1000. */
  now?: () => number;
  /** Injected for tests. Defaults to crypto.randomUUID. */
  idGen?: () => string;
}

export interface RecordJobInput {
  meta: VideoMeta;
  sourcePath: string;
  highlightSet: HighlightSet;
  renderResult: RenderResult;
  whisperModel: string;
}

/**
 * Single entry point for persisting a finished render to history. Generates
 * per-short thumbnails, then writes the job + shorts rows in a transaction.
 */
export class HistoryService {
  private readonly repo: RepoLike;
  private readonly thumbs: ThumbsLike;
  private readonly thumbsDir: string;
  private readonly fs: FsLike;
  private readonly now: () => number;
  private readonly idGen: () => string;

  constructor(opts: HistoryServiceOptions) {
    this.repo = opts.repo;
    this.thumbs = opts.thumbs;
    this.thumbsDir = opts.thumbsDir;
    this.fs = opts.fs ?? fsPromises;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.idGen = opts.idGen ?? randomUUID;
  }

  async recordJob(input: RecordJobInput): Promise<string> {
    await this.fs.mkdir(this.thumbsDir, { recursive: true });
    const jobId = this.idGen();
    const ts = this.now();
    const status = computeJobStatus(input.renderResult);

    const job: Job = {
      id: jobId,
      url: input.meta.webpageUrl,
      videoId: input.meta.id,
      title: input.meta.title,
      channel: input.meta.channel ?? null,
      durationSec: Math.round(input.meta.durationSec),
      sourcePath: input.sourcePath,
      sourceThumb: input.meta.thumbnailUrl ?? null,
      status,
      errorMessage: null,
      optionsJson: JSON.stringify({
        highlightModel: input.highlightSet.model,
        highlightCount: input.highlightSet.highlights.length,
      }),
      llmModel: input.highlightSet.model,
      whisperModel: input.whisperModel,
      createdAt: ts,
      finishedAt: ts,
    };

    const shorts: Short[] = [];
    for (const r of input.renderResult.results) {
      const shortId = this.idGen();
      let thumbPath: string | null = null;
      if (r.status === 'done' && r.outputPath) {
        const candidate = join(this.thumbsDir, `${shortId}.png`);
        thumbPath = await this.thumbs.extractMidpoint(r.outputPath, candidate, {
          startSec: 0,
          endSec: r.endSec - r.startSec,
        });
      }
      shorts.push({
        id: shortId,
        jobId,
        idx: r.index,
        title: r.title,
        hook: input.highlightSet.highlights[r.index - 1]?.hook ?? null,
        startSec: r.startSec,
        endSec: r.endSec,
        outputPath: r.outputPath ?? '',
        thumbPath,
        width: r.outputPath ? 1080 : null,
        height: r.outputPath ? 1920 : null,
        sizeBytes: null,
      });
    }

    this.repo.insertJob(job);
    this.repo.insertShorts(shorts);
    return jobId;
  }
}

function computeJobStatus(result: RenderResult): JobStatus {
  const counts = { done: 0, failed: 0, canceled: 0 };
  for (const r of result.results) counts[r.status as keyof typeof counts]++;
  if (counts.done === result.results.length) return 'done';
  if (counts.canceled === result.results.length) return 'canceled';
  if (counts.done === 0) return 'failed';
  return 'partial_done';
}
```

- [ ] **Step 4: Run — should pass 7/7**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/HistoryService.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/HistoryService.ts src/main/services/HistoryService.test.ts
git add src/main/services/HistoryService.ts src/main/services/HistoryService.test.ts
git commit -m "feat(m9): add HistoryService orchestrating thumbnails + repo writes"
```

---

### Task 6: Write `<audioPath>.meta.json` sidecar in main.ts download handler

**Files:**

- Modify: `src/main/main.ts`

The render-time history record needs the original `VideoMeta` (URL, title, channel, etc.) but main.ts currently discards it after the download IPC returns. Persist it as a sibling JSON.

- [ ] **Step 1: Locate the download handler**

In `src/main/main.ts`, find the `'youtube:download'` handler. Currently it computes `meta = await youtubeService.fetchMeta(url)`, then computes outputStem and calls `youtubeService.download(...)`.

- [ ] **Step 2: Add the meta sidecar write after the download resolves**

Inside the `'youtube:download'` handler, find the `const result = await handle.done;` line. AFTER it (and BEFORE `return { outputPath: result.outputPath };`), add:

```ts
// M9: persist the video metadata next to the source so render can build
// a history row. Keep it sibling to the .transcript.json / .highlights.json
// artifacts the later milestones already write.
try {
  const metaPath = `${result.outputPath}.meta.json`;
  await fsPromises.writeFile(
    metaPath,
    JSON.stringify({ ...meta, url, downloadedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
} catch (e) {
  // Non-fatal — history record will fall back to a stub if missing.
  process.stderr.write(`[m9] failed to write meta.json: ${(e as Error).message}\n`);
}
```

- [ ] **Step 3: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/main/main.ts
yarn lint && yarn typecheck && yarn test 2>&1 | tail -5
```

Expected: lint 0 errors, typecheck 0 errors, all tests pass (no behavior change to download — just an extra side effect).

- [ ] **Step 4: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(m9): write <audioPath>.meta.json sidecar after download for history record"
```

---

### Task 7: IPC contract extension

**Files:**

- Modify: `src/shared/ipc.ts`

- [ ] **Step 1: Add the imports + 3 new methods**

Edit `src/shared/ipc.ts`. Add to the type imports (alphabetical placement — after `./highlight`, before `./settings`):

```ts
import type { HistoryListQuery, JobDetail, JobSummary } from './history';
```

Add to the `AppApi` interface, after the existing `onRenderProgress` line and before `revealInFolder`:

```ts
  /** Fetch the history list with optional search/sort/filter. */
  historyList(query: HistoryListQuery): Promise<JobSummary[]>;
  /** Fetch full job + shorts detail for the inline drawer. */
  historyGetDetail(jobId: string): Promise<JobDetail | null>;
  /** Permanently delete a job + its shorts + thumbnails. */
  historyDelete(jobId: string): Promise<void>;
```

- [ ] **Step 2: Format + typecheck (lint + tests will fail until preload + stubs are updated in Task 8)**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/shared/ipc.ts
yarn typecheck 2>&1 | tail -10
```

Expected: typecheck FAILS only at `src/main/preload.ts` and `tests/renderer/*.test.tsx`. Errors elsewhere are real bugs.

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc.ts
git commit -m "feat(m9): extend AppApi with historyList/historyGetDetail/historyDelete"
```

---

### Task 8: Wire IPC handlers + lazy HistoryRepo/Service in main.ts

**Files:**

- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `tests/renderer/App.test.tsx`
- Modify: `tests/renderer/Settings.test.tsx`
- Modify: `tests/renderer/NewJob.test.tsx`

This is the M9 integration glue: lazy-init HistoryRepo + HistoryService at first use, register 3 new IPC handlers, and call `historyService.recordJob(...)` after `renderService.render()` resolves.

- [ ] **Step 1: Add imports to main.ts**

```ts
import { type HistoryListQuery, HistoryListQuerySchema } from '@shared/history';
import Database from 'better-sqlite3';

import { HistoryRepo } from './infra/HistoryRepo';
import { HistoryService } from './services/HistoryService';
import { ThumbnailService } from './services/ThumbnailService';
```

(Sort the relative imports alphabetically with the existing block.)

- [ ] **Step 2: Add module-level state**

After existing state declarations near the top:

```ts
let historyRepo: HistoryRepo | null = null;
let historyService: HistoryService | null = null;
```

- [ ] **Step 3: Add the lazy getter helper**

Above `void app.whenReady().then(() => {`:

```ts
function getHistoryRepo(): HistoryRepo {
  if (historyRepo) return historyRepo;
  const dbPath = join(app.getPath('userData'), 'history.db');
  historyRepo = new HistoryRepo(new Database(dbPath));
  return historyRepo;
}

function getHistoryService(): HistoryService {
  if (historyService) return historyService;
  if (!ffmpegRunner) {
    // Reuse the M6 ffmpeg runner — same binary, same lifecycle.
    ffmpegRunner = new (require('./infra/FfmpegRunner').FfmpegRunner)({ spawn });
  }
  const thumbnails = new ThumbnailService(ffmpegRunner!);
  historyService = new HistoryService({
    repo: getHistoryRepo(),
    thumbs: thumbnails,
    thumbsDir: join(app.getPath('userData'), 'thumbs'),
  });
  return historyService;
}
```

`FfmpegRunner` is already imported at the top of `main.ts` from M6, so the lazy getter just reuses that import:

```ts
function getHistoryService(): HistoryService {
  if (historyService) return historyService;
  if (!ffmpegRunner) {
    ffmpegRunner = new FfmpegRunner({ spawn });
  }
  const thumbnails = new ThumbnailService(ffmpegRunner);
  historyService = new HistoryService({
    repo: getHistoryRepo(),
    thumbs: thumbnails,
    thumbsDir: join(app.getPath('userData'), 'thumbs'),
  });
  return historyService;
}
```

(Confirm `FfmpegRunner` is already imported in main.ts from M6 before adding this. If for some reason it isn't, add `import { FfmpegRunner } from './infra/FfmpegRunner';` to the existing relative-imports block.)

- [ ] **Step 4: Hook recordJob into the render:run handler**

Find the existing `'render:run'` handler. Currently it ends with:

```ts
const service = getRenderService();
return await service.render({
  sourcePath: audioPath,
  outputDir,
  highlights: highlightSet.highlights,
  transcriptWords,
  subtitleOptions: ...,
});
```

Replace with:

```ts
const service = getRenderService();
const renderResult = await service.render({
  sourcePath: audioPath,
  outputDir,
  highlights: highlightSet.highlights,
  transcriptWords,
  subtitleOptions:
    settings.subtitles.enabled && transcriptWords
      ? {
          fontFamily: settings.subtitles.fontFamily,
          fontSize: settings.subtitles.fontSize,
          fillColor: settings.subtitles.fillColor,
          outlineColor: settings.subtitles.outlineColor,
          position: settings.subtitles.position,
        }
      : undefined,
});

// M9: persist to history. Best-effort — render result is returned even if
// persistence fails (avoids losing the user's render to a DB error).
try {
  const metaPath = `${audioPath}.meta.json`;
  const metaRaw = await fsPromises.readFile(metaPath, 'utf8');
  const meta = JSON.parse(metaRaw);
  await getHistoryService().recordJob({
    meta,
    sourcePath: audioPath,
    highlightSet,
    renderResult,
    whisperModel: settings.whisper.model,
  });
} catch (e) {
  process.stderr.write(`[m9] failed to record history: ${(e as Error).message}\n`);
}

return renderResult;
```

(Make sure to keep the existing subtitleOptions construction logic — the snippet above has it pasted in for completeness.)

- [ ] **Step 5: Register the 3 new IPC handlers**

Inside `app.whenReady().then(() => { ... })`, after the existing render handlers and BEFORE `createMainWindow();`:

```ts
ipcMain.handle('history:list', (_e, query: unknown) => {
  const parsed = HistoryListQuerySchema.parse(query);
  return getHistoryRepo().listSummaries(parsed);
});

ipcMain.handle('history:getDetail', (_e, jobId: string) => {
  const repo = getHistoryRepo();
  const job = repo.getJob(jobId);
  if (!job) return null;
  const shorts = repo.getShortsByJob(jobId);
  return { job, shorts };
});

ipcMain.handle('history:delete', (_e, jobId: string) => {
  getHistoryRepo().deleteJob(jobId);
});
```

- [ ] **Step 6: Cleanup in window-all-closed**

In the existing `app.on('window-all-closed', ...)` handler, BEFORE `if (process.platform...)`, add:

```ts
historyRepo?._db.close();
historyRepo = null;
historyService = null;
```

- [ ] **Step 7: Update preload.ts**

Add to type imports:

```ts
import type { HistoryListQuery, JobDetail, JobSummary } from '@shared/history';
```

Add to the `api` object literal, alongside the existing render bindings:

```ts
  historyList: (query: HistoryListQuery) => ipcRenderer.invoke('history:list', query),
  historyGetDetail: (jobId: string) => ipcRenderer.invoke('history:getDetail', jobId),
  historyDelete: (jobId: string) => ipcRenderer.invoke('history:delete', jobId),
```

- [ ] **Step 8: Update test stubs**

In each of `tests/renderer/App.test.tsx`, `tests/renderer/Settings.test.tsx`, `tests/renderer/NewJob.test.tsx`, add 3 new stubs to the api mock:

```ts
historyList: vi.fn(async () => []),
historyGetDetail: vi.fn(async () => null),
historyDelete: vi.fn(async () => undefined),
```

- [ ] **Step 9: Verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn lint && yarn typecheck && yarn test 2>&1 | tail -10
```

Expected: lint 0 errors, typecheck 0 errors, all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/main/main.ts src/main/preload.ts tests/renderer/App.test.tsx tests/renderer/Settings.test.tsx tests/renderer/NewJob.test.tsx
git commit -m "feat(m9): wire HistoryRepo + HistoryService + 3 IPC handlers; record after render"
```

---

### Task 9: useHistory hook

**Files:**

- Create: `src/renderer/hooks/useHistory.ts`

State machine for the history page: query state, fetch on query change, loading/error/done.

- [ ] **Step 1: Create `src/renderer/hooks/useHistory.ts` with EXACTLY this content**

```ts
import { useCallback, useEffect, useState } from 'react';

import type { HistoryListQuery, JobSummary } from '@shared/history';

export type HistoryState =
  | { status: 'loading' }
  | { status: 'done'; jobs: JobSummary[] }
  | { status: 'error'; error: Error };

export function useHistory() {
  const [query, setQuery] = useState<HistoryListQuery>({
    search: '',
    sortBy: 'newest',
    statusFilter: [],
  });
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    window.api
      .historyList(query)
      .then((jobs) => {
        if (cancelled) return;
        setState({ status: 'done', jobs });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: e instanceof Error ? e : new Error(String(e)) });
      });
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { query, setQuery, state, refresh };
}
```

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/renderer/hooks/useHistory.ts
yarn lint && yarn typecheck && yarn test 2>&1 | tail -5
```

Expected: all green (no new tests yet).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/hooks/useHistory.ts
git commit -m "feat(m9): add useHistory hook with query state + refresh"
```

---

### Task 10: HistoryListView + HistoryGridView components

**Files:**

- Create: `src/renderer/components/history/HistoryListView.tsx`
- Create: `src/renderer/components/history/HistoryGridView.tsx`

Two simple presentation components — list (data-table style) and grid (4-col thumbnail tiles). Both take `jobs: JobSummary[]` + `onRowClick(jobId)` props.

- [ ] **Step 1: Create `src/renderer/components/history/HistoryListView.tsx` with EXACTLY this content**

```tsx
import type { JobSummary } from '@shared/history';

function formatDuration(sec: number | null): string {
  if (sec === null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts * 1000).toLocaleString();
}

function statusLabel(s: JobSummary['status']): string {
  switch (s) {
    case 'done':
      return '✓ 완료';
    case 'partial_done':
      return '⚠ 부분 완료';
    case 'failed':
      return '✗ 실패';
    case 'canceled':
      return '⊘ 취소됨';
    default:
      return s;
  }
}

interface Props {
  jobs: JobSummary[];
  onRowClick: (jobId: string) => void;
}

export function HistoryListView({ jobs, onRowClick }: Props) {
  if (jobs.length === 0) {
    return <p className="text-body-md text-slate p-md">기록이 없습니다.</p>;
  }
  return (
    <table className="border-hairline w-full border-collapse border">
      <thead>
        <tr className="bg-surface text-body-sm text-slate text-left">
          <th className="px-md py-sm font-medium">제목</th>
          <th className="px-md py-sm font-medium">채널</th>
          <th className="px-md py-sm font-medium">길이</th>
          <th className="px-md py-sm font-medium">숏츠</th>
          <th className="px-md py-sm font-medium">상태</th>
          <th className="px-md py-sm font-medium">완료 시각</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr
            key={j.id}
            onClick={() => onRowClick(j.id)}
            className="border-hairline hover:bg-surface text-body-sm cursor-pointer border-t"
          >
            <td className="px-md py-sm text-ink font-semibold">{j.title}</td>
            <td className="px-md py-sm text-slate">{j.channel ?? '—'}</td>
            <td className="px-md py-sm text-slate">{formatDuration(j.durationSec)}</td>
            <td className="px-md py-sm text-slate">{j.shortCount}</td>
            <td className="px-md py-sm text-slate">{statusLabel(j.status)}</td>
            <td className="px-md py-sm text-slate">{formatDate(j.finishedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Create `src/renderer/components/history/HistoryGridView.tsx` with EXACTLY this content**

```tsx
import type { JobSummary } from '@shared/history';

interface Props {
  jobs: JobSummary[];
  onRowClick: (jobId: string) => void;
}

export function HistoryGridView({ jobs, onRowClick }: Props) {
  if (jobs.length === 0) {
    return <p className="text-body-md text-slate p-md">기록이 없습니다.</p>;
  }
  return (
    <div className="gap-lg grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {jobs.map((j) => (
        <button
          key={j.id}
          type="button"
          onClick={() => onRowClick(j.id)}
          className="bg-canvas border-hairline hover:shadow-2 cursor-pointer overflow-hidden rounded-xl border text-left transition-shadow"
        >
          <div className="bg-surface aspect-video w-full">
            {j.sourceThumb ? (
              <img src={j.sourceThumb} alt={j.title} className="h-full w-full object-cover" loading="lazy" />
            ) : null}
          </div>
          <div className="p-md gap-xs flex flex-col">
            <p className="text-body-md text-ink line-clamp-2 font-semibold">{j.title}</p>
            <p className="text-body-sm text-slate">
              {j.channel ?? '—'} · 숏츠 {j.shortCount}개
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/renderer/components/history/HistoryListView.tsx src/renderer/components/history/HistoryGridView.tsx
yarn lint && yarn typecheck
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/history/HistoryListView.tsx src/renderer/components/history/HistoryGridView.tsx
git commit -m "feat(m9): add HistoryListView and HistoryGridView presentation components"
```

---

### Task 11: JobDetailDrawer component

**Files:**

- Create: `src/renderer/components/history/JobDetailDrawer.tsx`

Side drawer shown when a row is clicked. Loads `JobDetail` via IPC, shows job header + per-short list + open-folder button.

- [ ] **Step 1: Create `src/renderer/components/history/JobDetailDrawer.tsx` with EXACTLY this content**

```tsx
import { useEffect, useState } from 'react';

import type { JobDetail } from '@shared/history';

interface Props {
  jobId: string | null;
  onClose: () => void;
  onDelete: (jobId: string) => void;
}

export function JobDetailDrawer({ jobId, onClose, onDelete }: Props) {
  const [detail, setDetail] = useState<JobDetail | null>(null);

  useEffect(() => {
    if (!jobId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void window.api.historyGetDetail(jobId).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (!jobId) return null;

  return (
    <aside className="bg-canvas border-hairline shadow-2 fixed inset-y-0 right-0 w-[480px] overflow-y-auto border-l">
      <div className="p-xl gap-md flex flex-col">
        <div className="flex items-start justify-between">
          <h2 className="text-card-title text-ink font-semibold">{detail?.job.title ?? '로딩 중...'}</h2>
          <button type="button" onClick={onClose} className="text-body-md text-slate hover:text-ink" aria-label="Close">
            ×
          </button>
        </div>
        {detail ? (
          <>
            <p className="text-body-sm text-slate">
              {detail.job.channel ?? '—'} · 숏츠 {detail.shorts.length}개
            </p>
            <ol className="gap-sm flex flex-col">
              {detail.shorts.map((s) => (
                <li key={s.id} className="bg-surface p-md rounded-lg">
                  <p className="text-body-md text-ink font-semibold">
                    #{s.idx} {s.title}
                  </p>
                  {s.hook ? <p className="text-body-sm text-slate mt-xs">{s.hook}</p> : null}
                  <p className="text-body-sm text-slate mt-xs break-all">{s.outputPath}</p>
                </li>
              ))}
            </ol>
            <div className="gap-sm flex">
              <button
                type="button"
                onClick={() => {
                  if (detail.shorts[0]?.outputPath) {
                    void window.api.revealInFolder(detail.shorts[0].outputPath);
                  }
                }}
                className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
              >
                폴더 열기
              </button>
              <button
                type="button"
                onClick={() => {
                  onDelete(detail.job.id);
                  onClose();
                }}
                className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
              >
                삭제
              </button>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/renderer/components/history/JobDetailDrawer.tsx
yarn lint && yarn typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/history/JobDetailDrawer.tsx
git commit -m "feat(m9): add JobDetailDrawer with per-short list and reveal/delete actions"
```

---

### Task 12: Wire HistoryPage with toolbar + view + drawer

**Files:**

- Modify: `src/renderer/pages/History.tsx`

Replaces the M1 stub with the working page.

- [ ] **Step 1: Replace `src/renderer/pages/History.tsx` ENTIRELY with**

```tsx
import { useState } from 'react';

import { HistoryGridView } from '@renderer/components/history/HistoryGridView';
import { HistoryListView } from '@renderer/components/history/HistoryListView';
import { JobDetailDrawer } from '@renderer/components/history/JobDetailDrawer';
import { useHistory } from '@renderer/hooks/useHistory';
import type { JobStatus } from '@shared/history';

const STATUS_OPTIONS: { value: JobStatus; label: string }[] = [
  { value: 'done', label: '완료' },
  { value: 'partial_done', label: '부분' },
  { value: 'failed', label: '실패' },
  { value: 'canceled', label: '취소' },
];

export function HistoryPage() {
  const { query, setQuery, state, refresh } = useHistory();
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const toggleStatus = (s: JobStatus) => {
    setQuery((q) => ({
      ...q,
      statusFilter: q.statusFilter.includes(s) ? q.statusFilter.filter((x) => x !== s) : [...q.statusFilter, s],
    }));
  };

  return (
    <section className="gap-xl p-section flex flex-col">
      <header>
        <h1 className="text-heading-md text-ink font-semibold">히스토리</h1>
      </header>

      <div className="gap-md flex items-center">
        <input
          type="search"
          value={query.search}
          onChange={(e) => setQuery((q) => ({ ...q, search: e.target.value }))}
          placeholder="제목, 채널, 하이라이트 검색..."
          className="border-hairline px-md text-body-md h-10 flex-1 rounded-full border"
        />
        <select
          value={query.sortBy}
          onChange={(e) => setQuery((q) => ({ ...q, sortBy: e.target.value as typeof q.sortBy }))}
          className="border-hairline px-md text-body-md h-10 rounded-full border"
        >
          <option value="newest">최신순</option>
          <option value="title">제목순</option>
          <option value="duration">길이순</option>
        </select>
        <button
          type="button"
          onClick={() => setView((v) => (v === 'list' ? 'grid' : 'list'))}
          className="border-hairline px-md text-body-md h-10 rounded-full border"
        >
          {view === 'list' ? '그리드 보기' : '리스트 보기'}
        </button>
      </div>

      <div className="gap-sm flex">
        {STATUS_OPTIONS.map((opt) => {
          const active = query.statusFilter.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggleStatus(opt.value)}
              className={`px-md text-body-sm h-8 rounded-full border ${
                active ? 'bg-primary text-on-primary border-primary' : 'border-hairline text-slate'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {state.status === 'loading' ? <p className="text-body-md text-slate">로딩 중...</p> : null}
      {state.status === 'error' ? <p className="text-body-md text-brand-coral">오류: {state.error.message}</p> : null}
      {state.status === 'done' ? (
        view === 'list' ? (
          <HistoryListView jobs={state.jobs} onRowClick={setActiveJobId} />
        ) : (
          <HistoryGridView jobs={state.jobs} onRowClick={setActiveJobId} />
        )
      ) : null}

      <JobDetailDrawer
        jobId={activeJobId}
        onClose={() => setActiveJobId(null)}
        onDelete={async (id) => {
          await window.api.historyDelete(id);
          refresh();
        }}
      />
    </section>
  );
}
```

- [ ] **Step 2: Format + verify**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/renderer/pages/History.tsx
yarn lint && yarn typecheck && yarn test 2>&1 | tail -8
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/pages/History.tsx
git commit -m "feat(m9): wire HistoryPage with toolbar, list/grid views, and detail drawer"
```

---

### Task 13: Smoke test for HistoryPage

**Files:**

- Create: `tests/renderer/History.test.tsx`

One test: page loads, calls `historyList`, renders the returned jobs in list view.

- [ ] **Step 1: Create `tests/renderer/History.test.tsx` with EXACTLY this content**

```tsx
import { HistoryPage } from '@renderer/pages/History';
import type { JobSummary } from '@shared/history';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function installApiMock(jobs: JobSummary[] = []) {
  const calls = {
    historyList: vi.fn(async () => jobs),
    historyGetDetail: vi.fn(async () => null),
    historyDelete: vi.fn(async () => undefined),
  };
  const api = {
    getAppVersion: vi.fn(async () => '0.0.1'),
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({}) as never),
    resetSettings: vi.fn(async () => ({}) as never),
    hasApiKey: vi.fn(async () => false),
    setApiKey: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
    pickFolder: vi.fn(async () => null),
    fetchVideoPreview: vi.fn(async () => ({}) as never),
    downloadVideo: vi.fn(async () => ({}) as never),
    cancelDownload: vi.fn(async () => undefined),
    onDownloadProgress: vi.fn(() => () => undefined),
    transcribeFile: vi.fn(async () => ({}) as never),
    cancelTranscribe: vi.fn(async () => undefined),
    onTranscribeProgress: vi.fn(() => () => undefined),
    sidecarHealth: vi.fn(async () => ({ ok: true, modelsLoaded: [] })),
    extractHighlights: vi.fn(async () => ({}) as never),
    cancelExtract: vi.fn(async () => undefined),
    onExtractProgress: vi.fn(() => () => undefined),
    renderShorts: vi.fn(async () => ({ outputDir: '', results: [] })),
    cancelRender: vi.fn(async () => undefined),
    onRenderProgress: vi.fn(() => () => undefined),
    historyList: calls.historyList,
    historyGetDetail: calls.historyGetDetail,
    historyDelete: calls.historyDelete,
    revealInFolder: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
  };
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true });
  return calls;
}

const fakeJob: JobSummary = {
  id: 'j1',
  videoId: 'abc',
  title: 'My Talk',
  channel: 'Bob',
  durationSec: 600,
  sourceThumb: null,
  status: 'done',
  shortCount: 3,
  createdAt: 1000,
  finishedAt: 1100,
};

describe('HistoryPage', () => {
  beforeEach(() => {
    installApiMock([fakeJob]);
  });

  it('calls historyList on mount and renders the returned jobs in list view', async () => {
    render(<HistoryPage />);
    await waitFor(() => expect(screen.getByText('My Talk')).toBeInTheDocument());
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // shortCount = 3 appears in list view
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('toggles between list and grid views', async () => {
    const user = userEvent.setup();
    render(<HistoryPage />);
    await waitFor(() => screen.getByText('My Talk'));
    // Default = list view, button text says "그리드 보기"
    const toggle = screen.getByRole('button', { name: '그리드 보기' });
    await user.click(toggle);
    // Now in grid view, button text flips
    await waitFor(() => expect(screen.getByRole('button', { name: '리스트 보기' })).toBeInTheDocument());
  });

  it('updates the search query on typing and re-fetches', async () => {
    const calls = installApiMock([fakeJob]);
    const user = userEvent.setup();
    render(<HistoryPage />);
    await waitFor(() => expect(calls.historyList).toHaveBeenCalled());
    const search = screen.getByPlaceholderText(/제목, 채널/);
    await user.type(search, 'AI');
    await waitFor(() => expect(calls.historyList).toHaveBeenCalledWith(expect.objectContaining({ search: 'AI' })));
  });
});
```

- [ ] **Step 2: Run the test file**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test tests/renderer/History.test.tsx
```

Expected: 3 passed.

- [ ] **Step 3: Run the full suite**

```bash
yarn test
```

Expected: 142 prior + 10 HistoryRepo + 3 ThumbnailService + 7 HistoryService + 3 HistoryPage = 165 vitest. No regressions.

- [ ] **Step 4: Commit**

```bash
git add tests/renderer/History.test.tsx
git commit -m "test(m9): smoke tests for HistoryPage list view + view toggle + search"
```

---

### Task 14: DoD verification + README + finalize branch

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Run all DoD checks**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn typecheck && yarn lint && yarn test && yarn build
cd sidecar && uv run pytest && cd ..
```

Expected: all green. Vitest 165, pytest 24 (unchanged from M7).

- [ ] **Step 2: Manual integration check**

```bash
yarn dev
```

In the app:

1. Run a fresh pipeline (preview → download → STT → highlights → render). Confirm shorts are produced.
2. Click 히스토리 in the sidebar — the new render should appear at top.
3. Type a search term matching the title — list should filter.
4. Toggle to grid view — should show YouTube thumbnails (loaded from `sourceThumb` URLs) and titles.
5. Click a job row → detail drawer opens on right with per-short list. Click "폴더 열기" → Finder opens to the output folder.
6. Click "삭제" → row disappears from list.
7. Filter chips: click 완료 → only done jobs remain.
8. Sort dropdown: pick 제목순 → alphabetical.

If something is broken, fix and re-test BEFORE continuing.

- [ ] **Step 3: Update README status**

```markdown
## Status

- ✅ M1 — M8 (see above)
- ✅ M9: History persistence — better-sqlite3 + FTS5, per-short ffmpeg thumbnails, list/grid view toggle, search/sort/status-filter, detail drawer with reveal/delete.
- ⏳ M10: Packaging & distribution (next)
```

- [ ] **Step 4: Commit + push branch**

```bash
yarn prettier --write README.md
git add README.md
git commit -m "docs(m9): mark milestone 9 complete in README"
git push -u origin m9-history-persistence
```

- [ ] **Step 5: Merge to master + tag**

(Done by the controller via `superpowers:finishing-a-development-branch` skill — see DoD below.)

---

## Definition of Done (M9)

1. `yarn typecheck`, `yarn lint` (only known `__dirname` warning), `yarn test`, `yarn build` all exit 0.
2. `cd sidecar && uv run pytest` reports 24 passing (unchanged).
3. `yarn test` includes new test files: HistoryRepo (10), ThumbnailService (3), HistoryService (7), History.test.tsx (3). Total expected: 142 prior + 23 = 165. No regressions.
4. Manual integration: real `yarn dev` run completes a full pipeline, the rendered job appears in History, search/sort/filter work, detail drawer reveals/deletes successfully.
5. Branch `m9-history-persistence` pushed to origin.
6. After review, branch merged to master with `--no-ff` and tagged `m9-complete` on master.

## What's NOT in M9 (intentionally deferred)

- **Date-range filter**: only status filter is implemented in v1. Date-range UI + repo support is M10.
- **LLM-model filter**: spec mentions it but UI is omitted. Repo can already filter on `llm_model` if added later.
- **Per-step status updates**: jobs are written only at render-completion. Mid-pipeline failures (download/STT/highlights crash before render) don't appear in history. Acceptable for M9 — those errors surface in the NewJob page.
- **Job edit/re-run**: no "re-render" or "edit highlights" action from the detail drawer. Delete only.
- **Bulk actions**: no multi-select or bulk delete.
- **Source thumbnail download**: `sourceThumb` is the YouTube CDN URL stored as-is; the renderer uses it as `<img src>`. No local copy. If YouTube ever scrubs the thumb (rare), the row goes thumb-less. Future-proof in M10 with a local cache.
- **DB backup/export**: no UI for exporting history.db. Power users can copy `<App Data>/history.db` themselves.
- **Migrations beyond v1**: schema is created with `IF NOT EXISTS` for forward compat; no version table or rollback. M10 should add a `schema_version` row + simple up-migration.
- **Real-time history refresh**: the History page only refreshes on mount and after delete. If a render finishes while you're on History, you need to navigate away and back. Acceptable for M9 — most users render then look.
- **`settings.ui.historyView` consumption**: M9's view toggle uses local `useState` instead of reading/writing the persisted `settings.ui.historyView`. The setting was added in M2 but isn't yet wired. Trivial M10 follow-up: replace `useState` with `useSettings`-backed read + `update({ ui: { ... } })`.

## Notes for the implementing agent

- Start the milestone branch BEFORE Task 1 (already done — confirm `git branch --show-current` shows `m9-history-persistence` before starting).
- The bob-park ESLint config bans `../*` parent imports — use `@renderer/*`, `@shared/*` aliases.
- `better-sqlite3` is synchronous. The IPC handlers are still `async` for consistency with the rest, but the repo methods inside don't await anything.
- `pragma: foreign_keys = ON` MUST run before any DML or CASCADE deletes won't work. The HistoryRepo constructor handles this.
- FTS5 sync is done by `refreshSearchIndex` (a manual rebuild per affected job) rather than triggers, because `crypto.randomUUID()`-based IDs make the trigger logic fragile. Performance is fine for the M9 scale (hundreds of jobs).
- The `<audioPath>.meta.json` write is non-fatal — if it fails the download still succeeds. The render-time history record then falls back to a stub ("Unknown title") OR can skip recording entirely (M9 chooses to skip for cleanliness).
- The detail drawer is a fixed-positioned `aside` overlaid on the right. It does NOT use a routing library — opening/closing is plain `useState`. This avoids react-router complexity for a transient UI.
