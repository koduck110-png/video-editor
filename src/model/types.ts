// 編集データの型。ここにあるものが「元に戻す・やり直し」の対象になる。

export const FPS = 30;
export const OUT_WIDTH = 1920;
export const OUT_HEIGHT = 1080;
/** クリップの最短の長さ（秒） */
export const MIN_CLIP = 1 / FPS;

export type TrackKind = 'video' | 'text' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
}

interface ClipBase {
  id: string;
  trackId: string;
  /** タイムライン上の開始位置（秒） */
  start: number;
  /** 長さ（秒） */
  duration: number;
}

/** 動画・画像・音楽のクリップ */
export interface MediaClip extends ClipBase {
  type: 'media';
  assetId: string;
  /** 素材のどこから使うか（秒） */
  inPoint: number;
}

export interface TextClip extends ClipBase {
  type: 'text';
  text: string;
  /** 1920x1080 の画面を基準にした文字の大きさ（px） */
  fontSize: number;
  color: string;
  bold: boolean;
  strokeColor: string;
  /** 縁取りの太さ（px）。0 で縁取りなし */
  strokeWidth: number;
  /** 文字の中心の位置。0〜1（画面の左端=0、右端=1） */
  x: number;
  /** 文字の中心の位置。0〜1（画面の上端=0、下端=1） */
  y: number;
}

export type Clip = MediaClip | TextClip;

export interface Project {
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

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function projectDuration(p: Project): number {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, clipEnd(c));
  return d;
}

/** 時間をフレーム単位にそろえる */
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
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}${idCounter}`;
}
