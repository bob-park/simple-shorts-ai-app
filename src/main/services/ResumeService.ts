import { type HighlightSet, HighlightSetSchema } from '@shared/highlight';
import type { RenderClipResult, RenderResult } from '@shared/render';
import type { ResumeSnapshot } from '@shared/resume';
import { type Transcript, TranscriptSchema } from '@shared/transcript';
import { type VideoMeta, VideoMetaSchema } from '@shared/youtube';
import { basename, extname, join } from 'node:path';

interface SettingsLike {
  get(): { paths: { downloads: string; outputs: string } };
}

type FsLike = {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string, enc: 'utf8') => Promise<string>;
  access: (path: string) => Promise<void>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
};

const META_SUFFIX = '.meta.json';

/**
 * Detect and hydrate prior pipeline runs from on-disk artifacts. No caching
 * — meta.json files are tiny (~300 bytes) and a typical user has < 100
 * prior downloads, so a full directory scan per call is fine.
 */
export class ResumeService {
  constructor(
    private readonly settings: SettingsLike,
    private readonly fs: FsLike,
  ) {}

  async detect(videoId: string): Promise<ResumeSnapshot | null> {
    const downloadsDir = this.settings.get().paths.downloads;
    let entries: string[];
    try {
      entries = await this.fs.readdir(downloadsDir);
    } catch {
      return null;
    }
    const candidates: { sourcePath: string; meta: VideoMeta; mtimeMs: number }[] = [];
    for (const name of entries) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const metaPath = join(downloadsDir, name);
      const sourcePath = metaPath.slice(0, -META_SUFFIX.length);
      const meta = await this.tryReadMeta(metaPath);
      if (!meta || meta.id !== videoId) continue;
      try {
        await this.fs.access(sourcePath);
      } catch {
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await this.fs.stat(metaPath)).mtimeMs;
      } catch {
        // ignore
      }
      candidates.push({ sourcePath, meta, mtimeMs });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const winner = candidates[0]!;
    return this.buildSnapshot(winner.sourcePath, winner.meta);
  }

  async hydrate(sourcePath: string): Promise<ResumeSnapshot | null> {
    const meta = await this.tryReadMeta(`${sourcePath}${META_SUFFIX}`);
    if (!meta) return null;
    try {
      await this.fs.access(sourcePath);
    } catch {
      return null;
    }
    return this.buildSnapshot(sourcePath, meta);
  }

  private async tryReadMeta(metaPath: string): Promise<VideoMeta | null> {
    let raw: string;
    try {
      raw = await this.fs.readFile(metaPath, 'utf8');
    } catch {
      return null;
    }
    try {
      return VideoMetaSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async buildSnapshot(sourcePath: string, meta: VideoMeta): Promise<ResumeSnapshot> {
    const transcriptPath = `${sourcePath}.transcript.json`;
    const highlightsPath = `${sourcePath}.highlights.json`;
    const stem = basename(sourcePath, extname(sourcePath));
    const outputDir = join(this.settings.get().paths.outputs, stem);

    const [transcript, highlights] = await Promise.all([
      this.tryReadJson<Transcript>(transcriptPath, (raw) => TranscriptSchema.parse(JSON.parse(raw))),
      this.tryReadJson<HighlightSet>(highlightsPath, (raw) => HighlightSetSchema.parse(JSON.parse(raw))),
    ]);

    const renderResult = await this.tryRebuildRender(outputDir, highlights);

    return {
      url: meta.webpageUrl,
      sourcePath,
      meta,
      download: { outputPath: sourcePath },
      transcript: transcript ? { path: transcriptPath, data: transcript } : undefined,
      highlights: highlights ? { path: highlightsPath, data: highlights } : undefined,
      render: renderResult,
    };
  }

  private async tryReadJson<T>(path: string, parse: (raw: string) => T): Promise<T | null> {
    try {
      const raw = await this.fs.readFile(path, 'utf8');
      return parse(raw);
    } catch {
      return null;
    }
  }

  private async tryRebuildRender(
    outputDir: string,
    highlightSet: HighlightSet | null,
  ): Promise<{ outputDir: string; result: RenderResult } | undefined> {
    if (!highlightSet) return undefined;
    let files: string[];
    try {
      files = await this.fs.readdir(outputDir);
    } catch {
      return undefined;
    }
    const shorts = files.filter((f) => /^short_\d+\.mp4$/.test(f)).sort();
    if (shorts.length === 0) return undefined;
    const results: RenderClipResult[] = shorts.map((file, idx) => {
      const highlight = highlightSet.highlights[idx];
      const segments = highlight?.segments ?? [];
      const startSec = segments[0]?.start_sec ?? 0;
      const endSec = segments[segments.length - 1]?.end_sec ?? 0;
      const montageDurationSec = segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0);
      return {
        index: idx + 1,
        title: highlight?.title ?? `Clip ${idx + 1}`,
        startSec,
        endSec,
        montageDurationSec,
        status: 'done' as const,
        outputPath: join(outputDir, file),
        tracking: null,
        subtitles: null,
      };
    });
    return { outputDir, result: { outputDir, results } };
  }
}
