import { z } from 'zod';

export const ExtractProgressSchema = z.object({
  jobId: z.string().min(1),
  /** 1-based chunk index currently being processed. 0 for the 'download' phase. */
  chunkIndex: z.number().int().nonnegative(),
  /** Total chunks in the plan (1 if the whole transcript fits in one call). 0 for 'download'. */
  chunkTotal: z.number().int().nonnegative(),
  /** Discriminator for which phase we're in. */
  phase: z.enum(['download', 'chunk', 'rerank']),
  /** Bytes downloaded so far (only set when phase==='download'). */
  downloadedBytes: z.number().int().nonnegative().optional(),
  /** Total bytes to download (only set when phase==='download'). */
  totalBytes: z.number().int().nonnegative().optional(),
});
export type ExtractProgress = z.infer<typeof ExtractProgressSchema>;

export type ExtractStatus = 'idle' | 'downloading-model' | 'extracting' | 'done' | 'canceled' | 'error';
