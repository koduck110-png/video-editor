// フィルター・色の調整・アニメーション・切り替え効果の中身
import { AnimType, Clip, MediaClip, TransitionType, clipEnd } from '../model/types';

type FilterFn = 'brightness' | 'contrast' | 'saturate' | 'grayscale' | 'sepia' | 'hue-rotate' | 'invert';

export interface FilterPreset {
  id: string;
  name: string;
  /** CSS のフィルター（強さ 1 のときの値） */
  fns: [FilterFn, number][];
  /** 色をかぶせる（ソフトライト） */
  tint?: { color: string; alpha: number };
  /** 一覧で見本に使う色 */
  swatch: string;
}

export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', name: 'なし', fns: [], swatch: 'linear-gradient(135deg,#6aa0ff,#ffb36a)' },
  { id: 'vivid', name: 'ビビッド', fns: [['saturate', 1.6], ['contrast', 1.1]], swatch: 'linear-gradient(135deg,#00a2ff,#ff3d6e)' },
  { id: 'bright', name: '明るく', fns: [['brightness', 1.2], ['saturate', 1.1]], swatch: 'linear-gradient(135deg,#bfe3ff,#fff1c4)' },
  { id: 'warm', name: 'あたたか', fns: [['saturate', 1.15]], tint: { color: '#ff8a00', alpha: 0.35 }, swatch: 'linear-gradient(135deg,#ffb15c,#ff6a3d)' },
  { id: 'cool', name: 'クール', fns: [['saturate', 1.05]], tint: { color: '#0080ff', alpha: 0.35 }, swatch: 'linear-gradient(135deg,#7fd3ff,#3d6bff)' },
  { id: 'mono', name: 'モノクロ', fns: [['grayscale', 1]], swatch: 'linear-gradient(135deg,#222,#ddd)' },
  { id: 'noir', name: 'ノワール', fns: [['grayscale', 1], ['contrast', 1.45], ['brightness', 0.9]], swatch: 'linear-gradient(135deg,#000,#888)' },
  { id: 'sepia', name: 'セピア', fns: [['sepia', 0.85]], swatch: 'linear-gradient(135deg,#704214,#e3c08d)' },
  { id: 'vintage', name: 'ビンテージ', fns: [['sepia', 0.4], ['contrast', 0.9], ['saturate', 0.85], ['brightness', 1.05]], swatch: 'linear-gradient(135deg,#a07850,#e8d2a8)' },
  { id: 'fade', name: 'フェード', fns: [['contrast', 0.78], ['brightness', 1.1], ['saturate', 0.8]], swatch: 'linear-gradient(135deg,#9aa6b2,#e6e1d8)' },
  { id: 'film', name: 'フィルム', fns: [['contrast', 1.15], ['saturate', 0.9], ['sepia', 0.15]], tint: { color: '#00a080', alpha: 0.15 }, swatch: 'linear-gradient(135deg,#2f5d50,#d8c49a)' },
  { id: 'drama', name: 'ドラマ', fns: [['contrast', 1.35], ['saturate', 0.85], ['brightness', 0.95]], swatch: 'linear-gradient(135deg,#1c2a3a,#c7a17a)' },
  { id: 'night', name: 'ナイト', fns: [['brightness', 0.85], ['contrast', 1.15], ['saturate', 0.75]], tint: { color: '#2040ff', alpha: 0.3 }, swatch: 'linear-gradient(135deg,#0b1a4a,#4a6aff)' },
  { id: 'pink', name: 'ピンク', fns: [['saturate', 1.1]], tint: { color: '#ff4fa3', alpha: 0.3 }, swatch: 'linear-gradient(135deg,#ffc0dd,#ff5fa2)' },
  { id: 'invert', name: 'ネガ', fns: [['invert', 1]], swatch: 'linear-gradient(135deg,#00ffff,#ff00ff)' },
];

export function getFilterPreset(id: string): FilterPreset {
  return FILTER_PRESETS.find((f) => f.id === id) ?? FILTER_PRESETS[0];
}

/** 強さ i のときの値（値が「1 で変化なし」の種類と「0 で変化なし」の種類がある） */
function scaled(fn: FilterFn, v: number, i: number): number {
  const identityOne = fn === 'brightness' || fn === 'contrast' || fn === 'saturate';
  return identityOne ? 1 + (v - 1) * i : v * i;
}

function fnCss(fn: FilterFn, v: number): string {
  return fn === 'hue-rotate' ? `hue-rotate(${v}deg)` : `${fn}(${v.toFixed(3)})`;
}

/** canvas の filter に入れる文字列。blurPx は実際の画素数 */
export function mediaFilterCss(clip: MediaClip, blurPx: number): string {
  const parts: string[] = [];
  const a = clip.adjust;
  if (a.brightness) parts.push(fnCss('brightness', 1 + a.brightness * 0.6));
  if (a.contrast) parts.push(fnCss('contrast', 1 + a.contrast * 0.6));
  if (a.saturation) parts.push(fnCss('saturate', 1 + a.saturation));
  if (a.hue) parts.push(fnCss('hue-rotate', a.hue * 180));
  const preset = getFilterPreset(clip.filter.id);
  for (const [fn, v] of preset.fns) parts.push(fnCss(fn, scaled(fn, v, clip.filter.intensity)));
  if (blurPx > 0.05) parts.push(`blur(${blurPx.toFixed(2)}px)`);
  return parts.join(' ') || 'none';
}

/** 色をかぶせる処理（色温度・フィルターの色）。なければ空 */
export function mediaTints(clip: MediaClip): { color: string; alpha: number }[] {
  const out: { color: string; alpha: number }[] = [];
  const temp = clip.adjust.temperature;
  if (temp) out.push({ color: temp > 0 ? '#ff8a00' : '#0080ff', alpha: Math.abs(temp) * 0.45 });
  const preset = getFilterPreset(clip.filter.id);
  if (preset.tint) out.push({ color: preset.tint.color, alpha: preset.tint.alpha * clip.filter.intensity });
  return out;
}

// ---------- アニメーション ----------

export const ANIM_IN: { type: AnimType; name: string }[] = [
  { type: 'fade', name: 'フェードイン' },
  { type: 'zoomIn', name: 'ズームイン' },
  { type: 'zoomOut', name: 'ズームアウト' },
  { type: 'left', name: '左から' },
  { type: 'right', name: '右から' },
  { type: 'up', name: '上から' },
  { type: 'down', name: '下から' },
  { type: 'pop', name: 'ポップ' },
  { type: 'spin', name: '回転' },
  { type: 'blur', name: 'ぼかし' },
  { type: 'typewriter', name: 'タイプ（文字のみ）' },
];

export const ANIM_OUT: { type: AnimType; name: string }[] = [
  { type: 'fade', name: 'フェードアウト' },
  { type: 'zoomIn', name: 'ズームイン' },
  { type: 'zoomOut', name: 'ズームアウト' },
  { type: 'left', name: '左へ' },
  { type: 'right', name: '右へ' },
  { type: 'up', name: '上へ' },
  { type: 'down', name: '下へ' },
  { type: 'pop', name: 'ポップ' },
  { type: 'spin', name: '回転' },
  { type: 'blur', name: 'ぼかし' },
  { type: 'typewriter', name: 'タイプ（文字のみ）' },
];

export interface AnimState {
  alpha: number;
  /** 画面の幅・高さを 1 とした移動量 */
  dx: number;
  dy: number;
  scale: number;
  rotation: number;
  /** ぼかし（画面の画素） */
  blur: number;
  /** 文字の表示割合（タイプ） */
  reveal: number;
}

export const NO_ANIM: AnimState = { alpha: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0, reveal: 1 };

export const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
export const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const backOut = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

/** e: 0 = 見えない側、1 = ふつうの状態。p は直線の進み具合 */
function applyAnim(st: AnimState, type: AnimType, e: number, p: number): void {
  switch (type) {
    case 'fade':
      st.alpha *= e;
      break;
    case 'zoomIn':
      st.scale *= 0.5 + 0.5 * e;
      st.alpha *= e;
      break;
    case 'zoomOut':
      st.scale *= 1.6 - 0.6 * e;
      st.alpha *= e;
      break;
    case 'left':
      st.dx -= 1 - e;
      break;
    case 'right':
      st.dx += 1 - e;
      break;
    case 'up':
      st.dy -= 1 - e;
      break;
    case 'down':
      st.dy += 1 - e;
      break;
    case 'spin':
      st.rotation -= (1 - e) * 360;
      st.scale *= 0.3 + 0.7 * e;
      st.alpha *= Math.min(1, e * 1.5);
      break;
    case 'pop':
      st.scale *= Math.max(0, backOut(p));
      st.alpha *= Math.min(1, p * 4);
      break;
    case 'blur':
      st.blur += (1 - e) * 40;
      st.alpha *= e;
      break;
    case 'typewriter':
      st.reveal *= p;
      break;
  }
}

/** 時間 t のアニメーションの状態（クリップの中にいるときだけ効く） */
export function animState(clip: Clip, t: number): AnimState {
  const st = { ...NO_ANIM };
  const end = clipEnd(clip);
  if (clip.animIn && t >= clip.start - 1e-6) {
    const d = Math.min(clip.animIn.duration, clip.duration);
    if (d > 0 && t < clip.start + d) {
      const p = Math.max(0, (t - clip.start) / d);
      applyAnim(st, clip.animIn.type, easeOutCubic(p), p);
    }
  }
  if (clip.animOut && t < end) {
    const d = Math.min(clip.animOut.duration, clip.duration);
    if (d > 0 && t > end - d) {
      const p = Math.max(0, (end - t) / d);
      applyAnim(st, clip.animOut.type, easeOutCubic(p), p);
    }
  }
  return st;
}

// ---------- 切り替え効果 ----------

export const TRANSITIONS: { type: TransitionType; name: string; icon: string }[] = [
  { type: 'fade', name: 'クロスフェード', icon: '◐' },
  { type: 'black', name: '暗転', icon: '●' },
  { type: 'white', name: 'フラッシュ', icon: '○' },
  { type: 'slideLeft', name: '左へスライド', icon: '⇠' },
  { type: 'slideRight', name: '右へスライド', icon: '⇢' },
  { type: 'slideUp', name: '上へスライド', icon: '⇡' },
  { type: 'slideDown', name: '下へスライド', icon: '⇣' },
  { type: 'wipe', name: 'ワイプ', icon: '▤' },
  { type: 'circle', name: '円形', icon: '◎' },
  { type: 'zoom', name: 'ズーム', icon: '⤢' },
  { type: 'blur', name: 'ぼかし', icon: '≋' },
];

export interface LayerFx {
  alpha: number;
  dx: number;
  dy: number;
  scale: number;
  blur: number;
  /** 見える範囲を切り抜く（画面の座標） */
  clip?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

export const NO_FX: LayerFx = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0 };

export type Layer = { clip: Clip; fx: LayerFx } | { fill: string; alpha: number };

/** 切り替え中の重ね方。p は 0〜1 */
export function transitionLayers(a: Clip, b: Clip, type: TransitionType, p: number): Layer[] {
  const e = easeInOutCubic(p);
  const fx = (o: Partial<LayerFx>): LayerFx => ({ ...NO_FX, ...o });
  switch (type) {
    case 'fade':
      return [
        { clip: a, fx: NO_FX },
        { clip: b, fx: fx({ alpha: e }) },
      ];
    case 'black':
    case 'white': {
      const color = type === 'black' ? '#000000' : '#ffffff';
      return p < 0.5
        ? [{ clip: a, fx: NO_FX }, { fill: color, alpha: Math.min(1, p * 2) }]
        : [{ clip: b, fx: NO_FX }, { fill: color, alpha: Math.min(1, (1 - p) * 2) }];
    }
    case 'slideLeft':
      return [
        { clip: a, fx: fx({ dx: -e }) },
        { clip: b, fx: fx({ dx: 1 - e }) },
      ];
    case 'slideRight':
      return [
        { clip: a, fx: fx({ dx: e }) },
        { clip: b, fx: fx({ dx: -(1 - e) }) },
      ];
    case 'slideUp':
      return [
        { clip: a, fx: fx({ dy: -e }) },
        { clip: b, fx: fx({ dy: 1 - e }) },
      ];
    case 'slideDown':
      return [
        { clip: a, fx: fx({ dy: e }) },
        { clip: b, fx: fx({ dy: -(1 - e) }) },
      ];
    case 'wipe':
      return [
        { clip: a, fx: NO_FX },
        {
          clip: b,
          fx: fx({
            clip: (ctx, w, h) => {
              ctx.beginPath();
              ctx.rect(0, 0, w * e, h);
              ctx.clip();
            },
          }),
        },
      ];
    case 'circle':
      return [
        { clip: a, fx: NO_FX },
        {
          clip: b,
          fx: fx({
            clip: (ctx, w, h) => {
              ctx.beginPath();
              ctx.arc(w / 2, h / 2, (e * Math.hypot(w, h)) / 2 + 0.01, 0, Math.PI * 2);
              ctx.clip();
            },
          }),
        },
      ];
    case 'zoom':
      return [
        { clip: a, fx: fx({ scale: 1 + e * 0.6, alpha: 1 - e }) },
        { clip: b, fx: fx({ scale: 0.85 + 0.15 * e, alpha: e }) },
      ];
    case 'blur':
      return [
        { clip: a, fx: fx({ blur: e * 40 }) },
        { clip: b, fx: fx({ blur: (1 - e) * 40, alpha: e }) },
      ];
  }
}
