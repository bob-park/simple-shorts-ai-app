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
