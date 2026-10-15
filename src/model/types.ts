// 編集データの型。Project の中身が「元に戻す・やり直し」と自動保存の対象になる。

/** タイムラインのコマの細かさ（吸着・分割の単位） */
export const FPS = 30;
/** クリップの最短の長さ（秒） */
export const MIN_CLIP = 1 / FPS;
/** 画面の座標の基準（短い辺を 1080 とする） */
export const BASE_SHORT_SIDE = 1080;

export type TrackKind = 'video' | 'text' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
}

/** 画面比率 */
export type RatioId = '16:9' | '9:16' | '1:1' | '4:5' | '4:3' | '3:4' | '21:9';

export const RATIOS: { id: RatioId; w: number; h: number; label: string; hint: string }[] = [
  { id: '16:9', w: 1920, h: 1080, label: '16:9', hint: '横長（YouTube など）' },
  { id: '9:16', w: 1080, h: 1920, label: '9:16', hint: '縦長（TikTok・ショート・リール）' },
  { id: '1:1', w: 1080, h: 1080, label: '1:1', hint: '正方形' },
  { id: '4:5', w: 1080, h: 1350, label: '4:5', hint: 'Instagram の縦長投稿' },
  { id: '4:3', w: 1440, h: 1080, label: '4:3', hint: '昔のテレビ' },
  { id: '3:4', w: 1080, h: 1440, label: '3:4', hint: '縦長' },
  { id: '21:9', w: 2520, h: 1080, label: '21:9', hint: '映画のような横長' },
];

export type Background = { type: 'color'; color: string } | { type: 'blur'; amount: number };

export interface ExportSettings {
  /** 短い辺のピクセル数（720 / 1080 / 1440 / 2160） */
  shortSide: number;
  fps: number;
  quality: 'standard' | 'high' | 'max';
}

export interface ProjectSettings {
  ratio: RatioId;
  /** 画面の大きさ（座標の基準）。ratio から決まる */
  width: number;
  height: number;
  background: Background;
  export: ExportSettings;
}

/** 位置・大きさ・回転など */
export interface Transform {
  /** 中心の位置（0〜1。画面の左上が 0,0） */
  x: number;
  y: number;
  /** 1 = 画面に収まる大きさ（文字は文字の大きさの倍率） */
  scale: number;
  /** 回転（度） */
  rotation: number;
  /** 不透明度（0〜1） */
  opacity: number;
  flipH: boolean;
  flipV: boolean;
}

export type AnimType =
  | 'fade'
  | 'zoomIn'
  | 'zoomOut'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'spin'
  | 'pop'
  | 'blur'
  | 'typewriter';

export interface Anim {
  type: AnimType;
  /** 秒 */
  duration: number;
}

export type TransitionType =
  | 'fade'
  | 'black'
  | 'white'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'wipe'
  | 'circle'
  | 'zoom'
  | 'blur';

export interface Transition {
  type: TransitionType;
  /** 秒（前後のクリップに半分ずつかかる） */
  duration: number;
}

export interface Adjust {
  /** すべて -1〜1、0 で変化なし */
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  hue: number;
  vignette: number;
}

export interface FilterChoice {
  id: string;
  /** 0〜1 */
  intensity: number;
}

interface ClipBase {
  id: string;
  trackId: string;
  /** タイムライン上の開始位置（秒） */
  start: number;
  /** 長さ（秒） */
  duration: number;
  transform: Transform;
  animIn: Anim | null;
  animOut: Anim | null;
  /** 前のクリップとの切り替え効果（すき間なく並んでいるときだけ有効） */
  transitionIn: Transition | null;
}

/** 動画・画像・音楽のクリップ */
export interface MediaClip extends ClipBase {
  type: 'media';
  assetId: string;
  /** 素材のどこから使うか（秒） */
  inPoint: number;
  /** 再生速度（1 = 等速） */
  speed: number;
  /** 音量（1 = 100%） */
  volume: number;
  /** フェードイン・アウト（秒） */
  fadeIn: number;
  fadeOut: number;
  /** 動画の音声を別のクリップに分けた（この映像クリップからは音を出さない） */
  audioDetached: boolean;
  filter: FilterChoice;
  adjust: Adjust;
}

export interface TextClip extends ClipBase {
  type: 'text';
  text: string;
  fontFamily: string;
  /** 画面（短い辺 1080）を基準にした文字の大きさ */
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** 文字の間隔（px） */
  letterSpacing: number;
  /** 行の高さ（文字の大きさの倍率） */
  lineHeight: number;
  strokeColor: string;
  /** 縁取りの太さ。0 で縁取りなし */
  strokeWidth: number;
  /** 背景の色と濃さ（0 で背景なし） */
  bgColor: string;
  bgOpacity: number;
  shadowColor: string;
  /** 影のぼかし。0 で影なし */
  shadowBlur: number;
  shadowDistance: number;
}

export type Clip = MediaClip | TextClip;

export interface Project {
  version: 2;
  settings: ProjectSettings;
  /** 画面の上から順。描画は下のトラックから順に重ねる */
  tracks: Track[];
  clips: Clip[];
}

export type AssetKind = 'video' | 'image' | 'audio';

/** 読み込んだ素材（元に戻すの対象外） */
export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  file: File;
  url: string;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** 秒。画像は Infinity */
  duration: number;
  width: number;
  height: number;
  thumbnail?: string;
  image?: ImageBitmap;
  /** 動画に音声が入っているか（解析が終わるまでは undefined） */
  hasAudio?: boolean;
  audioBuffer?: AudioBuffer;
  /** 波形表示用。1 秒あたり PEAKS_PER_SEC 個 */
  peaks?: Float32Array;
}

export const PEAKS_PER_SEC = 50;

export const DEFAULT_TRANSFORM: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false };
export const DEFAULT_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, hue: 0, vignette: 0 };
export const DEFAULT_EXPORT: ExportSettings = { shortSide: 1080, fps: 30, quality: 'high' };

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function projectDuration(p: Project): number {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, clipEnd(c));
  return d;
}

/** 素材の中での時間（速度を考える） */
export function sourceTimeAt(c: MediaClip, t: number): number {
  return c.inPoint + (t - c.start) * c.speed;
}

/** このクリップが使う素材の長さ */
export function sourceSpan(c: MediaClip): number {
  return c.duration * c.speed;
}

/** 時間をコマ単位にそろえる */
export function snapToFrame(t: number): number {
  return Math.round(t * FPS) / FPS;
}

export function trackKindForAsset(kind: AssetKind): TrackKind {
  return kind === 'audio' ? 'audio' : 'video';
}

export function formatTime(t: number, withFrac = true): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!withFrac) return base;
  const f = Math.floor((t % 1) * 10 + 1e-6);
  return `${base}.${f}`;
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter++;
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}${idCounter}`;
}

/** 書き出すときの大きさ（偶数にそろえる） */
export function exportSize(s: ProjectSettings): { width: number; height: number; scale: number } {
  const scale = s.export.shortSide / BASE_SHORT_SIDE;
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return { width: even(s.width), height: even(s.height), scale };
}
