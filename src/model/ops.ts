// 編集操作（すべて新しい Project を返す純粋な関数）
import { createMediaClip, createTextClip, settingsForRatio, TextStyle } from './defaults';
import {
  Asset,
  Clip,
  MediaClip,
  MIN_CLIP,
  Project,
  RatioId,
  TextClip,
  Track,
  TrackKind,
  Transition,
  clipEnd,
  newId,
  snapToFrame,
  trackKindForAsset,
} from './types';

export { createEmptyProject } from './defaults';

export type AssetLookup = (id: string) => Asset | undefined;

const EPS = 1e-6;
/** すき間なく並んでいるとみなす差（秒） */
export const ADJ_EPS = 1e-3;

export function clipsOnTrack(p: Project, trackId: string, excludeId?: string): Clip[] {
  return p.clips
    .filter((c) => c.trackId === trackId && c.id !== excludeId)
    .sort((a, b) => a.start - b.start);
}

export function getTrack(p: Project, trackId: string): Track | undefined {
  return p.tracks.find((t) => t.id === trackId);
}

export function getClip(p: Project, clipId: string): Clip | undefined {
  return p.clips.find((c) => c.id === clipId);
}

export function trackKindOfClip(p: Project, clip: Clip): TrackKind | undefined {
  return getTrack(p, clip.trackId)?.kind;
}

export function trackEnd(p: Project, trackId: string): number {
  let end = 0;
  for (const c of p.clips) if (c.trackId === trackId) end = Math.max(end, clipEnd(c));
  return end;
}

/**
 * 他のクリップと重ならない、希望の位置にいちばん近い開始位置を探す。
 */
export function findFreeStart(others: Clip[], desired: number, duration: number): number {
  const sorted = [...others].sort((a, b) => a.start - b.start);
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.start > cursor + EPS) gaps.push([cursor, c.start]);
    cursor = Math.max(cursor, clipEnd(c));
  }
  gaps.push([cursor, Infinity]);
  let best = cursor;
  let bestDist = Infinity;
  for (const [a, b] of gaps) {
    if (b - a + EPS < duration) continue;
    // フレームにそろえてから隙間に収める（収めた後は丸めない＝重ならない）
    const cand = Math.min(Math.max(snapToFrame(desired), a), b - duration);
    const dist = Math.abs(cand - desired);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  return Math.max(0, best);
}

function replaceClip(p: Project, clip: Clip): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === clip.id ? clip : c)) };
}

/** 素材の長さの上限（画像は無制限） */
export function sourceDuration(clip: Clip, assets: AssetLookup): number {
  if (clip.type !== 'media') return Infinity;
  const a = assets(clip.assetId);
  if (a?.kind === 'image') return Infinity;
  // 読み込み中・見つからない素材は、今使っている範囲より長くできない
  if (!a || a.status !== 'ready') return clip.inPoint + clip.duration * clip.speed;
  return a.duration;
}

export function firstTrackOfKind(p: Project, kind: TrackKind): Track | undefined {
  return p.tracks.find((t) => t.kind === kind);
}

/**
 * 指定した種類のトラックを追加する。
 * 映像・文字は同じ種類のいちばん上（手前に表示される）、音声はいちばん下に入れる。
 */
export function addTrack(p: Project, kind: TrackKind): { project: Project; track: Track } {
  const label = kind === 'video' ? '映像' : kind === 'text' ? '文字' : '音声';
  let maxNo = 0;
  for (const t of p.tracks) {
    if (t.kind !== kind) continue;
    const m = t.name.match(/(\d+)$/);
    maxNo = Math.max(maxNo, m ? Number(m[1]) : 1);
  }
  const track: Track = { id: newId('track'), kind, name: `${label} ${maxNo + 1}` };
  const tracks = [...p.tracks];
  const firstIdx = tracks.findIndex((t) => t.kind === kind);
  if (firstIdx >= 0 && kind === 'audio') {
    let lastIdx = firstIdx;
    tracks.forEach((t, i) => {
      if (t.kind === kind) lastIdx = i;
    });
    tracks.splice(lastIdx + 1, 0, track);
  } else if (firstIdx >= 0) {
    tracks.splice(firstIdx, 0, track);
  } else {
    // 種類ごとの並び: 文字 → 映像 → 音声
    const order: TrackKind[] = ['text', 'video', 'audio'];
    const myOrder = order.indexOf(kind);
    let insertAt = tracks.length;
    for (let i = 0; i < tracks.length; i++) {
      if (order.indexOf(tracks[i].kind) > myOrder) {
        insertAt = i;
        break;
      }
    }
    tracks.splice(insertAt, 0, track);
  }
  return { project: { ...p, tracks }, track };
}

export function removeTrack(p: Project, trackId: string): Project {
  return {
    ...p,
    tracks: p.tracks.filter((t) => t.id !== trackId),
    clips: p.clips.filter((c) => c.trackId !== trackId),
  };
}

const DEFAULT_IMAGE_DURATION = 5;

/** そのトラックの start〜start+duration が空いているか */
export function isRangeFree(p: Project, trackId: string, start: number, duration: number, excludeId?: string): boolean {
  return clipsOnTrack(p, trackId, excludeId).every(
    (c) => clipEnd(c) <= start + EPS || c.start >= start + duration - EPS,
  );
}

/**
 * 指定した時間が空いている同じ種類のトラックを探す（preferredId を優先）。
 * どこも埋まっていれば、新しいトラックを作る。
 */
export function trackWithRoom(
  p: Project,
  kind: TrackKind,
  start: number,
  duration: number,
  preferredId?: string,
): { project: Project; track: Track } {
  const sameKind = p.tracks.filter((t) => t.kind === kind);
  const preferred = sameKind.find((t) => t.id === preferredId);
  const ordered = preferred ? [preferred, ...sameKind.filter((t) => t !== preferred)] : sameKind;
  for (const t of ordered) {
    if (isRangeFree(p, t.id, start, duration)) return { project: p, track: t };
  }
  return addTrack(p, kind);
}

/**
 * 素材をタイムラインに追加する。
 * - at を指定: その時間に置く。そこが埋まっていれば別の段（なければ新しい段）に置く
 * - at を省略: 動画・画像はいちばん下の映像トラックの最後につなげる
 */
export function addAssetClip(
  p: Project,
  asset: Asset,
  opts: { trackId?: string; at?: number } = {},
): { project: Project; clip: MediaClip } {
  const kind = trackKindForAsset(asset.kind);
  const duration = asset.kind === 'image' ? DEFAULT_IMAGE_DURATION : Math.max(MIN_CLIP, asset.duration);
  let project = p;
  let track: Track;
  let start: number;
  if (opts.at === undefined) {
    const sameKind = p.tracks.filter((t) => t.kind === kind);
    let main = sameKind[sameKind.length - 1];
    if (!main) {
      const r = addTrack(p, kind);
      project = r.project;
      main = r.track;
    }
    track = main;
    start = findFreeStart(clipsOnTrack(project, track.id), trackEnd(project, track.id), duration);
  } else {
    start = snapToFrame(Math.max(0, opts.at));
    const r = trackWithRoom(p, kind, start, duration, opts.trackId);
    project = r.project;
    track = r.track;
  }
  const clip = createMediaClip({ trackId: track.id, assetId: asset.id, start, duration });
  return { project: { ...project, clips: [...project.clips, clip] }, clip };
}

/** 文字を指定した時間に追加する。そこが埋まっていれば別の段（なければ新しい段）に置く */
export function addTextClip(
  p: Project,
  at: number,
  style: Partial<TextStyle> = {},
): { project: Project; clip: TextClip } {
  const duration = 3;
  const start = snapToFrame(Math.max(0, at));
  const { project, track } = trackWithRoom(p, 'text', start, duration);
  const clip = createTextClip({ trackId: track.id, start, duration, ...style });
  return { project: { ...project, clips: [...project.clips, clip] }, clip };
}

/** クリップを動かす（別のトラックへも）。重なる場合は近くの空いている場所に置く */
export function moveClip(p: Project, clipId: string, trackId: string, desiredStart: number): Project {
  const clip = getClip(p, clipId);
  const track = getTrack(p, trackId);
  if (!clip || !track) return p;
  const curTrack = getTrack(p, clip.trackId);
  if (!curTrack || curTrack.kind !== track.kind) trackId = clip.trackId;
  const start = findFreeStart(clipsOnTrack(p, trackId, clipId), Math.max(0, desiredStart), clip.duration);
  if (start === clip.start && trackId === clip.trackId) return p;
  return replaceClip(p, { ...clip, trackId, start });
}

/** 左端をつまんで動かす */
export function trimClipStart(p: Project, clipId: string, newStart: number, assets: AssetLookup): Project {
  const clip = getClip(p, clipId);
  if (!clip) return p;
  const end = clipEnd(clip);
  // 前のクリップ＝開始位置が自分より前のもの
  const prev = clipsOnTrack(p, clip.trackId, clip.id).filter((c) => c.start < clip.start - EPS);
  const prevEnd = prev.length ? Math.max(...prev.map(clipEnd)) : 0;
  let lo = Math.min(prevEnd, clip.start);
  if (clip.type === 'media' && sourceDuration(clip, assets) !== Infinity) {
    lo = Math.max(lo, clip.start - clip.inPoint / clip.speed);
  }
  const hi = Math.max(clip.start, end - MIN_CLIP);
  const s = Math.min(Math.max(snapToFrame(newStart), lo), hi);
  const delta = s - clip.start;
  if (Math.abs(delta) < EPS) return p;
  const updated: Clip =
    clip.type === 'media'
      ? { ...clip, start: s, duration: end - s, inPoint: Math.max(0, clip.inPoint + delta * clip.speed) }
      : { ...clip, start: s, duration: end - s };
  return replaceClip(p, updated);
}

/** 右端をつまんで動かす */
export function trimClipEnd(p: Project, clipId: string, newEnd: number, assets: AssetLookup): Project {
  const clip = getClip(p, clipId);
  if (!clip) return p;
  // 次のクリップ＝開始位置が自分より後のもの
  const next = clipsOnTrack(p, clip.trackId, clip.id).filter((c) => c.start > clip.start + EPS);
  const nextStart = next.length ? Math.min(...next.map((c) => c.start)) : Infinity;
  let hi = Math.max(nextStart, clipEnd(clip));
  if (clip.type === 'media') {
    const src = sourceDuration(clip, assets);
    if (src !== Infinity) hi = Math.min(hi, clip.start + (src - clip.inPoint) / clip.speed);
  }
  const lo = Math.min(hi, clip.start + MIN_CLIP);
  const e = Math.min(Math.max(snapToFrame(newEnd), lo), hi);
  const duration = e - clip.start;
  if (Math.abs(duration - clip.duration) < EPS) return p;
  return replaceClip(p, { ...clip, duration });
}

/** 指定した時間でクリップを2つに分ける */
export function splitClip(p: Project, clipId: string, t: number): { project: Project; rightId?: string } {
  const clip = getClip(p, clipId);
  if (!clip) return { project: p };
  const at = snapToFrame(t);
  if (at <= clip.start + MIN_CLIP / 2 || at >= clipEnd(clip) - MIN_CLIP / 2) return { project: p };
  const leftDur = at - clip.start;
  const rightId = newId('clip');
  let left: Clip;
  let right: Clip;
  if (clip.type === 'media') {
    // 入りの効果は前半、出の効果は後半に残す
    left = { ...clip, duration: leftDur, animOut: null, fadeOut: 0 };
    right = {
      ...clip,
      id: rightId,
      start: at,
      duration: clipEnd(clip) - at,
      inPoint: clip.inPoint + leftDur * clip.speed,
      animIn: null,
      fadeIn: 0,
      transitionIn: null,
    };
  } else {
    left = { ...clip, duration: leftDur, animOut: null };
    right = { ...clip, id: rightId, start: at, duration: clipEnd(clip) - at, animIn: null, transitionIn: null };
  }
  const clips: Clip[] = [];
  for (const c of p.clips) {
    if (c.id === clip.id) clips.push(left, right);
    else clips.push(c);
  }
  return { project: { ...p, clips }, rightId };
}

export function clipsAt(p: Project, t: number): Clip[] {
  return p.clips.filter((c) => c.start <= t + EPS && clipEnd(c) > t + EPS);
}

export function deleteClip(p: Project, clipId: string): Project {
  return { ...p, clips: p.clips.filter((c) => c.id !== clipId) };
}

/** 文字クリップの設定を変える */
export function updateTextClip(p: Project, clipId: string, patch: Partial<TextClip>): Project {
  const clip = getClip(p, clipId);
  if (!clip || clip.type !== 'text') return p;
  return replaceClip(p, { ...clip, ...patch, id: clip.id, type: 'text' });
}

/** 動画・画像・音楽クリップの設定を変える（速度・長さ・位置以外） */
export function updateMediaClip(p: Project, clipId: string, patch: Partial<MediaClip>): Project {
  const clip = getClip(p, clipId);
  if (!clip || clip.type !== 'media') return p;
  return replaceClip(p, { ...clip, ...patch, id: clip.id, type: 'media' });
}

/** どの種類のクリップにも共通する設定（位置・アニメーションなど）を変える */
export function updateClipCommon(
  p: Project,
  clipId: string,
  patch: Partial<Pick<Clip, 'transform' | 'animIn' | 'animOut' | 'transitionIn'>>,
): Project {
  const clip = getClip(p, clipId);
  if (!clip) return p;
  return replaceClip(p, { ...clip, ...patch } as Clip);
}

/**
 * 速度を変える。使う素材の範囲はそのままで長さが変わり、
 * 同じ段の後ろのクリップは同じだけずらす。
 */
export function setClipSpeed(p: Project, clipId: string, speed: number): Project {
  const clip = getClip(p, clipId);
  if (!clip || clip.type !== 'media') return p;
  const s = Math.min(10, Math.max(0.1, speed));
  const newDur = Math.max(MIN_CLIP, (clip.duration * clip.speed) / s);
  const delta = newDur - clip.duration;
  const oldEnd = clipEnd(clip);
  const clips = p.clips.map((c) => {
    if (c.id === clip.id) return { ...clip, speed: s, duration: newDur };
    if (c.trackId === clip.trackId && c.start >= oldEnd - ADJ_EPS) return { ...c, start: Math.max(0, c.start + delta) };
    return c;
  });
  return { ...p, clips };
}

/** 同じ段で、このクリップのすぐ前にすき間なく並んでいるクリップ */
export function adjacentPrev(p: Project, clip: Clip): Clip | undefined {
  return p.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < ADJ_EPS);
}

/** 同じ段で、このクリップのすぐ後ろにすき間なく並んでいるクリップ */
export function adjacentNext(p: Project, clip: Clip): Clip | undefined {
  return p.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(c.start - clipEnd(clip)) < ADJ_EPS);
}

/** 実際に効く切り替え効果（長さは前後のクリップに収まるように縮める） */
export function effectiveTransition(p: Project, clip: Clip): { prev: Clip; transition: Transition } | null {
  if (!clip.transitionIn) return null;
  const prev = adjacentPrev(p, clip);
  if (!prev) return null;
  const d = Math.min(clip.transitionIn.duration, prev.duration, clip.duration);
  if (d <= MIN_CLIP / 2) return null;
  return { prev, transition: { ...clip.transitionIn, duration: d } };
}

/** 切り替え効果を考えた、そのクリップが画面に出ている時間 */
export function clipVisibleRange(p: Project, clip: Clip): [number, number] {
  let from = clip.start;
  let to = clipEnd(clip);
  const tin = effectiveTransition(p, clip);
  if (tin) from -= tin.transition.duration / 2;
  const next = adjacentNext(p, clip);
  if (next) {
    const tout = effectiveTransition(p, next);
    // 切り替えの範囲は後ろのクリップの開始位置が基準
    if (tout) to = Math.max(to, next.start + tout.transition.duration / 2);
  }
  return [from, to];
}

export function setTransition(p: Project, clipId: string, transition: Transition | null): Project {
  return updateClipCommon(p, clipId, { transitionIn: transition });
}

/** 複製: すぐ後ろ（埋まっていれば別の段）に同じクリップを作る */
export function duplicateClip(p: Project, clipId: string): { project: Project; clip?: Clip } {
  const clip = getClip(p, clipId);
  const kind = clip && trackKindOfClip(p, clip);
  if (!clip || !kind) return { project: p };
  const start = clipEnd(clip);
  const { project, track } = trackWithRoom(p, kind, start, clip.duration, clip.trackId);
  const copy = { ...structuredClone(clip), id: newId('clip'), trackId: track.id, start, transitionIn: null } as Clip;
  return { project: { ...project, clips: [...project.clips, copy] }, clip: copy };
}

/** コピーしたクリップを時間 at に貼り付ける */
export function pasteClip(p: Project, src: Clip, kind: TrackKind, at: number): { project: Project; clip: Clip } {
  const start = snapToFrame(Math.max(0, at));
  const { project, track } = trackWithRoom(p, kind, start, src.duration, src.trackId);
  const copy = { ...structuredClone(src), id: newId('clip'), trackId: track.id, start, transitionIn: null } as Clip;
  return { project: { ...project, clips: [...project.clips, copy] }, clip: copy };
}

/** 動画の音声を音声トラックの別クリップに分ける */
export function detachAudio(p: Project, clipId: string): { project: Project; clip?: MediaClip } {
  const clip = getClip(p, clipId);
  if (!clip || clip.type !== 'media' || clip.audioDetached) return { project: p };
  const { project, track } = trackWithRoom(p, 'audio', clip.start, clip.duration);
  const audio = createMediaClip({
    trackId: track.id,
    assetId: clip.assetId,
    start: clip.start,
    duration: clip.duration,
    inPoint: clip.inPoint,
    speed: clip.speed,
    volume: clip.volume,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
  });
  const clips = project.clips.map((c) => (c.id === clip.id ? { ...clip, audioDetached: true } : c));
  return { project: { ...project, clips: [...clips, audio] }, clip: audio };
}

/** 画面比率を変える */
export function setRatio(p: Project, ratio: RatioId): Project {
  return { ...p, settings: settingsForRatio(ratio, p.settings) };
}

/** 時間 t でそのトラックに表示されているクリップ */
export function activeClipOnTrack(p: Project, trackId: string, t: number): Clip | undefined {
  let found: Clip | undefined;
  for (const c of p.clips) {
    if (c.trackId !== trackId) continue;
    if (c.start <= t + EPS && t < clipEnd(c) - EPS) {
      if (!found || c.start > found.start) found = c;
    }
  }
  return found;
}
