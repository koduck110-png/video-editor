// 1枚の画面（フレーム）を描く処理。プレビューと書き出しの両方で同じものを使う。
import { activeClipOnTrack } from '../model/ops';
import { Clip, MediaClip, OUT_HEIGHT, OUT_WIDTH, Project, TextClip } from '../model/types';

export interface VisualSource {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** クリップの映像を返す関数（プレビューでは <video>、書き出しでは解析した画像） */
export type SourceResolver = (clip: MediaClip, t: number) => VisualSource | null;

export const FONT_STACK =
  "'Hiragino Kaku Gothic ProN','Hiragino Sans','Yu Gothic UI','Yu Gothic','Meiryo','Noto Sans JP','Noto Sans CJK JP',sans-serif";

/** 画面いっぱいに、縦横の比率を保って収める */
function drawContain(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, src: VisualSource): void {
  const scale = Math.min(OUT_WIDTH / src.width, OUT_HEIGHT / src.height);
  const w = src.width * scale;
  const h = src.height * scale;
  ctx.drawImage(src.image, (OUT_WIDTH - w) / 2, (OUT_HEIGHT - h) / 2, w, h);
}

export function textFont(clip: TextClip): string {
  return `${clip.bold ? 'bold ' : ''}${clip.fontSize}px ${FONT_STACK}`;
}

/** 文字の範囲（当たり判定用）。1920x1080 基準の座標 */
export function measureText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  clip: TextClip,
): { x: number; y: number; w: number; h: number } {
  ctx.save();
  ctx.font = textFont(clip);
  const lines = clip.text.split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  ctx.restore();
  const lineHeight = clip.fontSize * 1.25;
  const h = lineHeight * lines.length;
  w += clip.strokeWidth * 2;
  const cx = clip.x * OUT_WIDTH;
  const cy = clip.y * OUT_HEIGHT;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function drawText(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, clip: TextClip): void {
  if (!clip.text) return;
  ctx.save();
  ctx.font = textFont(clip);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const lines = clip.text.split('\n');
  const lineHeight = clip.fontSize * 1.25;
  const cx = clip.x * OUT_WIDTH;
  const cy = clip.y * OUT_HEIGHT;
  const top = cy - (lineHeight * (lines.length - 1)) / 2;
  lines.forEach((line, i) => {
    const y = top + i * lineHeight;
    if (clip.strokeWidth > 0) {
      ctx.strokeStyle = clip.strokeColor;
      // 線は文字の輪郭の内外半分ずつに引かれるので2倍にする
      ctx.lineWidth = clip.strokeWidth * 2;
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = clip.color;
    ctx.fillText(line, cx, y);
  });
  ctx.restore();
}

/**
 * 時間 t の画面を描く。ctx は 1920x1080 の座標で描けるように変換しておくこと。
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  project: Project,
  t: number,
  resolve: SourceResolver,
): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_WIDTH, OUT_HEIGHT);
  // 下のトラックから順に重ねる
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i];
    if (track.kind === 'audio') continue;
    const clip: Clip | undefined = activeClipOnTrack(project, track.id, t);
    if (!clip) continue;
    if (clip.type === 'media' && track.kind === 'video') {
      const src = resolve(clip, t);
      if (src && src.width > 0 && src.height > 0) drawContain(ctx, src);
    } else if (clip.type === 'text') {
      drawText(ctx, clip);
    }
  }
}

/** 時間 t に表示されている文字クリップ（上にあるものから順） */
export function visibleTextClips(project: Project, t: number): TextClip[] {
  const out: TextClip[] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'text') continue;
    const c = activeClipOnTrack(project, track.id, t);
    if (c && c.type === 'text') out.push(c);
  }
  return out;
}
