// 1枚の画面（フレーム）を描く処理。プレビューと書き出しの両方で同じものを使う。
// ctx は「画面の座標（project.settings の幅・高さ）」で描けるように変換しておくこと。
// k は「画面の座標 1 あたりの実際の画素数」（ぼかしや影の大きさをそろえるため）。
import { activeClipOnTrack, clipsOnTrack, effectiveTransition } from '../model/ops';
import { Clip, MediaClip, Project, TextClip } from '../model/types';
import { Layer, LayerFx, NO_FX, animState, mediaFilterCss, mediaTints, transitionLayers } from './effects';
import { fontStack, isFontReady } from './fonts';

export interface VisualSource {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** 透明な部分がない（動画） */
  opaque?: boolean;
}

/** クリップの映像を返す関数（プレビューでは <video>、書き出しでは解析した画像） */
export type SourceResolver = (clip: MediaClip) => VisualSource | null;

type Ctx = CanvasRenderingContext2D;

// フィルターをかけるときに使う作業用の canvas（クリップごと）
const scratches = new Map<string, HTMLCanvasElement>();
function getScratch(key: string, w: number, h: number): HTMLCanvasElement {
  let c = scratches.get(key);
  if (!c) {
    if (scratches.size > 12) {
      const first = scratches.keys().next().value;
      if (first !== undefined) scratches.delete(first);
    }
    c = document.createElement('canvas');
    scratches.set(key, c);
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  } else {
    c.getContext('2d')!.clearRect(0, 0, w, h);
  }
  return c;
}

const EPS = 1e-6;

/** 時間 t にその段で描くもの（切り替え中は2つ） */
export function trackLayersAt(project: Project, trackId: string, t: number): Layer[] {
  for (const b of clipsOnTrack(project, trackId)) {
    const tr = effectiveTransition(project, b);
    if (!tr) continue;
    const d = tr.transition.duration;
    const w0 = b.start - d / 2;
    if (t >= w0 - EPS && t < b.start + d / 2 - EPS) {
      return transitionLayers(tr.prev, b, tr.transition.type, Math.min(1, Math.max(0, (t - w0) / d)));
    }
  }
  const c = activeClipOnTrack(project, trackId, t);
  return c ? [{ clip: c, fx: NO_FX }] : [];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

/** 映像の表示範囲（画面の座標） */
export function mediaBox(project: Project, clip: MediaClip, srcW: number, srcH: number): Box {
  const { width: W, height: H } = project.settings;
  const fit = Math.min(W / srcW, H / srcH);
  const tr = clip.transform;
  return { cx: tr.x * W, cy: tr.y * H, w: srcW * fit * tr.scale, h: srcH * fit * tr.scale, rotation: tr.rotation };
}

function drawMedia(ctx: Ctx, project: Project, clip: MediaClip, t: number, src: VisualSource, fx: LayerFx, k: number): void {
  const { width: W, height: H } = project.settings;
  const tr = clip.transform;
  const an = animState(clip, t);
  const fit = Math.min(W / src.width, H / src.height);
  const w = src.width * fit;
  const h = src.height * fit;
  const s = tr.scale * an.scale * fx.scale;
  const alpha = clamp01(tr.opacity * an.alpha * fx.alpha);
  if (alpha <= 0.001 || s <= 0.0001) return;
  ctx.save();
  if (fx.clip) fx.clip(ctx, W, H);
  ctx.globalAlpha = alpha;
  ctx.translate((tr.x + an.dx + fx.dx) * W, (tr.y + an.dy + fx.dy) * H);
  ctx.rotate(((tr.rotation + an.rotation) * Math.PI) / 180);
  ctx.scale(s * (tr.flipH ? -1 : 1), s * (tr.flipV ? -1 : 1));
  const filter = mediaFilterCss(clip, (an.blur + fx.blur) * k);
  const tints = mediaTints(clip);
  const vignette = clip.adjust.vignette;
  if (filter === 'none' && tints.length === 0 && vignette <= 0) {
    ctx.drawImage(src.image, -w / 2, -h / 2, w, h);
  } else {
    // 実際の画素の大きさで作業用の canvas に描き、色を整えてから貼る
    const dw = Math.max(1, Math.min(4096, Math.round(w * s * k)));
    const dh = Math.max(1, Math.min(4096, Math.round(h * s * k)));
    const sc = getScratch(clip.id, dw, dh);
    const sctx = sc.getContext('2d')!;
    sctx.filter = filter;
    sctx.drawImage(src.image, 0, 0, dw, dh);
    sctx.filter = 'none';
    if (tints.length) {
      sctx.globalCompositeOperation = 'soft-light';
      for (const tint of tints) {
        sctx.globalAlpha = clamp01(tint.alpha);
        sctx.fillStyle = tint.color;
        sctx.fillRect(0, 0, dw, dh);
      }
      sctx.globalAlpha = 1;
    }
    if (vignette > 0) {
      sctx.globalCompositeOperation = 'source-atop';
      const g = sctx.createRadialGradient(dw / 2, dh / 2, Math.min(dw, dh) * 0.25, dw / 2, dh / 2, Math.hypot(dw, dh) / 2);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${(0.9 * vignette).toFixed(3)})`);
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, dw, dh);
    }
    if (tints.length && !src.opaque) {
      // 透明な部分には色をかぶせない
      sctx.globalCompositeOperation = 'destination-in';
      sctx.filter = filter;
      sctx.drawImage(src.image, 0, 0, dw, dh);
      sctx.filter = 'none';
    }
    sctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(sc, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

export function textFont(clip: TextClip): string {
  return `${clip.italic ? 'italic ' : ''}${clip.bold ? 'bold ' : ''}${clip.fontSize}px ${fontStack(clip.fontFamily)}`;
}

interface TextLayout {
  lines: string[];
  maxW: number;
  lineH: number;
  totalH: number;
  padX: number;
  padY: number;
}

function layoutText(ctx: Ctx, clip: TextClip, reveal = 1): TextLayout {
  ctx.font = textFont(clip);
  ctx.letterSpacing = `${clip.letterSpacing}px`;
  let text = clip.text;
  if (reveal < 1) {
    const chars = Array.from(text);
    text = chars.slice(0, Math.floor(chars.length * reveal)).join('');
  }
  const lines = text.split('\n');
  let maxW = 0;
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
  const lineH = clip.fontSize * clip.lineHeight;
  const totalH = lineH * Math.max(1, clip.text.split('\n').length);
  const hasBg = clip.bgOpacity > 0;
  const padX = hasBg ? clip.fontSize * 0.4 : clip.strokeWidth;
  const padY = hasBg ? clip.fontSize * 0.2 : clip.strokeWidth;
  return { lines, maxW, lineH, totalH, padX, padY };
}

let measureCtx: Ctx | null = null;
function getMeasureCtx(): Ctx {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
  return measureCtx;
}

/** 文字の範囲（画面の座標）。当たり判定や枠の表示に使う */
export function textBox(project: Project, clip: TextClip): Box {
  const ctx = getMeasureCtx();
  ctx.save();
  const L = layoutText(ctx, clip);
  ctx.restore();
  const { width: W, height: H } = project.settings;
  const tr = clip.transform;
  return {
    cx: tr.x * W,
    cy: tr.y * H,
    w: Math.max(clip.fontSize, L.maxW + L.padX * 2) * tr.scale,
    h: (L.totalH + L.padY * 2) * tr.scale,
    rotation: tr.rotation,
  };
}

function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

function drawText(ctx: Ctx, project: Project, clip: TextClip, t: number, fx: LayerFx, k: number, onFontLoaded?: () => void): void {
  if (!clip.text) return;
  const { width: W, height: H } = project.settings;
  const tr = clip.transform;
  const an = animState(clip, t);
  const s = tr.scale * an.scale * fx.scale;
  const alpha = clamp01(tr.opacity * an.alpha * fx.alpha);
  if (alpha <= 0.001 || s <= 0.0001) return;
  isFontReady(clip.fontFamily, clip.bold, clip.text, onFontLoaded ?? (() => {}));
  ctx.save();
  if (fx.clip) fx.clip(ctx, W, H);
  ctx.globalAlpha = alpha;
  ctx.translate((tr.x + an.dx + fx.dx) * W, (tr.y + an.dy + fx.dy) * H);
  ctx.rotate(((tr.rotation + an.rotation) * Math.PI) / 180);
  ctx.scale(s * (tr.flipH ? -1 : 1), s * (tr.flipV ? -1 : 1));
  const blur = (an.blur + fx.blur) * k;
  if (blur > 0.05) ctx.filter = `blur(${blur.toFixed(2)}px)`;
  const L = layoutText(ctx, clip, an.reveal);
  ctx.textBaseline = 'middle';
  if (clip.bgOpacity > 0 && L.maxW > 0) {
    ctx.fillStyle = rgba(clip.bgColor, clamp01(clip.bgOpacity));
    ctx.beginPath();
    ctx.roundRect(-L.maxW / 2 - L.padX, -L.totalH / 2 - L.padY, L.maxW + L.padX * 2, L.totalH + L.padY * 2, clip.fontSize * 0.18);
    ctx.fill();
  }
  ctx.textAlign = clip.align;
  const x = clip.align === 'left' ? -L.maxW / 2 : clip.align === 'right' ? L.maxW / 2 : 0;
  const top = -L.totalH / 2 + L.lineH / 2;
  const hasShadow = clip.shadowBlur > 0 || clip.shadowDistance > 0;
  const setShadow = (on: boolean) => {
    if (on && hasShadow) {
      // 影の大きさは変形の影響を受けないので、実際の画素に直す
      ctx.shadowColor = clip.shadowColor;
      ctx.shadowBlur = clip.shadowBlur * k * s;
      ctx.shadowOffsetX = clip.shadowDistance * k * s * 0.7;
      ctx.shadowOffsetY = clip.shadowDistance * k * s * 0.7;
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
  };
  let shadowUsed = false;
  if (clip.strokeWidth > 0) {
    setShadow(true);
    shadowUsed = true;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = clip.strokeColor;
    // 線は文字の輪郭の内外半分ずつに引かれるので2倍にする
    ctx.lineWidth = clip.strokeWidth * 2;
    L.lines.forEach((line, i) => ctx.strokeText(line, x, top + i * L.lineH));
  }
  setShadow(!shadowUsed);
  ctx.fillStyle = clip.color;
  L.lines.forEach((line, i) => ctx.fillText(line, x, top + i * L.lineH));
  ctx.restore();
}

function drawCover(ctx: Ctx, clip: MediaClip, src: VisualSource, W: number, H: number, blurPx: number): void {
  const scale = Math.max(W / src.width, H / src.height) * 1.08;
  const w = src.width * scale;
  const h = src.height * scale;
  ctx.save();
  // クリップの色の調整・フィルターも背景にそろえる
  const base = mediaFilterCss(clip, 0);
  ctx.filter = `${base === 'none' ? '' : base + ' '}blur(${blurPx.toFixed(1)}px) brightness(0.85)`;
  ctx.drawImage(src.image, (W - w) / 2, (H - h) / 2, w, h);
  ctx.restore();
}

/** 時間 t の画面を描く */
export function renderFrame(
  ctx: Ctx,
  project: Project,
  t: number,
  resolve: SourceResolver,
  k: number,
  onFontLoaded?: () => void,
): void {
  const { width: W, height: H, background } = project.settings;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = background.type === 'color' ? background.color : '#000000';
  ctx.fillRect(0, 0, W, H);
  if (background.type === 'blur') {
    // いちばん下の映像の段の絵をぼかして背景にする
    for (let i = project.tracks.length - 1; i >= 0; i--) {
      const track = project.tracks[i];
      if (track.kind !== 'video') continue;
      const first = trackLayersAt(project, track.id, t).find((l): l is { clip: Clip; fx: LayerFx } => 'clip' in l);
      if (first && first.clip.type === 'media') {
        const src = resolve(first.clip);
        if (src) drawCover(ctx, first.clip, src, W, H, background.amount * k);
        break;
      }
    }
  }
  // 下のトラックから順に重ねる
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i];
    if (track.kind === 'audio') continue;
    for (const layer of trackLayersAt(project, track.id, t)) {
      if ('fill' in layer) {
        ctx.globalAlpha = clamp01(layer.alpha);
        ctx.fillStyle = layer.fill;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        continue;
      }
      const c = layer.clip;
      if (c.type === 'media' && track.kind === 'video') {
        const src = resolve(c);
        if (src && src.width > 0 && src.height > 0) drawMedia(ctx, project, c, t, src, layer.fx, k);
      } else if (c.type === 'text') {
        drawText(ctx, project, c, t, layer.fx, k, onFontLoaded);
      }
    }
  }
  ctx.restore();
}

/** 回転した四角の中に点があるか */
export function pointInBox(b: Box, x: number, y: number): boolean {
  const r = (-b.rotation * Math.PI) / 180;
  const dx = x - b.cx;
  const dy = y - b.cy;
  const lx = dx * Math.cos(r) - dy * Math.sin(r);
  const ly = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(lx) <= Math.abs(b.w) / 2 && Math.abs(ly) <= Math.abs(b.h) / 2;
}
