import type { HighlightSet } from './highlight';
import type { RenderResult } from './render';
import type { Transcript } from './transcript';
import type { VideoMeta } from './youtube';

/**
 * Snapshot of every artifact a prior job has on disk. Returned by main's
 * `resume:detect` and `resume:hydrate` IPCs and consumed by the renderer to
 * push the 5 NewJob pipeline hooks into their `done` states.
 *
 * `download` is always present when this object is returned (the source video
 * file existing on disk is the precondition for building a snapshot at all).
 * Later fields are optional — present only when their respective sibling
 * artifact was found and parsed successfully.
 */
export interface ResumeSnapshot {
  url: string;
  sourcePath: string;
  meta: VideoMeta;
  download: { outputPath: string };
  transcript?: { path: string; data: Transcript };
  highlights?: { path: string; data: HighlightSet };
  render?: { outputDir: string; result: RenderResult };
}
