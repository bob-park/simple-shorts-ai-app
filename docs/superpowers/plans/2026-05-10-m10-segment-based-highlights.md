# M10: Segment-Based Highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M5's word-level highlight extraction with non-contiguous Whisper-segment montages. The LLM picks `segment_indices` instead of raw time ranges; each highlight becomes one mp4 produced via ffmpeg's single-pass `select` filter. M7 face tracking and M8 subtitle burn-in keep working — both rebase timestamps to montage-relative time.

**Architecture:** `Highlight.segments[]` (1+ time ranges) supersedes flat `start_sec/end_sec`. `ChunkPlanner` chunks by segments instead of words. `HighlightService` sends segments-by-index to the LLM, parses index responses, validates duration. New `MontageHelpers` module exposes pure `rebaseTrackingFrames` + `rebaseTranscriptWords` helpers that translate source-time data into montage-relative time. `RenderService.buildCenterArgs` / `buildTrackedArgs` produce `select` / `aselect` ffmpeg expressions over the segments array. Single-segment highlights are a degenerate case — the same code path produces the same output as M6/M7 did before.

**Tech Stack:** No new deps. Pure-TypeScript pipeline change touching `src/shared/highlight.ts`, `src/main/services/{ChunkPlanner,HighlightService,RenderService,MontageHelpers}.ts`, and `src/renderer/components/newjob/HighlightCard.tsx`. ffmpeg's existing `select` + `setpts=N/FRAME_RATE/TB` (and `aselect` + `asetpts=N/SR/TB`) handle the multi-range concat; libass + sendcmd compose downstream of `select` in the filter chain. Spec: `docs/superpowers/specs/2026-05-10-segment-based-highlights-design.md`.

---

## File Structure

```
src/
├── shared/
│   └── highlight.ts                          # MODIFY: HighlightSegmentSchema + segments[] in HighlightSchema
├── main/
│   ├── main.ts                               # MODIFY: small adjustment if any (mostly type-flow)
│   └── services/
│       ├── ChunkPlanner.ts                   # MODIFY: rewrite for segments instead of words
│       ├── ChunkPlanner.test.ts              # MODIFY: rewrite tests for segments
│       ├── HighlightService.ts               # MODIFY: segment-indices contract + index translation + sort/dedup
│       ├── HighlightService.test.ts          # MODIFY: rewrite tests for segment-based responses
│       ├── MontageHelpers.ts                 # NEW: rebaseTrackingFrames + rebaseTranscriptWords (pure)
│       ├── MontageHelpers.test.ts            # NEW: vitest pure tests
│       ├── RenderService.ts                  # MODIFY: select-filter args + helpers integration + first/last derivation
│       └── RenderService.test.ts             # MODIFY: rewrite fixtures, +5 multi-segment cases
└── renderer/
    └── components/newjob/HighlightCard.tsx   # MODIFY: done state shows segment count + total duration

tests/renderer/
└── NewJob.test.tsx                           # MODIFY: smoke test mock uses new highlights shape

README.md                                     # MODIFY: rename M10→M11, add M10 entry
```

**Decomposition rationale:**

- `MontageHelpers` is a separate file because both tracking-frame rebasing and word rebasing are pure functions used by `RenderService` — they're easy to unit-test in isolation, and keep `RenderService` from growing past ~250 lines.
- `ChunkPlanner` and `HighlightService` rewrites stay in their existing files — same shape, different unit (segments vs words). No new abstractions.
- `HighlightCard` keeps the existing single-range form when `segments.length === 1`; only the multi-segment branch is new. This avoids a regression in look-and-feel for the simple case.

---

## Tasks

### Task 1: Shared `Highlight` schema rewrite

**Files:**

- Modify: `src/shared/highlight.ts`

This task **intentionally** breaks downstream typechecks (`HighlightService`, `RenderService`, test fixtures). Subsequent tasks fix each consumer.

- [ ] **Step 1: Read current `src/shared/highlight.ts`**

The current `HighlightSchema` has flat `start_sec` / `end_sec`. Replace it.

- [ ] **Step 2: Replace `src/shared/highlight.ts` ENTIRELY with**

```ts
import { z } from 'zod';

/** One time range in source video time. */
export const HighlightSegmentSchema = z
  .object({
    start_sec: z.number().nonnegative(),
    end_sec: z.number().nonnegative(),
  })
  .refine((v) => v.end_sec > v.start_sec, {
    message: 'end_sec must be greater than start_sec',
    path: ['end_sec'],
  });
export type HighlightSegment = z.infer<typeof HighlightSegmentSchema>;

/**
 * One highlight clip the LLM picked out of the transcript. Composed of one or
 * more non-contiguous time ranges (segments) — the renderer concatenates them
 * into a single mp4 via ffmpeg's `select` filter. Single-range highlights are
 * just `segments.length === 1` — degenerate case, same render path.
 */
export const HighlightSchema = z.object({
  segments: z.array(HighlightSegmentSchema).min(1),
  title: z.string().min(1),
  /** One-line hook describing why this clip would grab a viewer. */
  hook: z.string().min(1),
});
export type Highlight = z.infer<typeof HighlightSchema>;

/** Persisted alongside the source video as `<videoStem>.highlights.json`. */
export const HighlightSetSchema = z.object({
  /** ISO 8601 timestamp the LLM call completed. */
  generatedAt: z.string().min(1),
  /** Model id passed to OpenRouter, e.g. 'anthropic/claude-sonnet-4.5'. */
  model: z.string().min(1),
  /** Absolute path of the source video this set was generated from. */
  audioPath: z.string().min(1),
  highlights: z.array(HighlightSchema),
});
export type HighlightSet = z.infer<typeof HighlightSetSchema>;
```

- [ ] **Step 3: Format + DON'T run tests yet (we know they break)**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn prettier --write src/shared/highlight.ts
yarn typecheck 2>&1 | head -20
```

Expected: typecheck FAILS in `HighlightService.ts`, `RenderService.ts`, `HistoryService.ts`, `HighlightService.test.ts`, `RenderService.test.ts`, `HistoryService.test.ts`, `tests/renderer/NewJob.test.tsx`. These will be fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/shared/highlight.ts
git commit -m "feat(m10): rewrite Highlight schema with segments[] (replaces flat start_sec/end_sec)"
```

---

### Task 2: `ChunkPlanner` rewrite for segments (TDD)

**Files:**

- Modify: `src/main/services/ChunkPlanner.ts`
- Modify: `src/main/services/ChunkPlanner.test.ts`

The shape is identical to the M5 word-based planner; only the unit changes (segments instead of words). Add a `firstIndex` field on `ChunkRange` so `HighlightService` can rebase chunk-local indices to global.

- [ ] **Step 1: Replace `src/main/services/ChunkPlanner.test.ts` ENTIRELY with**

```ts
import { describe, expect, it } from 'vitest';

import { planChunks } from './ChunkPlanner';

function fakeSegments(count: number, startSec = 0): { start: number; end: number; text: string }[] {
  // Each fake segment is 5s long, contiguous starting at startSec.
  return Array.from({ length: count }, (_, i) => ({
    start: startSec + i * 5,
    end: startSec + (i + 1) * 5,
    text: `seg${i}`,
  }));
}

describe('planChunks (segment-based)', () => {
  it('returns a single chunk when segment count is below the threshold', () => {
    const segs = fakeSegments(50);
    const plan = planChunks(segs, { threshold: 150, chunkSize: 100, overlap: 10 });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.needsRerank).toBe(false);
    expect(plan.chunks[0]!.segments).toHaveLength(50);
    expect(plan.chunks[0]!.firstIndex).toBe(0);
    expect(plan.chunks[0]!.startSec).toBe(0);
    expect(plan.chunks[0]!.endSec).toBe(50 * 5);
  });

  it('splits into overlapping chunks when above threshold and tracks firstIndex globally', () => {
    const segs = fakeSegments(280);
    const plan = planChunks(segs, { threshold: 150, chunkSize: 100, overlap: 10 });
    expect(plan.needsRerank).toBe(true);
    // step = 90; starts at 0, 90, 180, 270 (last is short)
    expect(plan.chunks).toHaveLength(4);
    expect(plan.chunks[0]!.firstIndex).toBe(0);
    expect(plan.chunks[1]!.firstIndex).toBe(90);
    expect(plan.chunks[2]!.firstIndex).toBe(180);
    expect(plan.chunks[3]!.firstIndex).toBe(270);
  });

  it('chunk start/end seconds match the wrapped segment range', () => {
    const segs = fakeSegments(280);
    const plan = planChunks(segs, { threshold: 150, chunkSize: 100, overlap: 10 });
    // Chunk 1: indices 90..189 → startSec=90*5=450, endSec=Math.min(190,280)*5=950
    expect(plan.chunks[1]!.startSec).toBe(450);
    expect(plan.chunks[1]!.endSec).toBe(950);
  });

  it('returns an empty chunk list when given no segments', () => {
    const plan = planChunks([], { threshold: 150, chunkSize: 100, overlap: 10 });
    expect(plan.chunks).toHaveLength(0);
    expect(plan.needsRerank).toBe(false);
  });

  it('clamps overlap so that chunk step is always positive', () => {
    expect(() => planChunks(fakeSegments(200), { threshold: 1, chunkSize: 100, overlap: 100 })).toThrow(
      /overlap must be smaller than chunkSize/i,
    );
  });
});
```

- [ ] **Step 2: Run tests — should fail (`ChunkPlanner` API mismatch)**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn test src/main/services/ChunkPlanner.test.ts
```

Expected: tests fail because the existing `ChunkPlanner` operates on words and returns `words` not `segments`, and lacks `firstIndex`.

- [ ] **Step 3: Replace `src/main/services/ChunkPlanner.ts` ENTIRELY with**

```ts
import type { Segment } from '@shared/transcript';

export interface ChunkPlannerOptions {
  /** Above this segment count, split into multiple chunks + final rerank. */
  threshold: number;
  /** Segments per chunk when splitting. */
  chunkSize: number;
  /**
   * Overlap (in segments) between adjacent chunks. Helps the LLM not chop a
   * highlight across a chunk boundary.
   */
  overlap: number;
}

export interface ChunkPlan {
  /** Whether the orchestrator needs a final rerank LLM call. */
  needsRerank: boolean;
  chunks: ChunkRange[];
}

export interface ChunkRange {
  /** 1-based index of this chunk in the plan, useful for progress reporting. */
  index: number;
  /** Slice of the source segments array. */
  segments: Segment[];
  /** Global index of segments[0] in the source array — used for index rebasing. */
  firstIndex: number;
  /** Convenience: first segment's start time (seconds). */
  startSec: number;
  /** Convenience: last segment's end time (seconds). */
  endSec: number;
}

/**
 * Decides how to feed a transcript segments list to the LLM.
 *
 * - If `segments.length < threshold`, returns one chunk and skips the rerank.
 * - Otherwise walks the segments array in `chunkSize` windows that step
 *   forward by `chunkSize - overlap` each iteration.
 *
 * Pure function — no IO, no side effects.
 */
export function planChunks(segments: Segment[], opts: ChunkPlannerOptions): ChunkPlan {
  if (opts.overlap >= opts.chunkSize) {
    throw new Error(
      `ChunkPlanner: overlap must be smaller than chunkSize (got overlap=${opts.overlap}, chunkSize=${opts.chunkSize})`,
    );
  }
  if (segments.length === 0) return { needsRerank: false, chunks: [] };
  if (segments.length < opts.threshold) {
    return {
      needsRerank: false,
      chunks: [
        {
          index: 1,
          segments,
          firstIndex: 0,
          startSec: segments[0]!.start,
          endSec: segments[segments.length - 1]!.end,
        },
      ],
    };
  }
  const step = opts.chunkSize - opts.overlap;
  const chunks: ChunkRange[] = [];
  let i = 0;
  while (i < segments.length) {
    const slice = segments.slice(i, i + opts.chunkSize);
    if (slice.length === 0) break;
    chunks.push({
      index: chunks.length + 1,
      segments: slice,
      firstIndex: i,
      startSec: slice[0]!.start,
      endSec: slice[slice.length - 1]!.end,
    });
    i += step;
  }
  return { needsRerank: true, chunks };
}
```

- [ ] **Step 4: Run tests — should pass 5/5**

```bash
yarn test src/main/services/ChunkPlanner.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/ChunkPlanner.ts src/main/services/ChunkPlanner.test.ts
git add src/main/services/ChunkPlanner.ts src/main/services/ChunkPlanner.test.ts
git commit -m "feat(m10): rewrite ChunkPlanner for segments instead of words"
```

---

### Task 3: `HighlightService` rewrite (TDD)

**Files:**

- Modify: `src/main/services/HighlightService.ts`
- Modify: `src/main/services/HighlightService.test.ts`

Service now sends `segments` (numbered by global index) and gets back `segment_indices` per highlight. Service maps indices → time ranges, dedupes, sorts, and filters by total duration.

- [ ] **Step 1: Replace `src/main/services/HighlightService.test.ts` ENTIRELY with**

```ts
import type { Segment, Transcript } from '@shared/transcript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HighlightService } from './HighlightService';

function fakeSegments(count: number, durationEach = 5): Segment[] {
  return Array.from({ length: count }, (_, i) => ({
    start: i * durationEach,
    end: (i + 1) * durationEach,
    text: `segment ${i}`,
  }));
}

function makeTranscript(segmentCount: number, durationEach = 5): Transcript {
  const segments = fakeSegments(segmentCount, durationEach);
  return {
    duration: segmentCount * durationEach,
    language: 'en',
    segments,
    words: [],
  };
}

describe('HighlightService (segment-based)', () => {
  let chatJson: ReturnType<typeof vi.fn>;
  let client: { chatJson: typeof chatJson };
  let service: HighlightService;

  beforeEach(() => {
    chatJson = vi.fn();
    client = { chatJson };
    service = new HighlightService(client as never);
  });

  it('makes one LLM call for short transcripts and maps segment indices to time ranges', async () => {
    chatJson.mockResolvedValue({
      highlights: [
        { segment_indices: [0, 1], title: 'Opener', hook: 'It starts strong' },
        { segment_indices: [3, 4, 5], title: 'Mid', hook: 'Big reveal' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(50),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 2,
      minSec: 5,
      maxSec: 60,
    });
    expect(chatJson).toHaveBeenCalledTimes(1);
    expect(result.highlights).toHaveLength(2);
    expect(result.highlights[0]!.segments).toEqual([
      { start_sec: 0, end_sec: 5 },
      { start_sec: 5, end_sec: 10 },
    ]);
    expect(result.highlights[1]!.segments).toEqual([
      { start_sec: 15, end_sec: 20 },
      { start_sec: 20, end_sec: 25 },
      { start_sec: 25, end_sec: 30 },
    ]);
  });

  it('dedupes duplicate indices in the same highlight', async () => {
    chatJson.mockResolvedValue({
      highlights: [{ segment_indices: [0, 1, 1, 0], title: 'A', hook: 'h' }],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights[0]!.segments).toHaveLength(2);
  });

  it('sorts segments chronologically regardless of LLM output order', async () => {
    chatJson.mockResolvedValue({
      highlights: [{ segment_indices: [5, 0, 3], title: 'A', hook: 'h' }],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights[0]!.segments.map((s) => s.start_sec)).toEqual([0, 15, 25]);
  });

  it('drops highlights with out-of-bounds segment indices', async () => {
    chatJson.mockResolvedValue({
      highlights: [
        { segment_indices: [0, 1], title: 'Valid', hook: 'h' },
        { segment_indices: [99, 100], title: 'Invalid', hook: 'h' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(10),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 5,
      minSec: 5,
      maxSec: 60,
    });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]!.title).toBe('Valid');
  });

  it('drops highlights whose total duration falls outside [minSec, maxSec]', async () => {
    chatJson.mockResolvedValue({
      highlights: [
        // 1 segment × 5s = 5s — too short for minSec=20
        { segment_indices: [0], title: 'TooShort', hook: 'h' },
        // 5 segments × 5s = 25s — within [20, 60]
        { segment_indices: [0, 1, 2, 3, 4], title: 'Good', hook: 'h' },
        // 14 segments × 5s = 70s — exceeds maxSec=60
        { segment_indices: Array.from({ length: 14 }, (_, i) => i), title: 'TooLong', hook: 'h' },
      ],
    });
    const result = await service.extract({
      transcript: makeTranscript(20),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 5,
      minSec: 20,
      maxSec: 60,
    });
    expect(result.highlights.map((h) => h.title)).toEqual(['Good']);
  });

  it('rebases chunk-local indices to global when running multi-chunk + rerank', async () => {
    // 200 segments → 2 chunks (chunkSize=100, overlap=10 → step=90)
    //   chunk 0: indices 0..99    (firstIndex=0)
    //   chunk 1: indices 90..189  (firstIndex=90)
    //   chunk 2: indices 180..199 (firstIndex=180)
    chatJson
      .mockResolvedValueOnce({
        // chunk 0 returns local index 5 → global 5
        highlights: [{ segment_indices: [5, 6], title: 'C0', hook: 'h' }],
      })
      .mockResolvedValueOnce({
        // chunk 1 returns local index 0 → global 90
        highlights: [{ segment_indices: [0, 1], title: 'C1', hook: 'h' }],
      })
      .mockResolvedValueOnce({
        // chunk 2 returns local index 5 → global 185
        highlights: [{ segment_indices: [5, 6], title: 'C2', hook: 'h' }],
      })
      .mockResolvedValueOnce({
        // rerank: pick the one spanning global 90..91
        highlights: [{ segment_indices: [90, 91], title: 'C1', hook: 'h' }],
      });
    const result = await service.extract({
      transcript: makeTranscript(200),
      audioPath: '/x.mp4',
      apiKey: 'k',
      model: 'm',
      count: 1,
      minSec: 5,
      maxSec: 60,
    });
    expect(chatJson).toHaveBeenCalledTimes(4); // 3 chunks + 1 rerank
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]!.segments).toEqual([
      { start_sec: 450, end_sec: 455 }, // segment 90
      { start_sec: 455, end_sec: 460 }, // segment 91
    ]);
  });

  it('throws MissingApiKeyError when apiKey is empty', async () => {
    await expect(
      service.extract({
        transcript: makeTranscript(10),
        audioPath: '/x.mp4',
        apiKey: '',
        model: 'm',
        count: 1,
        minSec: 5,
        maxSec: 60,
      }),
    ).rejects.toThrow(/OpenRouter API key is not set/i);
    expect(chatJson).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — should fail (response shape mismatch + no segment-indices logic)**

```bash
yarn test src/main/services/HighlightService.test.ts
```

- [ ] **Step 3: Replace `src/main/services/HighlightService.ts` ENTIRELY with**

```ts
import { type ExtractProgress } from '@shared/extract';
import { type Highlight, HighlightSchema, type HighlightSet } from '@shared/highlight';
import { type Segment, type Transcript } from '@shared/transcript';
import { z } from 'zod';

import { type ChunkRange, planChunks } from './ChunkPlanner';

interface ClientLike {
  chatJson(opts: {
    apiKey: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface ExtractOptions {
  transcript: Transcript;
  audioPath: string;
  apiKey: string;
  model: string;
  /** How many highlights the LLM should return. */
  count: number;
  minSec: number;
  maxSec: number;
}

type ProgressHandler = (p: ExtractProgress) => void;

const RawHighlightSchema = z.object({
  segment_indices: z.array(z.number().int().nonnegative()),
  title: z.string().min(1),
  hook: z.string().min(1),
});
const RawResponseSchema = z.object({ highlights: z.array(RawHighlightSchema) });

const SYSTEM_PROMPT = (count: number, minSec: number, maxSec: number) =>
  `당신은 짧은 영상 편집자다. 아래 세그먼트(문장 단위) 트랜스크립트를 분석해서 시청자를 끌어당길 ${count}개의 하이라이트를 골라라. 각 하이라이트는 한 개 이상의 세그먼트로 구성되며 비연속(non-contiguous)일 수 있다. 모든 세그먼트의 길이 합은 ${minSec}초 ~ ${maxSec}초 사이여야 한다. 응답은 다음 JSON 스키마를 정확히 따른다: {"highlights":[{"segment_indices":number[],"title":string,"hook":string}]}. segment_indices는 아래 트랜스크립트의 [n] 번호다. 다른 어떤 텍스트도 포함하지 말고 JSON만 반환하라.`;

const RERANK_PROMPT = (count: number, minSec: number, maxSec: number) =>
  `당신은 짧은 영상 편집자다. 아래는 같은 영상의 여러 구간에서 뽑힌 하이라이트 후보들이다. segment_indices는 영상 전체에서의 글로벌 인덱스다. 시청자를 가장 끌어당길 ${count}개를 최종 선택하라. 모든 세그먼트의 길이 합은 ${minSec}초 ~ ${maxSec}초 사이여야 한다. 동일한 JSON 스키마를 따른다.`;

/**
 * Orchestrates LLM-based highlight extraction over Whisper segments.
 *
 * - Single-call path for transcripts under `THRESHOLD` segments.
 * - Chunked path with a final rerank call for longer transcripts; chunk-local
 *   indices are rebased to global before the rerank step.
 * - Service-side validation: dedup, chronological sort, bounds check, total
 *   duration window check.
 * - `cancel()` triggers an AbortController that propagates to the in-flight
 *   LLM HTTP request via the openai SDK signal.
 */
export class HighlightService {
  private static readonly THRESHOLD = 150;
  private static readonly CHUNK_SIZE = 100;
  private static readonly OVERLAP = 10;

  private progressHandlers: ProgressHandler[] = [];
  private abortController: AbortController | null = null;

  constructor(private readonly client: ClientLike) {}

  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.push(handler);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((h) => h !== handler);
    };
  }

  cancel(): void {
    this.abortController?.abort();
  }

  async extract(opts: ExtractOptions): Promise<HighlightSet> {
    if (!opts.apiKey) {
      throw new Error('OpenRouter API key is not set');
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      const plan = planChunks(opts.transcript.segments, {
        threshold: HighlightService.THRESHOLD,
        chunkSize: HighlightService.CHUNK_SIZE,
        overlap: HighlightService.OVERLAP,
      });
      const sysChunk = SYSTEM_PROMPT(opts.count, opts.minSec, opts.maxSec);

      // Per-chunk candidates with GLOBAL indices (rebased from chunk-local).
      const candidatesGlobal: { segment_indices: number[]; title: string; hook: string }[] = [];
      for (const chunk of plan.chunks) {
        this.emitProgress({
          jobId: opts.audioPath,
          chunkIndex: chunk.index,
          chunkTotal: plan.chunks.length,
          phase: 'chunk',
        });
        const userPrompt = formatChunkPrompt(chunk);
        const raw = await this.client.chatJson({
          apiKey: opts.apiKey,
          model: opts.model,
          systemPrompt: sysChunk,
          userPrompt,
          signal,
        });
        const parsed = RawResponseSchema.parse(raw);
        for (const h of parsed.highlights) {
          candidatesGlobal.push({
            segment_indices: h.segment_indices.map((i) => chunk.firstIndex + i),
            title: h.title,
            hook: h.hook,
          });
        }
      }

      let finalCandidates: typeof candidatesGlobal;
      if (plan.needsRerank) {
        this.emitProgress({
          jobId: opts.audioPath,
          chunkIndex: 1,
          chunkTotal: 1,
          phase: 'rerank',
        });
        const sysRerank = RERANK_PROMPT(opts.count, opts.minSec, opts.maxSec);
        const userPrompt = `다음은 글로벌 segment_indices 후보 목록이다 (JSON):\n${JSON.stringify({ candidates: candidatesGlobal }, null, 2)}`;
        const raw = await this.client.chatJson({
          apiKey: opts.apiKey,
          model: opts.model,
          systemPrompt: sysRerank,
          userPrompt,
          temperature: 0.2,
          signal,
        });
        finalCandidates = RawResponseSchema.parse(raw).highlights.map((h) => ({
          segment_indices: h.segment_indices,
          title: h.title,
          hook: h.hook,
        }));
      } else {
        finalCandidates = candidatesGlobal;
      }

      // Translate to Highlight shape: dedupe + sort + bounds check + duration check.
      const finalHighlights: Highlight[] = [];
      for (const c of finalCandidates) {
        const uniqueIndices = Array.from(new Set(c.segment_indices));
        const inBounds = uniqueIndices.every((i) => i >= 0 && i < opts.transcript.segments.length);
        if (!inBounds) continue;
        const segments = uniqueIndices
          .map((i) => ({
            start_sec: opts.transcript.segments[i]!.start,
            end_sec: opts.transcript.segments[i]!.end,
          }))
          .sort((a, b) => a.start_sec - b.start_sec);
        const total = segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0);
        if (total < opts.minSec || total > opts.maxSec) continue;
        const candidate = { segments, title: c.title, hook: c.hook };
        // Final zod parse — catches refines (end > start) + min(1) on segments.
        const parsed = HighlightSchema.safeParse(candidate);
        if (parsed.success) finalHighlights.push(parsed.data);
      }

      return {
        generatedAt: new Date().toISOString(),
        model: opts.model,
        audioPath: opts.audioPath,
        highlights: finalHighlights,
      };
    } finally {
      this.abortController = null;
    }
  }

  private emitProgress(p: ExtractProgress): void {
    for (const h of this.progressHandlers) h(p);
  }
}

function formatChunkPrompt(chunk: ChunkRange): string {
  const lines = chunk.segments.map(
    (s: Segment, localIdx: number) => `[${localIdx}] (${s.start.toFixed(2)}-${s.end.toFixed(2)}) ${s.text}`,
  );
  return `청크 시작 글로벌 인덱스: ${chunk.firstIndex}\n청크 시간 범위: ${chunk.startSec.toFixed(2)}s - ${chunk.endSec.toFixed(2)}s\n\n세그먼트 목록 ([로컬 인덱스] (start-end) text):\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run tests — should pass 7/7**

```bash
yarn test src/main/services/HighlightService.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/HighlightService.ts src/main/services/HighlightService.test.ts
git add src/main/services/HighlightService.ts src/main/services/HighlightService.test.ts
git commit -m "feat(m10): rewrite HighlightService for segment-indices LLM contract"
```

---

### Task 4: `MontageHelpers` pure helpers (TDD)

**Files:**

- Create: `src/main/services/MontageHelpers.ts`
- Create: `src/main/services/MontageHelpers.test.ts`

Two pure functions: `rebaseTrackingFrames` (concatenates per-segment tracking results into one montage-relative frame array) and `rebaseTranscriptWords` (filters + rebases transcript words for the montage timeline).

- [ ] **Step 1: Write the failing tests**

Create `src/main/services/MontageHelpers.test.ts`:

```ts
import type { HighlightSegment } from '@shared/highlight';
import type { TrackFrame, TrackResult } from '@shared/track';
import type { Word } from '@shared/transcript';
import { describe, expect, it } from 'vitest';

import { rebaseTrackingFrames, rebaseTranscriptWords } from './MontageHelpers';

describe('rebaseTrackingFrames', () => {
  it('concatenates per-segment frames into one montage-relative array', () => {
    const segments: HighlightSegment[] = [
      { start_sec: 10, end_sec: 13 }, // duration 3
      { start_sec: 100, end_sec: 102 }, // duration 2
    ];
    const perSeg: TrackResult[] = [
      {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frames: [
          { t: 10, cx: 100, cy: 100 },
          { t: 12, cx: 200, cy: 200 },
        ],
      },
      {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frames: [
          { t: 100, cx: 300, cy: 300 },
          { t: 101, cx: 400, cy: 400 },
        ],
      },
    ];
    const frames = rebaseTrackingFrames(segments, perSeg);
    expect(frames).toEqual([
      { t: 0, cx: 100, cy: 100 }, // segment 0: t=10 → 0
      { t: 2, cx: 200, cy: 200 }, // segment 0: t=12 → 2
      { t: 3, cx: 300, cy: 300 }, // segment 1: t=100 → 3 (cumulative)
      { t: 4, cx: 400, cy: 400 }, // segment 1: t=101 → 4
    ]);
  });

  it('returns empty array if any segment has empty frames (caller falls back to center crop)', () => {
    const segments: HighlightSegment[] = [
      { start_sec: 10, end_sec: 13 },
      { start_sec: 100, end_sec: 102 },
    ];
    const perSeg: TrackResult[] = [
      { sourceWidth: 1920, sourceHeight: 1080, frames: [{ t: 10, cx: 100, cy: 100 }] },
      { sourceWidth: 1920, sourceHeight: 1080, frames: [] },
    ];
    expect(rebaseTrackingFrames(segments, perSeg)).toEqual([]);
  });

  it('handles a single segment as a degenerate case', () => {
    const segments: HighlightSegment[] = [{ start_sec: 5, end_sec: 8 }];
    const perSeg: TrackResult[] = [{ sourceWidth: 1920, sourceHeight: 1080, frames: [{ t: 5, cx: 50, cy: 50 }] }];
    expect(rebaseTrackingFrames(segments, perSeg)).toEqual([{ t: 0, cx: 50, cy: 50 }]);
  });
});

describe('rebaseTranscriptWords', () => {
  function w(text: string, start: number, end: number): Word {
    return { text, start, end };
  }

  it('filters and rebases words for a multi-segment montage', () => {
    const segments: HighlightSegment[] = [
      { start_sec: 10, end_sec: 13 }, // duration 3
      { start_sec: 100, end_sec: 102 }, // duration 2
    ];
    const sourceWords: Word[] = [
      w('skip', 0, 1), // outside both
      w('hello', 10.5, 11.0), // segment 0 → t=0.5..1.0
      w('world', 12.0, 12.5), // segment 0 → t=2.0..2.5
      w('skip', 50, 51), // outside
      w('next', 100.0, 101.5), // segment 1 → t=3.0..4.5
    ];
    const rebased = rebaseTranscriptWords(segments, sourceWords);
    expect(rebased).toEqual([
      { text: 'hello', start: 0.5, end: 1.0 },
      { text: 'world', start: 2.0, end: 2.5 },
      { text: 'next', start: 3.0, end: 4.5 },
    ]);
  });

  it('clamps words that straddle segment boundaries', () => {
    const segments: HighlightSegment[] = [{ start_sec: 10, end_sec: 13 }];
    const sourceWords: Word[] = [
      w('straddleStart', 9.5, 10.5), // visible portion 10.0..10.5 → t=0..0.5
      w('straddleEnd', 12.5, 13.5), // visible portion 12.5..13.0 → t=2.5..3.0
    ];
    const rebased = rebaseTranscriptWords(segments, sourceWords);
    expect(rebased).toEqual([
      { text: 'straddleStart', start: 0, end: 0.5 },
      { text: 'straddleEnd', start: 2.5, end: 3.0 },
    ]);
  });

  it('returns empty array when no words fall in any segment', () => {
    const segments: HighlightSegment[] = [{ start_sec: 100, end_sec: 110 }];
    const sourceWords: Word[] = [w('skip', 0, 1)];
    expect(rebaseTranscriptWords(segments, sourceWords)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
yarn test src/main/services/MontageHelpers.test.ts
```

- [ ] **Step 3: Implement `src/main/services/MontageHelpers.ts` with EXACTLY this content**

```ts
import type { HighlightSegment } from '@shared/highlight';
import type { TrackFrame, TrackResult } from '@shared/track';
import type { Word } from '@shared/transcript';

/**
 * Concatenate per-segment tracking results into a single frame array with
 * montage-relative timestamps. Returns empty array if ANY segment has zero
 * frames — caller (RenderService) falls back to center crop in that case.
 */
export function rebaseTrackingFrames(segments: HighlightSegment[], perSegmentResults: TrackResult[]): TrackFrame[] {
  if (perSegmentResults.some((r) => r.frames.length === 0)) return [];
  const out: TrackFrame[] = [];
  let cumulativeMontageTime = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const result = perSegmentResults[i]!;
    for (const f of result.frames) {
      out.push({
        t: cumulativeMontageTime + (f.t - seg.start_sec),
        cx: f.cx,
        cy: f.cy,
      });
    }
    cumulativeMontageTime += seg.end_sec - seg.start_sec;
  }
  return out;
}

/**
 * Filter source-time transcript words to those overlapping any highlight
 * segment, then rebase their timestamps to montage-relative time. Words
 * straddling a segment boundary are clamped to the visible portion.
 */
export function rebaseTranscriptWords(segments: HighlightSegment[], sourceWords: Word[]): Word[] {
  const out: Word[] = [];
  let cumulativeMontageTime = 0;
  for (const seg of segments) {
    const segWords = sourceWords.filter((w) => w.start < seg.end_sec && w.end > seg.start_sec);
    for (const w of segWords) {
      const clampedStart = Math.max(w.start, seg.start_sec);
      const clampedEnd = Math.min(w.end, seg.end_sec);
      out.push({
        text: w.text,
        start: cumulativeMontageTime + (clampedStart - seg.start_sec),
        end: cumulativeMontageTime + (clampedEnd - seg.start_sec),
      });
    }
    cumulativeMontageTime += seg.end_sec - seg.start_sec;
  }
  return out;
}
```

- [ ] **Step 4: Run — should pass 6/6**

```bash
yarn test src/main/services/MontageHelpers.test.ts
```

- [ ] **Step 5: Format + commit**

```bash
yarn prettier --write src/main/services/MontageHelpers.ts src/main/services/MontageHelpers.test.ts
git add src/main/services/MontageHelpers.ts src/main/services/MontageHelpers.test.ts
git commit -m "feat(m10): add MontageHelpers (rebaseTrackingFrames + rebaseTranscriptWords)"
```

---

### Task 5: `RenderService` rewrite for segment-based montages (TDD)

**Files:**

- Modify: `src/main/services/RenderService.ts`
- Modify: `src/main/services/RenderService.test.ts`

The biggest single change: args builders use `select` filter, tracking calls happen per segment with rebasing, subtitle generation uses rebased words, and `RenderClipResult.startSec/endSec` are derived from first/last segments.

- [ ] **Step 1: Update fixtures + rewrite tests**

Replace the existing `fakeHighlight` helper at the top of `src/main/services/RenderService.test.ts` (around line 6) with:

```ts
function fakeHighlight(i: number, start: number, end: number) {
  return {
    segments: [{ start_sec: start, end_sec: end }],
    title: `H${i}`,
    hook: `hook${i}`,
  };
}

function fakeMultiSegHighlight(i: number, ranges: { start: number; end: number }[]) {
  return {
    segments: ranges.map((r) => ({ start_sec: r.start, end_sec: r.end })),
    title: `H${i}`,
    hook: `hook${i}`,
  };
}
```

Then update existing test assertions that read `args[args.indexOf('-vf') + 1]`:

The center-crop filter chain becomes:

- Old: `crop=ih*9/16:ih,scale=1080:1920`
- New: `select='between(t,X,Y)+...',setpts=N/FRAME_RATE/TB,crop=ih*9/16:ih,scale=1080:1920`

Update each existing assertion that compared `-vf` value. Find and replace all instances of:

```ts
expect(args[args.indexOf('-vf') + 1]).toBe('crop=ih*9/16:ih,scale=1080:1920');
```

with:

```ts
expect(args[args.indexOf('-vf') + 1]).toBe(
  "select='between(t,0,30)',setpts=N/FRAME_RATE/TB,crop=ih*9/16:ih,scale=1080:1920",
);
```

(The exact `between(t,X,Y)` ranges depend on each test's fakeHighlight inputs. Use the test's start/end values.)

For the test `'builds ffmpeg args with -ss, -to, the 9:16 crop+scale filter, libx264, and aac'` (around line 71): the new args no longer use `-ss / -to` (the `select` filter does the cutting). Replace its body with:

```ts
it('builds ffmpeg args with select-filter cuts, the 9:16 crop+scale filter, libx264, and aac', async () => {
  const h = fakeRunHandle();
  run.mockReturnValue(h);
  const promise = service.render({
    sourcePath: '/tmp/in.mp4',
    outputDir: '/tmp/out',
    highlights: [fakeHighlight(1, 5, 35)],
  });
  h._resolve();
  await promise;

  const opts = run.mock.calls[0]![0];
  expect(opts.durationSec).toBe(30);
  const args: string[] = opts.args;
  // No -ss / -to anymore — select filter does the cuts
  expect(args).not.toContain('-ss');
  expect(args).not.toContain('-to');
  expect(args).toContain('-i');
  expect(args[args.indexOf('-i') + 1]).toBe('/tmp/in.mp4');
  expect(args).toContain('-vf');
  expect(args[args.indexOf('-vf') + 1]).toBe(
    "select='between(t,5,35)',setpts=N/FRAME_RATE/TB,crop=ih*9/16:ih,scale=1080:1920",
  );
  expect(args).toContain('-af');
  expect(args[args.indexOf('-af') + 1]).toBe("aselect='between(t,5,35)',asetpts=N/SR/TB");
  expect(args).toContain('libx264');
  expect(args).toContain('aac');
  expect(args[args.length - 1]).toBe('/tmp/out/short_1.mp4');
});
```

For all OTHER existing tests in `describe('RenderService')` and `describe('RenderService with tracker')` and `describe('RenderService with subtitles')`: update each `-vf` assertion to use the new `select=...` form for whichever start/end values that test uses. (The total count of existing tests is 15; most just need the one assertion swapped.)

- [ ] **Step 2: Append the new multi-segment test cases at the very end of the file (just before the final `});`)**

In the `describe('RenderService with subtitles')` block, after the existing last test, append:

```ts
it('multi-segment highlight builds select filter with multiple between() ranges', async () => {
  const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
  const fs = { writeFile };
  const service = new RenderService(runner as never, { fs: fs as never });
  const h = fakeRunHandle();
  run.mockReturnValue(h);

  const promise = service.render({
    sourcePath: '/tmp/in.mp4',
    outputDir: '/tmp/out',
    highlights: [
      fakeMultiSegHighlight(1, [
        { start: 5, end: 8 },
        { start: 12, end: 15 },
        { start: 30, end: 33 },
      ]),
    ],
  });
  h._resolve();
  const result = await promise;

  const args: string[] = run.mock.calls[0]![0].args;
  expect(args[args.indexOf('-vf') + 1]).toBe(
    "select='between(t,5,8)+between(t,12,15)+between(t,30,33)',setpts=N/FRAME_RATE/TB,crop=ih*9/16:ih,scale=1080:1920",
  );
  expect(args[args.indexOf('-af') + 1]).toBe(
    "aselect='between(t,5,8)+between(t,12,15)+between(t,30,33)',asetpts=N/SR/TB",
  );
  // durationSec = sum of segment durations (3+3+3 = 9)
  expect(run.mock.calls[0]![0].durationSec).toBe(9);
  // RenderClipResult.startSec/endSec derived from first/last segments
  expect(result.results[0]!.startSec).toBe(5);
  expect(result.results[0]!.endSec).toBe(33);
});

it('multi-segment with tracker rebases per-segment frames into one sendcmd file', async () => {
  const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
  const fs = { writeFile };
  // Tracker returns one frame per segment, in source-time
  const trackerCalls: { startSec: number; endSec: number }[] = [];
  const tracker = {
    track: vi.fn(async (_path: string, opts: { startSec: number; endSec: number }) => {
      trackerCalls.push({ startSec: opts.startSec, endSec: opts.endSec });
      return {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frames: [{ t: opts.startSec + 1, cx: 500, cy: 500 }],
      };
    }),
  };
  const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
  const h = fakeRunHandle();
  run.mockReturnValue(h);

  const promise = service.render({
    sourcePath: '/tmp/in.mp4',
    outputDir: '/tmp/out',
    highlights: [
      fakeMultiSegHighlight(1, [
        { start: 10, end: 13 },
        { start: 100, end: 102 },
      ]),
    ],
  });
  h._resolve();
  await promise;

  // Tracker called once per segment
  expect(trackerCalls).toEqual([
    { startSec: 10, endSec: 13 },
    { startSec: 100, endSec: 102 },
  ]);
  // .cmd file contains rebased times: seg 0 → t=1 (10→11 rebased to 1), seg 1 → t=4 (100→101 rebased to 3+1=4)
  const cmdWrite = writeFile.mock.calls.find((c) => String(c[0]).endsWith('.cmd'))!;
  const cmdContent = cmdWrite[1] as string;
  expect(cmdContent).toContain('1 crop@c x');
  expect(cmdContent).toContain('4 crop@c x');
});

it('multi-segment fallback to center crop when one segment has zero tracked frames', async () => {
  const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
  const fs = { writeFile };
  let call = 0;
  const tracker = {
    track: vi.fn(async () => {
      call += 1;
      return {
        sourceWidth: 1920,
        sourceHeight: 1080,
        frames: call === 1 ? [{ t: 11, cx: 500, cy: 500 }] : [],
      };
    }),
  };
  const service = new RenderService(runner as never, { tracker: tracker as never, fs: fs as never });
  const h = fakeRunHandle();
  run.mockReturnValue(h);

  const promise = service.render({
    sourcePath: '/tmp/in.mp4',
    outputDir: '/tmp/out',
    highlights: [
      fakeMultiSegHighlight(1, [
        { start: 10, end: 13 },
        { start: 100, end: 102 },
      ]),
    ],
  });
  h._resolve();
  const result = await promise;

  // Center-crop fallback (no sendcmd in args)
  const args: string[] = run.mock.calls[0]![0].args;
  expect(args[args.indexOf('-vf') + 1]).toContain('crop=ih*9/16:ih');
  expect(args[args.indexOf('-vf') + 1]).not.toContain('sendcmd');
  expect(result.results[0]!.tracking).toBeNull();
});

it('multi-segment with subtitles rebases words across the montage timeline', async () => {
  const writeFile = vi.fn(async (_p: string, _c: string, _e?: string) => undefined);
  const fs = { writeFile };
  const service = new RenderService(runner as never, { fs: fs as never });
  const h = fakeRunHandle();
  run.mockReturnValue(h);

  const promise = service.render({
    sourcePath: '/tmp/in.mp4',
    outputDir: '/tmp/out',
    highlights: [
      fakeMultiSegHighlight(1, [
        { start: 10, end: 13 },
        { start: 100, end: 102 },
      ]),
    ],
    transcriptWords: [
      { text: 'hello', start: 11, end: 11.5 }, // seg 0 → t=1.0..1.5
      { text: 'world', start: 100.5, end: 101 }, // seg 1 → t=3.5..4
    ],
    subtitleOptions: SUBTITLE_OPTS,
  });
  h._resolve();
  await promise;

  const assWrite = writeFile.mock.calls.find((c) => String(c[0]).endsWith('.ass'))!;
  const assContent = assWrite[1] as string;
  // Cue dialogues with montage-relative times
  expect(assContent).toContain('0:00:01.00,0:00:01.50'); // 'hello' at t=1.0..1.5
  expect(assContent).toContain('0:00:03.50,0:00:04.00'); // 'world' at t=3.5..4.0
});

it('multi-segment durationSec passed to runner is the sum of segment durations', async () => {
  const service = new RenderService(runner as never);
  const h = fakeRunHandle();
  run.mockReturnValue(h);

  const promise = service.render({
    sourcePath: '/tmp/in.mp4',
    outputDir: '/tmp/out',
    highlights: [
      fakeMultiSegHighlight(1, [
        { start: 0, end: 5 },
        { start: 10, end: 15 },
        { start: 20, end: 25 },
      ]),
    ],
  });
  h._resolve();
  await promise;

  // 3 segments × 5s = 15s
  expect(run.mock.calls[0]![0].durationSec).toBe(15);
});
```

- [ ] **Step 3: Run tests — should fail (15 existing rewrites + 5 new)**

```bash
yarn test src/main/services/RenderService.test.ts
```

- [ ] **Step 4: Replace `src/main/services/RenderService.ts` ENTIRELY with**

```ts
import type { Highlight, HighlightSegment } from '@shared/highlight';
import type { RenderClipResult, RenderProgress, RenderResult } from '@shared/render';
import type { TrackResult } from '@shared/track';
import type { Word } from '@shared/transcript';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

import { rebaseTrackingFrames, rebaseTranscriptWords } from './MontageHelpers';
import { buildSendcmd } from './SendcmdGenerator';
import { type SubtitleStyle, buildAssFile } from './SubtitleGenerator';

interface RunnerLike {
  run(opts: { args: readonly string[]; durationSec: number }): {
    onProgress(cb: (f: number) => void): void;
    cancel(): void;
    done: Promise<void>;
  };
}

interface TrackerLike {
  track(videoPath: string, opts: { startSec: number; endSec: number; fpsSample?: number }): Promise<TrackResult>;
}

type FsLike = Pick<typeof fsPromises, 'writeFile'>;

export interface RenderServiceOptions {
  /** When provided, each clip is tracked before rendering. */
  tracker?: TrackerLike;
  /** Injected for tests. Defaults to the real fs.promises. */
  fs?: FsLike;
}

export interface RenderOptions {
  sourcePath: string;
  outputDir: string;
  highlights: Highlight[];
  /** Whisper word-level timings, used to generate subtitle .ass files. */
  transcriptWords?: Word[];
  /** When provided AND words fall in the clip window, subtitles are burned in. */
  subtitleOptions?: SubtitleStyle;
}

type ProgressHandler = (p: RenderProgress) => void;

export class RenderService {
  private progressHandlers: ProgressHandler[] = [];
  private activeHandle: ReturnType<RunnerLike['run']> | null = null;
  private canceled = false;
  private subtitlesUnavailable = false;
  private readonly tracker?: TrackerLike;
  private readonly fs: FsLike;

  constructor(
    private readonly runner: RunnerLike,
    options: RenderServiceOptions = {},
  ) {
    this.tracker = options.tracker;
    this.fs = options.fs ?? fsPromises;
  }

  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.push(handler);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((h) => h !== handler);
    };
  }

  cancel(): void {
    this.canceled = true;
    this.activeHandle?.cancel();
  }

  async render(opts: RenderOptions): Promise<RenderResult> {
    this.canceled = false;
    this.subtitlesUnavailable = false;
    const results: RenderClipResult[] = [];
    const total = opts.highlights.length;

    for (let i = 0; i < opts.highlights.length; i++) {
      const h = opts.highlights[i]!;
      const clipIndex = i + 1;
      if (this.canceled) {
        results.push(this.buildClipResult(clipIndex, h, 'canceled', undefined, 'Render canceled'));
        continue;
      }
      const outputPath = join(opts.outputDir, `short_${clipIndex}.mp4`);
      const durationSec = h.segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0);

      const trackingInfo = this.tracker ? await this.maybeTrackAndPersist(opts, h, clipIndex) : null;
      const baseArgs =
        trackingInfo !== null
          ? buildTrackedArgs(opts.sourcePath, h.segments, outputPath, trackingInfo.cmdPath)
          : buildCenterArgs(opts.sourcePath, h.segments, outputPath);
      const subtitlesInfo =
        opts.subtitleOptions && opts.transcriptWords && !this.subtitlesUnavailable
          ? await this.maybeWriteSubtitles(opts, h, clipIndex, durationSec)
          : null;
      const args = subtitlesInfo ? appendSubtitleFilter(baseArgs, subtitlesInfo.assPath) : baseArgs;

      const handle = this.runner.run({ args, durationSec });
      this.activeHandle = handle;
      handle.onProgress((fraction) => {
        for (const cb of this.progressHandlers) {
          cb({ clipIndex, clipTotal: total, fraction });
        }
      });
      try {
        await handle.done;
        results.push(
          this.buildClipResult(
            clipIndex,
            h,
            'done',
            outputPath,
            undefined,
            trackingInfo ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath } : null,
            subtitlesInfo ? { cues: subtitlesInfo.cueCount, assPath: subtitlesInfo.assPath } : null,
          ),
        );
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        if (this.canceled || /canceled/i.test(message)) {
          results.push(this.buildClipResult(clipIndex, h, 'canceled', undefined, 'Render canceled'));
        } else if (subtitlesInfo && /No such filter: ['"]subtitles['"]/.test(message)) {
          this.subtitlesUnavailable = true;
          this.activeHandle = null;
          const retryHandle = this.runner.run({ args: baseArgs, durationSec });
          this.activeHandle = retryHandle;
          retryHandle.onProgress((fraction) => {
            for (const cb of this.progressHandlers) {
              cb({ clipIndex, clipTotal: total, fraction });
            }
          });
          try {
            await retryHandle.done;
            results.push(
              this.buildClipResult(
                clipIndex,
                h,
                'done',
                outputPath,
                undefined,
                trackingInfo ? { frames: trackingInfo.frameCount, trackPath: trackingInfo.trackPath } : null,
                null,
              ),
            );
          } catch (retryErr: unknown) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            results.push(this.buildClipResult(clipIndex, h, 'failed', undefined, retryMsg));
          }
        } else {
          results.push(this.buildClipResult(clipIndex, h, 'failed', undefined, message));
        }
      } finally {
        this.activeHandle = null;
      }
    }

    return { outputDir: opts.outputDir, results };
  }

  private async maybeTrackAndPersist(
    opts: RenderOptions,
    h: Highlight,
    clipIndex: number,
  ): Promise<{ cmdPath: string; trackPath: string; frameCount: number } | null> {
    if (!this.tracker) return null;
    const perSegmentResults: TrackResult[] = [];
    let firstResult: TrackResult | null = null;
    for (const seg of h.segments) {
      try {
        const r = await this.tracker.track(opts.sourcePath, {
          startSec: seg.start_sec,
          endSec: seg.end_sec,
        });
        if (firstResult === null) firstResult = r;
        perSegmentResults.push(r);
      } catch {
        // Tracking failure on any segment is non-fatal — fall back to center crop.
        return null;
      }
    }
    const allFrames = rebaseTrackingFrames(h.segments, perSegmentResults);
    if (allFrames.length === 0 || firstResult === null) return null;

    const aggregated: TrackResult = {
      sourceWidth: firstResult.sourceWidth,
      sourceHeight: firstResult.sourceHeight,
      frames: allFrames,
    };
    let cmdContent: string;
    try {
      cmdContent = buildSendcmd(aggregated, 0);
    } catch {
      // Source too vertical for sendcmd — fall back to center crop.
      return null;
    }
    const cmdPath = join(opts.outputDir, `short_${clipIndex}.cmd`);
    const trackPath = join(opts.outputDir, `short_${clipIndex}.track.json`);
    await this.fs.writeFile(cmdPath, cmdContent, 'utf8');
    await this.fs.writeFile(trackPath, JSON.stringify(aggregated, null, 2), 'utf8');
    return { cmdPath, trackPath, frameCount: allFrames.length };
  }

  private async maybeWriteSubtitles(
    opts: RenderOptions,
    h: Highlight,
    clipIndex: number,
    montageDuration: number,
  ): Promise<{ assPath: string; cueCount: number } | null> {
    if (!opts.subtitleOptions || !opts.transcriptWords) return null;
    const rebased = rebaseTranscriptWords(h.segments, opts.transcriptWords);
    if (rebased.length === 0) return null;
    const assContent = buildAssFile(rebased, 0, montageDuration, opts.subtitleOptions);
    if (assContent === '') return null;
    const assPath = join(opts.outputDir, `short_${clipIndex}.ass`);
    await this.fs.writeFile(assPath, assContent, 'utf8');
    const cueCount = (assContent.match(/^Dialogue:/gm) ?? []).length;
    return { assPath, cueCount };
  }

  private buildClipResult(
    index: number,
    h: Highlight,
    status: RenderClipResult['status'],
    outputPath?: string,
    error?: string,
    tracking?: RenderClipResult['tracking'],
    subtitles?: RenderClipResult['subtitles'],
  ): RenderClipResult {
    return {
      index,
      title: h.title,
      // History persistence (M9): coarse range = first segment start..last segment end.
      startSec: h.segments[0]!.start_sec,
      endSec: h.segments[h.segments.length - 1]!.end_sec,
      status,
      outputPath,
      error,
      tracking,
      subtitles,
    };
  }
}

const COMMON_ENCODE_ARGS = [
  '-c:v',
  'libx264',
  '-preset',
  'fast',
  '-crf',
  '23',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-progress',
  'pipe:2',
];

function buildSelectExpr(segments: HighlightSegment[]): string {
  return segments.map((s) => `between(t,${s.start_sec},${s.end_sec})`).join('+');
}

function buildVfChain(segments: HighlightSegment[], cropClause: string): string {
  return `select='${buildSelectExpr(segments)}',setpts=N/FRAME_RATE/TB,${cropClause},scale=1080:1920`;
}

function buildAfChain(segments: HighlightSegment[]): string {
  return `aselect='${buildSelectExpr(segments)}',asetpts=N/SR/TB`;
}

function buildCenterArgs(sourcePath: string, segments: HighlightSegment[], outputPath: string): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    buildVfChain(segments, 'crop=ih*9/16:ih'),
    '-af',
    buildAfChain(segments),
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}

function buildTrackedArgs(
  sourcePath: string,
  segments: HighlightSegment[],
  outputPath: string,
  cmdPath: string,
): string[] {
  const cropClause = `sendcmd=f=${cmdPath},crop@c=ih*9/16:ih:0:0`;
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    buildVfChain(segments, cropClause),
    '-af',
    buildAfChain(segments),
    ...COMMON_ENCODE_ARGS,
    outputPath,
  ];
}

function appendSubtitleFilter(args: readonly string[], assPath: string): string[] {
  const out = [...args];
  const vfIndex = out.indexOf('-vf');
  if (vfIndex === -1) return out;
  // Single-quote the path so ffmpeg's filter parser tolerates spaces.
  out[vfIndex + 1] = `${out[vfIndex + 1]},subtitles=filename='${assPath}'`;
  return out;
}
```

- [ ] **Step 5: Run — should pass (existing 15 rewritten + 5 new = 20 cases)**

```bash
yarn test src/main/services/RenderService.test.ts
```

If a multi-segment test fails on the assertion of the exact `select='between(...)+between(...)'` string, double-check the implementation's `buildSelectExpr` output matches (commas only, no spaces, single quotes wrap the expression in the final filter chain assignment).

- [ ] **Step 6: Format + commit**

```bash
yarn prettier --write src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git add src/main/services/RenderService.ts src/main/services/RenderService.test.ts
git commit -m "feat(m10): rewrite RenderService for segment-based montage rendering"
```

---

### Task 6: Wire main.ts (and adjacent test stubs)

**Files:**

- Modify: `src/main/services/HistoryService.ts` (small fixture-shape adjustment)
- Modify: `src/main/services/HistoryService.test.ts` (test fixture shape)
- Modify: `tests/renderer/NewJob.test.tsx` (mock highlight shape)

`main.ts` itself doesn't need changes — `highlightSet.highlights` is a list either way, and `RenderService.render` accepts the new `Highlight` shape via TypeScript inference. But two adjacent files reference the old highlight shape and need updating.

- [ ] **Step 1: Update `HistoryService.ts`**

Find the line in `recordJob` that reads `input.highlightSet.highlights[r.index - 1]?.hook`. The shape lookup is unchanged — `.hook` still exists on the new Highlight. No code change needed.

But the file may have a stale type assumption — verify by running typecheck:

```bash
yarn typecheck 2>&1 | grep HistoryService
```

If typecheck passes for HistoryService, no change. If it complains about a missing `start_sec/end_sec`, those references are gone in the new schema — find and update them.

- [ ] **Step 2: Update `HistoryService.test.ts` fixtures**

The `fakeHighlight` and `fakeHighlightSet` helpers need to produce the new shape. Replace the existing `fakeHighlight` helper with:

```ts
function fakeHighlight(start: number, end: number, title: string, hook = 'h'): Highlight {
  return {
    segments: [{ start_sec: start, end_sec: end }],
    title,
    hook,
  };
}
```

(All callers use single-segment highlights, so this single-segment fixture suffices.)

- [ ] **Step 3: Update `tests/renderer/NewJob.test.tsx` mock**

Find the `extractHighlights` mock in `installApiMock`. Replace its return value's `highlights` array shape:

```ts
extractHighlights: vi.fn(async () => ({
  highlightsPath: '/tmp/dQw4w9WgXcQ.mp4.highlights.json',
  highlightSet: {
    generatedAt: '2026-05-09T00:00:00Z',
    model: 'm',
    audioPath: '/tmp/dQw4w9WgXcQ.mp4',
    highlights: [
      {
        segments: [{ start_sec: 0, end_sec: 30 }],
        title: 'Opener',
        hook: 'Strong start',
      },
    ],
  },
})),
```

- [ ] **Step 4: Verify everything**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn lint && yarn typecheck && yarn test 2>&1 | tail -10
```

Expected: lint 0 errors (1 known `__dirname` warning OK), typecheck 0 errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/HistoryService.ts src/main/services/HistoryService.test.ts tests/renderer/NewJob.test.tsx
git commit -m "feat(m10): update test fixtures + HistoryService for new Highlight shape"
```

---

### Task 7: `HighlightCard` UI tweak

**Files:**

- Modify: `src/renderer/components/newjob/HighlightCard.tsx`

Show segment count + total duration when `segments.length > 1`. Single-range highlights keep the existing `start – end` form.

- [ ] **Step 1: Read HighlightCard.tsx and find the `done` state's per-highlight `<li>`**

It currently renders something like `#${i+1} ${h.title} (formatTime(h.start_sec) – formatTime(h.end_sec))`. The `start_sec`/`end_sec` references no longer exist on `Highlight` — they're on each `HighlightSegment`.

- [ ] **Step 2: Update the per-highlight `<li>` in the `done` state**

Replace the existing per-highlight rendering with:

```tsx
{
  props.highlightSet.highlights.map((h: Highlight, i: number) => {
    const totalSec = h.segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0);
    const isMulti = h.segments.length > 1;
    const rangeLabel = isMulti
      ? `${h.segments.length}개 세그먼트 · ${formatTime(totalSec)} 총길이`
      : `${formatTime(h.segments[0]!.start_sec)} – ${formatTime(h.segments[0]!.end_sec)}`;
    return (
      <li key={i} className="bg-surface p-md rounded-lg">
        <p className="text-body-md text-ink font-semibold">
          #{i + 1} {h.title} <span className="text-body-sm text-slate font-normal">({rangeLabel})</span>
        </p>
        <p className="text-body-sm text-slate mt-xs">{h.hook}</p>
      </li>
    );
  });
}
```

(The existing `formatTime` helper at the top of the file works for both single-range and total-duration display.)

- [ ] **Step 3: Update the summary line above the list**

The existing summary uses `props.transcript.segments.length` and `props.transcript.words.length` — those are still on the Transcript shape, no change. But the second line that summarized highlights might use stale fields. Find and verify; if it uses `h.start_sec / h.end_sec`, replace with the same `totalSec` computation.

- [ ] **Step 4: Format + verify**

```bash
yarn prettier --write src/renderer/components/newjob/HighlightCard.tsx
yarn lint && yarn typecheck && yarn test 2>&1 | tail -5
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/newjob/HighlightCard.tsx
git commit -m "feat(m10): show segment count + total duration for multi-segment highlights in HighlightCard"
```

---

### Task 8: README update + DoD verification + finalize branch

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Run all DoD checks**

```bash
cd /Users/hwpark/Documents/webstorm-workspace/simple-shorts-ai-app
yarn typecheck && yarn lint && yarn test && yarn build
cd sidecar && uv run pytest && cd ..
```

Expected: all green. Vitest count: M9 baseline 166 + 5 new RenderService cases + 6 MontageHelpers + new HighlightService cases (~7) - removed legacy ChunkPlanner/HighlightService cases that no longer apply. Net should land around ~175. Sidecar pytest stays at 24.

- [ ] **Step 2: Manual integration check (real OpenRouter + ffmpeg + real video)**

```bash
yarn dev
```

In the app:

1. Run a fresh pipeline: preview → 다운로드 → STT 시작 → 하이라이트 추출.
2. Inspect the new highlights — multi-segment highlights should show "N개 세그먼트 · MM:SS 총길이" in the card; single-segment fall back to the existing `0:00 – 0:30` form.
3. Click 숏츠 만들기. Verify each clip renders in one ffmpeg pass.
4. Open one of the multi-segment shorts in QuickTime — confirm the segments are concatenated cleanly (audio + video cut at the same timestamps).
5. With subtitles enabled and tracking on, verify the same: subtitles appear in montage time; tracker follows the speaker through the segments.

If anything's off, fix and re-test BEFORE continuing.

- [ ] **Step 3: Update README status**

Edit `README.md` `## Status`:

```markdown
## Status

- ✅ M1 — M8 (see above)
- ✅ M9: History persistence
- ✅ M10: Segment-based highlights — non-contiguous Whisper-segment montages, single-pass ffmpeg `select` filter, M7 tracking + M8 subtitles rebased to montage time. Replaces M5's word-level extraction.
- ⏳ M11: Packaging & distribution (next — was M10 in original spec)
```

- [ ] **Step 4: Commit + push branch**

```bash
yarn prettier --write README.md
git add README.md
git commit -m "docs(m10): mark milestone 10 complete + bump packaging to M11"
git push -u origin m10-segment-based-highlights
```

- [ ] **Step 5: Merge to master + tag**

(Done by the controller via `superpowers:finishing-a-development-branch` — see DoD below.)

---

## Definition of Done (M10)

1. `yarn typecheck`, `yarn lint` (only known `__dirname` warning), `yarn test`, `yarn build` all exit 0.
2. `cd sidecar && uv run pytest` reports 24 passing (unchanged — pure TypeScript milestone).
3. `yarn test` includes the rewritten test files (HighlightService ~7, ChunkPlanner ~5, RenderService ~20, MontageHelpers 6) + updated NewJob smoke. Net ~175 tests, no regressions.
4. Manual integration: real `yarn dev` run produces multi-segment montage shorts. Cards show "N개 세그먼트 · MM:SS" for multi; subtitle + tracking still work in montage mode.
5. Branch `m10-segment-based-highlights` pushed to origin.
6. After review, branch merged to master with `--no-ff` and tagged `m10-complete` on master.

## What's NOT in M10 (intentionally deferred)

- **Crossfade between segments**: hard cuts only.
- **Backward-compat reader for old highlights.json**: hard schema break — users re-run extraction.
- **Auto-suggest segment edits** (LLM picks A, user wants B): out of scope.
- **`history.shorts` schema bump for full segments[] storage**: M9's table only stores coarse `start_sec`/`end_sec` — derived from first/last segment in M10. Future M11+ if needed.
- **Per-segment progress reporting in RenderCard**: progress is still per-clip, not per-segment-within-clip.
- **Original M10 (packaging)**: bumped to M11. The spec section 8.2 milestone table will need a follow-up edit but is out of scope for this plan.

## Notes for the implementing agent

- The bob-park ESLint config bans `../*` parent imports — use `@renderer/*`, `@shared/*` aliases.
- The schema break in Task 1 INTENTIONALLY breaks downstream typechecks. Tasks 2–6 fix each consumer in turn. Don't try to keep the old shape around in parallel.
- `select` filter expression escaping: ffmpeg's filter parser treats commas as filter separators. Wrapping `between(...)+...` in single quotes (`select='...'`) prevents the comma in `between(t,X,Y)` from being misinterpreted. The same trick is used by M8 for the .ass path.
- The single-segment degenerate case is the same code path as multi-segment — there is no special branch. Verify by running existing single-segment tests after the rewrite (Task 5 step 5).
- `MontageHelpers.rebaseTrackingFrames` returns empty array if ANY segment has zero frames — this is the M7 fallback rule applied at montage scope. The aggregated `TrackResult` would otherwise have gaps that `buildSendcmd` doesn't model.
- ffmpeg's `setpts=N/FRAME_RATE/TB` rebases video frame timestamps to start at 0 after `select`. The audio counterpart is `asetpts=N/SR/TB`. These are mandatory after `(a)select` when the output should play from t=0.
