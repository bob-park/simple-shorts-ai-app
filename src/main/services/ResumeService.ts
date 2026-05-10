import type { ResumeSnapshot } from '@shared/resume';

interface SettingsLike {
  get(): { paths: { downloads: string; outputs: string } };
}

type FsLike = {
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string, enc: 'utf8') => Promise<string>;
  access: (path: string) => Promise<void>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
};

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

  async detect(_videoId: string): Promise<ResumeSnapshot | null> {
    return null;
  }

  async hydrate(_sourcePath: string): Promise<ResumeSnapshot | null> {
    return null;
  }
}
