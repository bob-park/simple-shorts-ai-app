import type { HistoryListQuery, Job, JobStatus, JobSummary, Short } from '@shared/history';
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
    // Wrap both in a transaction so a process crash between them can't leave
    // a dangling FTS row pointing at a now-deleted job.
    const tx = this._db.transaction(() => {
      this._db.prepare('DELETE FROM search_idx WHERE job_id = ?').run(id);
      this._db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    });
    tx();
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
