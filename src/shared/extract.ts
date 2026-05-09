import { z } from 'zod';

export const ExtractProgressSchema = z.object({
  jobId: z.string().min(1),
  /** 1-based chunk index currently being processed. */
  chunkIndex: z.number().int().positive(),
  /** Total chunks in the plan (1 if the whole transcript fits in one call). */
  chunkTotal: z.number().int().positive(),
  /** Discriminator for which phase we're in. */
  phase: z.enum(['chunk', 'rerank']),
});
export type ExtractProgress = z.infer<typeof ExtractProgressSchema>;

export type ExtractStatus = 'missing-key' | 'idle' | 'extracting' | 'done' | 'canceled' | 'error';
