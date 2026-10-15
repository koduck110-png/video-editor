// 新しく作るクリップやプロジェクトの初期値と、保存データの読み込み時の補正
import {
  Clip,
  DEFAULT_ADJUST,
  DEFAULT_EXPORT,
  DEFAULT_TRANSFORM,
  MediaClip,
  Project,
  ProjectSettings,
  RATIOS,
  RatioId,
  TextClip,
  Track,
  newId,
} from './types';

export function settingsForRatio(ratio: RatioId, base?: ProjectSettings): ProjectSettings {
  const r = RATIOS.find((x) => x.id === ratio) ?? RATIOS[0];
  return {
    ratio: r.id,
    width: r.w,
    height: r.h,
    background: base?.background ?? { type: 'color', color: '#000000' },
    export: base?.export ?? { ...DEFAULT_EXPORT },
  };
}

export function createEmptyProject(ratio: RatioId = '16:9'): Project {
  return {
    version: 2,
    settings: settingsForRatio(ratio),
    tracks: [
      { id: newId('track'), kind: 'text', name: '文字 1' },
      { id: newId('track'), kind: 'video', name: '映像 1' },
      { id: newId('track'), kind: 'audio', name: '音声 1' },
    ],
    clips: [],
  };
}

export function createMediaClip(fields: Pick<MediaClip, 'trackId' | 'assetId' | 'start' | 'duration'> & Partial<MediaClip>): MediaClip {
  return {
    id: newId('clip'),
    type: 'media',
    inPoint: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    audioDetached: false,
    filter: { id: 'none', intensity: 1 },
    adjust: { ...DEFAULT_ADJUST },
    transform: { ...DEFAULT_TRANSFORM },
    animIn: null,
    animOut: null,
    transitionIn: null,
    ...fields,
  };
}

export type TextStyle = Omit<
  TextClip,
  'id' | 'trackId' | 'start' | 'duration' | 'type' | 'text' | 'transform' | 'animIn' | 'animOut' | 'transitionIn'
>;

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'gothic',
  fontSize: 96,
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.25,
  strokeColor: '#000000',
  strokeWidth: 8,
  bgColor: '#000000',
  bgOpacity: 0,
  shadowColor: '#000000',
  shadowBlur: 0,
  shadowDistance: 0,
};

/** 「文字」パネルに並べる、すぐに使える文字のデザイン */
export const TEXT_PRESETS: { id: string; name: string; style: Partial<TextStyle> }[] = [
  { id: 'basic', name: '基本', style: {} },
  { id: 'plain', name: 'シンプル', style: { strokeWidth: 0, shadowBlur: 12, shadowDistance: 4, shadowColor: '#000000' } },
  { id: 'yellow', name: 'テロップ黄', style: { color: '#ffe600', strokeColor: '#000000', strokeWidth: 10 } },
  { id: 'redwhite', name: '赤ふち', style: { color: '#ffffff', strokeColor: '#e60033', strokeWidth: 12 } },
  { id: 'box', name: '黒帯', style: { strokeWidth: 0, bgColor: '#000000', bgOpacity: 0.7, fontSize: 72 } },
  { id: 'whitebox', name: '白帯', style: { color: '#111111', strokeWidth: 0, bgColor: '#ffffff', bgOpacity: 0.9, fontSize: 72 } },
  { id: 'pop', name: 'ポップ', style: { fontFamily: 'potta', color: '#ff5fa2', strokeColor: '#ffffff', strokeWidth: 12, shadowBlur: 0, shadowDistance: 8, shadowColor: '#5a2a8a' } },
  { id: 'impact', name: '極太', style: { fontFamily: 'dela', color: '#ffffff', strokeColor: '#1a1a1a', strokeWidth: 14, fontSize: 120 } },
  { id: 'neon', name: 'ネオン', style: { color: '#ffffff', strokeColor: '#00e5ff', strokeWidth: 4, shadowColor: '#00e5ff', shadowBlur: 30, shadowDistance: 0 } },
  { id: 'hand', name: '手書き風', style: { fontFamily: 'yusei', bold: false, strokeWidth: 6, strokeColor: '#3a2a1a' } },
  { id: 'mincho', name: '明朝', style: { fontFamily: 'mincho', bold: true, strokeWidth: 0, shadowBlur: 16, shadowDistance: 3, color: '#ffffff' } },
  { id: 'cute', name: 'かわいい', style: { fontFamily: 'hachi', color: '#ffffff', strokeColor: '#ff8fb1', strokeWidth: 10, bold: false } },
];

export function createTextClip(
  fields: Pick<TextClip, 'trackId' | 'start' | 'duration'> & Partial<TextClip>,
): TextClip {
  return {
    id: newId('clip'),
    type: 'text',
    text: '文字を入力',
    ...DEFAULT_TEXT_STYLE,
    transform: { ...DEFAULT_TRANSFORM, y: 0.82 },
    animIn: null,
    animOut: null,
    transitionIn: null,
    ...fields,
  };
}

/** 保存データなどを読み込むとき、足りない項目を初期値で埋める */
export function normalizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Project> & { tracks?: Track[]; clips?: Clip[] };
  if (!Array.isArray(r.tracks) || !Array.isArray(r.clips)) return null;
  const ratio = (r.settings?.ratio ?? '16:9') as RatioId;
  const base = settingsForRatio(ratio);
  const settings: ProjectSettings = {
    ...base,
    background: r.settings?.background ?? base.background,
    export: { ...DEFAULT_EXPORT, ...(r.settings?.export ?? {}) },
  };
  const clips: Clip[] = [];
  for (const c of r.clips) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'media') {
      const m = c as MediaClip;
      clips.push(
        createMediaClip({
          ...m,
          transform: { ...DEFAULT_TRANSFORM, ...(m.transform ?? {}) },
          adjust: { ...DEFAULT_ADJUST, ...(m.adjust ?? {}) },
          filter: m.filter ?? { id: 'none', intensity: 1 },
        }),
      );
    } else if (c.type === 'text') {
      const t = c as TextClip;
      clips.push(createTextClip({ ...t, transform: { ...DEFAULT_TRANSFORM, ...(t.transform ?? { y: 0.82 }) } }));
    }
  }
  return { version: 2, settings, tracks: r.tracks.map((t) => ({ ...t })), clips };
}
