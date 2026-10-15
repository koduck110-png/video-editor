// 音の鳴らし方（音量・フェード・速度）。プレビューと書き出しで同じものを使う。
import { Asset, MediaClip, Project } from '../model/types';

/** 音を出すクリップか（映像トラックの動画・音声トラックの音） */
export function clipHasSound(project: Project, clip: MediaClip, asset: Asset | undefined): boolean {
  if (!asset?.audioBuffer || clip.volume <= 0) return false;
  const kind = project.tracks.find((t) => t.id === clip.trackId)?.kind;
  if (kind === 'audio') return true;
  return kind === 'video' && asset.kind === 'video' && !clip.audioDetached;
}

/** 時間 tt での音量（フェードを含む） */
function envelope(clip: MediaClip, tt: number): number {
  let v = clip.volume;
  const end = clip.start + clip.duration;
  if (clip.fadeIn > 0) v *= Math.min(1, Math.max(0, (tt - clip.start) / clip.fadeIn));
  if (clip.fadeOut > 0) v *= Math.min(1, Math.max(0, (end - tt) / clip.fadeOut));
  return v;
}

/**
 * クリップの音を予約する。タイムラインの時間 t0 が、ctx の時間 when にあたる。
 * 返り値は止めるときに使う（予約しなかったら null）
 */
export function scheduleClipAudio(
  ctx: BaseAudioContext,
  dest: AudioNode,
  clip: MediaClip,
  buf: AudioBuffer,
  t0: number,
  when: number,
): AudioBufferSourceNode | null {
  const end = clip.start + clip.duration;
  if (end <= t0 + 1e-6) return null;
  const startT = Math.max(t0, clip.start);
  const offset = clip.inPoint + (startT - clip.start) * clip.speed;
  if (offset >= buf.duration) return null;
  const at = (tt: number) => when + (tt - t0);
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.playbackRate.value = clip.speed;
  const gain = ctx.createGain();
  node.connect(gain);
  gain.connect(dest);
  // 音量の変化（フェード）を折れ線で予約する
  const points = [startT, clip.start + clip.fadeIn, end - clip.fadeOut, end]
    .filter((p) => p >= startT - 1e-6 && p <= end + 1e-6)
    .sort((a, b) => a - b);
  gain.gain.setValueAtTime(envelope(clip, startT), at(startT));
  for (const p of points.slice(1)) gain.gain.linearRampToValueAtTime(envelope(clip, p), at(p));
  node.start(at(startT), offset);
  node.stop(at(end));
  node.onended = () => {
    node.disconnect();
    gain.disconnect();
  };
  return node;
}
