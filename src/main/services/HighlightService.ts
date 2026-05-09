import { type ExtractProgress } from '@shared/extract';
import { type Highlight, HighlightSchema, type HighlightSet } from '@shared/highlight';
import { type Transcript } from '@shared/transcript';
import { z } from 'zod';

import { planChunks } from './ChunkPlanner';

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

const ResponseSchema = z.object({ highlights: z.array(HighlightSchema) });

const SYSTEM_PROMPT = (count: number, minSec: number, maxSec: number) =>
  `당신은 짧은 영상 편집자다. 아래 단어 단위 타임스탬프 트랜스크립트를 분석해서 시청자를 끌어당길 ${count}개의 하이라이트를 골라라. 각 하이라이트는 ${minSec}초 ~ ${maxSec}초 사이여야 한다. 응답은 다음 JSON 스키마를 정확히 따른다: {"highlights":[{"start_sec":number,"end_sec":number,"title":string,"hook":string}]}. 다른 어떤 텍스트도 포함하지 말고 JSON만 반환하라.`;

const RERANK_PROMPT = (count: number, minSec: number, maxSec: number) =>
  `당신은 짧은 영상 편집자다. 아래는 같은 영상의 여러 구간에서 뽑힌 하이라이트 후보들이다. 이 중에서 시청자를 가장 끌어당길 ${count}개를 최종 선택하라. 각 하이라이트는 ${minSec}초 ~ ${maxSec}초 사이여야 한다. 동일한 JSON 스키마를 따른다.`;

/**
 * Orchestrates LLM-based highlight extraction.
 *
 * - Single-call path for transcripts under `THRESHOLD` words.
 * - Chunked path with a final rerank call for longer transcripts.
 * - `cancel()` triggers an AbortController that propagates to the in-flight
 *   LLM HTTP request via the openai SDK signal.
 */
export class HighlightService {
  private static readonly THRESHOLD = 4000;
  private static readonly CHUNK_SIZE = 2500;
  private static readonly OVERLAP = 300;

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
      const plan = planChunks(opts.transcript.words, {
        threshold: HighlightService.THRESHOLD,
        chunkSize: HighlightService.CHUNK_SIZE,
        overlap: HighlightService.OVERLAP,
      });
      const sysChunk = SYSTEM_PROMPT(opts.count, opts.minSec, opts.maxSec);
      const candidates: Highlight[] = [];
      for (const chunk of plan.chunks) {
        this.emitProgress({
          jobId: opts.audioPath,
          chunkIndex: chunk.index,
          chunkTotal: plan.chunks.length,
          phase: 'chunk',
        });
        const userPrompt = formatChunkPrompt(chunk.words, chunk.startSec, chunk.endSec);
        const raw = await this.client.chatJson({
          apiKey: opts.apiKey,
          model: opts.model,
          systemPrompt: sysChunk,
          userPrompt,
          signal,
        });
        const parsed = ResponseSchema.parse(raw);
        candidates.push(...parsed.highlights);
      }

      let finalHighlights: Highlight[];
      if (plan.needsRerank) {
        this.emitProgress({
          jobId: opts.audioPath,
          chunkIndex: 1,
          chunkTotal: 1,
          phase: 'rerank',
        });
        const sysRerank = RERANK_PROMPT(opts.count, opts.minSec, opts.maxSec);
        const userPrompt = `다음은 후보 목록이다 (JSON):\n${JSON.stringify({ candidates }, null, 2)}`;
        const raw = await this.client.chatJson({
          apiKey: opts.apiKey,
          model: opts.model,
          systemPrompt: sysRerank,
          userPrompt,
          temperature: 0.2,
          signal,
        });
        finalHighlights = ResponseSchema.parse(raw).highlights;
      } else {
        finalHighlights = candidates;
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

function formatChunkPrompt(
  words: { start: number; end: number; text: string }[],
  startSec: number,
  endSec: number,
): string {
  const wordLines = words.map((w) => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}] ${w.text}`).join('\n');
  return `구간: ${startSec.toFixed(2)}s - ${endSec.toFixed(2)}s\n\n트랜스크립트 (단어 단위):\n${wordLines}`;
}
