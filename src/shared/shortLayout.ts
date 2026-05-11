/**
 * Output canvas + crop-aspect constants for the rendered short (1080×1920 9:16 canvas with 3:4 inner crop region).
 *
 * The short has 320px black bars at top and bottom (for the title and the
 * burned-in subtitle), so the inner video region is 1080×1280 even though the
 * final canvas is 1080×1920. Source video is cropped to
 * `ih * VIDEO_CROP_NUM / VIDEO_CROP_DEN : ih` (= 3:4 when num/den = 3/4)
 * and scaled into the inner region, then padded out to 1080×1920.
 *
 * Single source of truth — imported by RenderService (argv builder),
 * SubtitleGenerator (MarginV centering) and SendcmdGenerator (cropW for face tracking).
 */
export const SHORT_LAYOUT = {
  outputWidth: 1080,
  outputHeight: 1920,
  topBarHeight: 320,
  bottomBarHeight: 320,
  videoHeight: 1280, // outputHeight - topBarHeight - bottomBarHeight
} as const;

/** crop = ih * VIDEO_CROP_NUM / VIDEO_CROP_DEN : ih. 3/4 today (was 9/16). */
export const VIDEO_CROP_NUM = 3;
export const VIDEO_CROP_DEN = 4;
