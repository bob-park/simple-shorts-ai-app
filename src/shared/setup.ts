import { z } from 'zod';

export type SetupStatus = 'pending' | 'ready' | 'failed';

export const SetupProgressSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('venv'), pct: z.number().min(0).max(1) }),
  z.object({
    phase: z.literal('pip'),
    pct: z.number().min(0).max(1),
    current: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    currentPackage: z.string().optional(),
  }),
]);
export type SetupProgress = z.infer<typeof SetupProgressSchema>;
