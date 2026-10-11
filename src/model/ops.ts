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
    const cand = Math.min(Math.max(desired, a), b - duration);
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

/** 指定した種類のトラックを追加する。同じ種類のトラックのいちばん上に入れる */
export function addTrack(p: Project, kind: TrackKind): { project: Project; track: Track } {
  const count = p.tracks.filter((t) => t.kind === kind).length;
  const label = kind === 'video' ? '映像' : kind === 'text' ? '文字' : '音声';
  const track: Track = { id: newId('track'), kind, name: `${label} ${count + 1}` };
  const tracks = [...p.tracks];
  const firstIdx = tracks.findIndex((t) => t.kind === kind);
  if (firstIdx >= 0) {
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

/**
 * 素材をタイムラインに追加する。
 * trackId / at を省略すると、合うトラックの最後に追加する。
 */
export function addAssetClip(
  p: Project,
  asset: Asset,
  opts: { trackId?: string; at?: number } = {},
): { project: Project; clip: MediaClip } {
  const kind = trackKindForAsset(asset.kind);
  let project = p;
  let track = opts.trackId ? getTrack(p, opts.trackId) : undefined;
  if (!track || track.kind !== kind) track = firstTrackOfKind(p, kind);
  if (!track) {
    const r = addTrack(p, kind);
    project = r.project;
    track = r.track;
  }
  const duration = asset.kind === 'image' ? DEFAULT_IMAGE_DURATION : Math.max(MIN_CLIP, asset.duration);
  const desired = opts.at ?? trackEnd(project, track.id);
  const start = snapToFrame(findFreeStart(clipsOnTrack(project, track.id), Math.max(0, desired), duration));
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

export function addTextClip(p: Project, at: number): { project: Project; clip: TextClip } {
  let project = p;
  let track = firstTrackOfKind(p, 'text');
  if (!track) {
    const r = addTrack(p, 'text');
    project = r.project;
    track = r.track;
  }
  const duration = 3;
  const start = snapToFrame(findFreeStart(clipsOnTrack(project, track.id), Math.max(0, at), duration));
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
  const start = snapToFrame(findFreeStart(clipsOnTrack(p, trackId, clipId), Math.max(0, desiredStart), clip.duration));
  if (start === clip.start && trackId === clip.trackId) return p;
  return replaceClip(p, { ...clip, trackId, start });
}

/** 左端をつまんで動かす */
export function trimClipStart(p: Project, clipId: string, newStart: number, assets: AssetLookup): Project {
  const clip = getClip(p, clipId);
  if (!clip) return p;
  const end = clipEnd(clip);
  const prev = clipsOnTrack(p, clip.trackId, clip.id).filter((c) => clipEnd(c) <= clip.start + EPS);
  const prevEnd = prev.length ? Math.max(...prev.map(clipEnd)) : 0;
  let lo = prevEnd;
  if (clip.type === 'media' && sourceDuration(clip, assets) !== Infinity) {
    lo = Math.max(lo, clip.start - clip.inPoint);
  }
  const hi = end - MIN_CLIP;
  let s = snapToFrame(Math.min(Math.max(newStart, lo), hi));
  if (s < lo - EPS) s = lo;
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
  const next = clipsOnTrack(p, clip.trackId, clip.id).filter((c) => c.start >= clipEnd(clip) - EPS);
  const nextStart = next.length ? Math.min(...next.map((c) => c.start)) : Infinity;
  let hi = nextStart;
  if (clip.type === 'media') {
    const src = sourceDuration(clip, assets);
    if (src !== Infinity) hi = Math.min(hi, clip.start + (src - clip.inPoint));
  }
  const lo = clip.start + MIN_CLIP;
  let e = Math.min(Math.max(newEnd, lo), hi);
  const snapped = snapToFrame(e);
  // フレームにそろえて上限を超える場合は上限のまま
  e = snapped <= hi + EPS ? snapped : e;
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
