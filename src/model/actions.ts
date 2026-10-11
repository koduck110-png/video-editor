// 画面のボタンやキー操作から呼ばれる編集操作
import {
  addAssetClip,
  addTextClip,
  addTrack,
  clipsAt,
  deleteClip,
  getClip,
  removeTrack,
  splitClip,
} from './ops';
import { commit, getAsset, selectClip, setCurrentTime, showToast, useEditor } from './store';
import { Asset, TrackKind, clipEnd, snapToFrame } from './types';

export function addAssetToTimeline(asset: Asset, opts: { trackId?: string; at?: number } = {}): void {
  if (asset.status !== 'ready') {
    showToast('まだ読み込み中です。少し待ってからもう一度お試しください');
    return;
  }
  let newId: string | null = null;
  commit((p) => {
    const r = addAssetClip(p, asset, opts);
    newId = r.clip.id;
    return r.project;
  });
  if (newId) selectClip(newId);
}

export function addText(): void {
  const t = useEditor.getState().currentTime;
  let newId: string | null = null;
  commit((p) => {
    const r = addTextClip(p, t);
    newId = r.clip.id;
    return r.project;
  });
  if (newId) {
    selectClip(newId);
    const clip = getClip(useEditor.getState().project, newId);
    // 追加した文字が見えるように再生位置を合わせる
    if (clip && (t < clip.start || t >= clipEnd(clip))) setCurrentTime(clip.start);
  }
}

/** 再生位置で分割する。選んでいるクリップがあればそれを、なければ再生位置にあるクリップすべてを分ける */
export function splitAtPlayhead(): void {
  const s = useEditor.getState();
  const t = snapToFrame(s.currentTime);
  const sel = s.selectedClipId ? getClip(s.project, s.selectedClipId) : undefined;
  const targets = sel && sel.start < t && clipEnd(sel) > t ? [sel] : clipsAt(s.project, t);
  if (targets.length === 0) {
    showToast('再生位置（白い線）をクリップの上に合わせてから分割してください');
    return;
  }
  let changed = false;
  commit((p) => {
    let proj = p;
    for (const c of targets) {
      const r = splitClip(proj, c.id, t);
      if (r.project !== proj) changed = true;
      proj = r.project;
    }
    return proj;
  });
  if (!changed) showToast('クリップの端では分割できません');
}

export function deleteSelected(): void {
  const s = useEditor.getState();
  if (!s.selectedClipId) return;
  const id = s.selectedClipId;
  commit((p) => deleteClip(p, id));
  selectClip(null);
}

export function addNewTrack(kind: TrackKind): void {
  commit((p) => addTrack(p, kind).project);
}

export function deleteTrack(trackId: string): void {
  const s = useEditor.getState();
  const track = s.project.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const sameKind = s.project.tracks.filter((t) => t.kind === track.kind);
  if (sameKind.length <= 1) {
    showToast('この種類のトラックは最低1つ必要です');
    return;
  }
  commit((p) => removeTrack(p, trackId));
  if (s.selectedClipId && !useEditor.getState().project.clips.some((c) => c.id === s.selectedClipId)) selectClip(null);
}

export function assetForClip(assetId: string): Asset | undefined {
  return getAsset(assetId);
}
