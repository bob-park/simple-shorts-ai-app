import { type ExtractProgress } from '@shared/extract';
import { type Highlight, HighlightSchema, type HighlightSet } from '@shared/highlight';
import { type Segment, type Transcript } from '@shared/transcript';
import { z } from 'zod';

import { type ChunkRange, planChunks } from './ChunkPlanner';

interface ClientLike {
  chat(opts: {
    system: string;
    user: string;
    schemaId: 'highlights' | 'highlights_rerank';
  }): Promise<{ highlights: unknown[] }>;
}

export interface ExtractOptions {
  transcript: Transcript;
  audioPath: string;
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

const HARDCODED_MODEL = 'gemma-4-e4b';

const SYSTEM_PROMPT = (count: number, minSec: number, maxSec: number) =>
  `당신은 짧은 영상 편집자다. 아래 세그먼트(문장 단위) 트랜스크립트를 분석해서 시청자를 끌어당길 ${count}개의 하이라이트를 골라라. 각 하이라이트는 한 개 이상의 세그먼트로 구성되며 비연속(non-contiguous)일 수 있다. 모든 세그먼트의 길이 합은 ${minSec}초 ~ ${maxSec}초 사이여야 한다. 응답은 다음 JSON 스키마를 정확히 따른다: {"highlights":[{"segment_indices":number[],"title":string,"hook":string}]}. segment_indices는 아래 트랜스크립트의 [n] 번호다. 다른 어떤 텍스트도 포함하지 말고 JSON만 반환하라.`;

const RERANK_PROMPT = (count: number, minSec: number, maxSec: number) =>
  `당신은 짧은 영상 편집자다. 아래는 같은 영상의 여러 구간에서 뽑힌 하이라이트 후보들이다. segment_indices는 영상 전체에서의 글로벌 인덱스다. 시청자를 가장 끌어당길 ${count}개를 최종 선택하라. 모든 세그먼트의 길이 합은 ${minSec}초 ~ ${maxSec}초 사이여야 한다. 응답은 다음 JSON 스키마를 정확히 따른다: {"highlights":[{"segment_indices":number[],"title":string,"hook":string}]}. 다른 어떤 텍스트도 포함하지 말고 JSON만 반환하라.`;

/**
 * Orchestrates LLM-based highlight extraction over Whisper segments using a
 * local LLM (no API key, no remote call). The chunk/rerank/dedup/sort/bounds
 * pipeline is identical to M10's OpenRouter version; only the transport layer
 * (the `ClientLike.chat` method) changed.
 */
export class HighlightService {
  private static readonly THRESHOLD = 150;
  private static readonly CHUNK_SIZE = 100;
  private static readonly OVERLAP = 10;

  private progressHandlers: ProgressHandler[] = [];

  constructor(private readonly client: ClientLike) {}

  onProgress(handler: ProgressHandler): () => void {
    this.progressHandlers.push(handler);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((h) => h !== handler);
    };
  }

  async extract(opts: ExtractOptions): Promise<HighlightSet> {
    const plan = planChunks(opts.transcript.segments, {
      threshold: HighlightService.THRESHOLD,
      chunkSize: HighlightService.CHUNK_SIZE,
      overlap: HighlightService.OVERLAP,
    });
    const sysChunk = SYSTEM_PROMPT(opts.count, opts.minSec, opts.maxSec);

    const candidatesGlobal: { segment_indices: number[]; title: string; hook: string }[] = [];
    for (const chunk of plan.chunks) {
      this.emitProgress({
        jobId: opts.audioPath,
        chunkIndex: chunk.index,
        chunkTotal: plan.chunks.length,
        phase: 'chunk',
      });
      const userPrompt = formatChunkPrompt(chunk);
      const raw = await this.client.chat({
        system: sysChunk,
        user: userPrompt,
        schemaId: 'highlights',
      });
      const parsed = RawResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `LLM returned invalid response shape on chunk ${chunk.index}/${plan.chunks.length} ` +
            `(expected {"highlights":[…]}). Raw response: ${JSON.stringify(raw).slice(0, 400)}`,
        );
      }
      for (const h of parsed.data.highlights) {
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
      const userPrompt = `다음은 글로벌 segment_indices 후보 목록이다 (JSON):\n${JSON.stringify({ highlights: candidatesGlobal }, null, 2)}`;
      const raw = await this.client.chat({
        system: sysRerank,
        user: userPrompt,
        schemaId: 'highlights_rerank',
      });
      const parsed = RawResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `LLM returned invalid response shape on rerank step ` +
            `(expected {"highlights":[…]}). Raw response: ${JSON.stringify(raw).slice(0, 400)}`,
        );
      }
      finalCandidates = parsed.data.highlights.map((h) => ({
        segment_indices: h.segment_indices,
        title: h.title,
        hook: h.hook,
      }));
    } else {
      finalCandidates = candidatesGlobal;
    }

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
      const validated = HighlightSchema.safeParse(candidate);
      if (validated.success) finalHighlights.push(validated.data);
    }

    return {
      generatedAt: new Date().toISOString(),
      model: HARDCODED_MODEL,
      audioPath: opts.audioPath,
      highlights: finalHighlights,
    };
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
