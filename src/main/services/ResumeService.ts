import type { ResumeSnapshot } from '@shared/resume';
import { type VideoMeta, VideoMetaSchema } from '@shared/youtube';
import { extname, join } from 'node:path';

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
      let raw: string;
      try {
        raw = await this.fs.readFile(metaPath, 'utf8');
      } catch {
        continue;
      }
      let meta: VideoMeta;
      try {
        meta = VideoMetaSchema.parse(JSON.parse(raw));
      } catch {
        continue;
      }
      if (meta.id !== videoId) continue;
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
    return {
      url: winner.meta.webpageUrl,
      sourcePath: winner.sourcePath,
      meta: winner.meta,
      download: { outputPath: winner.sourcePath },
    };
  }

  async hydrate(_sourcePath: string): Promise<ResumeSnapshot | null> {
    return null; // implemented in Task 3
  }
}

void extname; // reserved for Task 3 (outputDir reconstruction)
