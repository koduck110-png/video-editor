// 編集操作（すべて新しい Project を返す純粋な関数）
import {
  Asset,
  Clip,
  MediaClip,
  MIN_CLIP,
  Project,
  TextClip,
  Track,
  TrackKind,
  clipEnd,
  newId,
  snapToFrame,
  trackKindForAsset,
} from './types';

export type AssetLookup = (id: string) => Asset | undefined;

const EPS = 1e-6;

export function createEmptyProject(): Project {
  return {
    tracks: [
      { id: newId('track'), kind: 'text', name: '文字 1' },
      { id: newId('track'), kind: 'video', name: '映像 1' },
      { id: newId('track'), kind: 'audio', name: '音声 1' },
    ],
    clips: [],
  };
}

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
  if (!a || a.kind === 'image') return Infinity;
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
  const clip: MediaClip = {
    id: newId('clip'),
    type: 'media',
    trackId: track.id,
    assetId: asset.id,
    start,
    duration,
    inPoint: 0,
  };
  return { project: { ...project, clips: [...project.clips, clip] }, clip };
}

export const DEFAULT_TEXT: Omit<TextClip, 'id' | 'trackId' | 'start' | 'duration' | 'type'> = {
  text: '文字を入力',
  fontSize: 96,
  color: '#ffffff',
  bold: true,
  strokeColor: '#000000',
  strokeWidth: 8,
  x: 0.5,
  y: 0.82,
};

/** 文字を指定した時間に追加する。そこが埋まっていれば別の段（なければ新しい段）に置く */
export function addTextClip(p: Project, at: number): { project: Project; clip: TextClip } {
  const duration = 3;
  const start = snapToFrame(Math.max(0, at));
  const { project, track } = trackWithRoom(p, 'text', start, duration);
  const clip: TextClip = { id: newId('clip'), type: 'text', trackId: track.id, start, duration, ...DEFAULT_TEXT };
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
    lo = Math.max(lo, clip.start - clip.inPoint);
  }
  const hi = Math.max(clip.start, end - MIN_CLIP);
  const s = Math.min(Math.max(snapToFrame(newStart), lo), hi);
  const delta = s - clip.start;
  if (Math.abs(delta) < EPS) return p;
  const updated: Clip =
    clip.type === 'media'
      ? { ...clip, start: s, duration: end - s, inPoint: Math.max(0, clip.inPoint + delta) }
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
    if (src !== Infinity) hi = Math.min(hi, clip.start + (src - clip.inPoint));
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
  const left: Clip = { ...clip, duration: leftDur };
  const rightId = newId('clip');
  const right: Clip =
    clip.type === 'media'
      ? { ...clip, id: rightId, start: at, duration: clipEnd(clip) - at, inPoint: clip.inPoint + leftDur }
      : { ...clip, id: rightId, start: at, duration: clipEnd(clip) - at };
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

export function updateTextClip(p: Project, clipId: string, patch: Partial<TextClip>): Project {
  const clip = getClip(p, clipId);
  if (!clip || clip.type !== 'text') return p;
  return replaceClip(p, { ...clip, ...patch, id: clip.id, type: 'text' });
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
