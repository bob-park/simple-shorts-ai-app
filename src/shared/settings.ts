import { z } from 'zod';

export const WhisperModelSchema = z.enum(['tiny', 'base', 'small', 'medium', 'large-v3']);
export type WhisperModel = z.infer<typeof WhisperModelSchema>;

export const WhisperLanguageSchema = z.enum(['auto', 'ko', 'en', 'ja', 'zh']);
export type WhisperLanguage = z.infer<typeof WhisperLanguageSchema>;

export const WhisperDeviceSchema = z.enum(['auto', 'cpu', 'cuda', 'metal']);
export type WhisperDevice = z.infer<typeof WhisperDeviceSchema>;

export const SubtitlePositionSchema = z.enum(['bottom', 'middle']);
export type SubtitlePosition = z.infer<typeof SubtitlePositionSchema>;

export const TitleFontWeightSchema = z.enum(['400', '500', '600', '700', '800', '900']);
export type TitleFontWeight = z.infer<typeof TitleFontWeightSchema>;

export const SettingsSchema = z.object({
  paths: z.object({
    downloads: z.string().min(1),
    workspace: z.string().min(1),
    outputs: z.string().min(1),
  }),
  whisper: z.object({
    model: WhisperModelSchema,
    language: WhisperLanguageSchema,
    device: WhisperDeviceSchema,
  }),
  shorts: z
    .object({
      defaultCount: z.number().int().min(1).max(10),
      minSec: z.number().int().min(5).max(180),
      maxSec: z.number().int().min(5).max(180),
    })
    .refine((v) => v.minSec <= v.maxSec, {
      message: 'minSec must be ≤ maxSec',
      path: ['minSec'],
    }),
  subtitles: z.object({
    enabled: z.boolean(),
    fontFamily: z.string().min(1),
    fontSize: z.number().int().min(16).max(160),
    fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    position: SubtitlePositionSchema,
    titleFontSize: z.number().int().min(32).max(120),
    titleFontWeight: TitleFontWeightSchema,
  }),
  ui: z.object({
    historyView: z.enum(['list', 'thumbnails']),
    theme: z.literal('light'),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Default values used when no persisted settings exist yet, or when filling
 * gaps in a partial persisted blob. The path defaults are placeholders —
 * `SettingsStore` resolves them to real OS paths at first read.
 */
export const DEFAULT_SETTINGS_TEMPLATE: Omit<Settings, 'paths'> & {
  paths: { downloads: ''; workspace: ''; outputs: '' };
} = {
  paths: { downloads: '', workspace: '', outputs: '' },
  whisper: {
    model: 'small',
    language: 'auto',
    device: 'auto',
  },
  shorts: {
    defaultCount: 3,
    minSec: 20,
    maxSec: 60,
  },
  subtitles: {
    enabled: true,
    fontFamily: 'Pretendard',
    fontSize: 64,
    fillColor: '#FFFFFF',
    outlineColor: '#000000',
    position: 'bottom',
    titleFontSize: 72,
    titleFontWeight: '700',
  },
  ui: {
    historyView: 'list',
    theme: 'light',
  },
};
