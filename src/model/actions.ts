// 画面のボタンやキー操作から呼ばれる編集操作
import { TextStyle, createEmptyProject } from './defaults';
import {
  addAssetClip,
  addTextClip,
  addTrack,
  adjacentNext,
  adjacentPrev,
  clipsAt,
  deleteClip,
  detachAudio,
  duplicateClip,
  getClip,
  pasteClip,
  removeTrack,
  setTransition,
  splitClip,
  trackKindOfClip,
  updateMediaClip,
} from './ops';
import {
  commit,
  removeAsset,
  resetEditor,
  selectClip,
  selectTransition,
  setCurrentTime,
  showToast,
  useEditor,
} from './store';
import { Asset, Clip, TrackKind, TransitionType, clipEnd, projectDuration, snapToFrame } from './types';
import { deleteAssetRecord } from '../persist/db';
import { clearSession } from '../persist/autosave';

export function addAssetToTimeline(asset: Asset, opts: { trackId?: string; at?: number } = {}): void {
  if (asset.status !== 'ready') {
    showToast('まだ読み込み中です。少し待ってからもう一度お試しください');
    return;
  }
  // 音楽の「＋追加」は再生位置（白い線）に置く。白い線がいちばん最後にあるときは先頭に置く
  if (asset.kind === 'audio' && opts.at === undefined) {
    const s = useEditor.getState();
    const end = projectDuration(s.project);
    opts = { ...opts, at: s.currentTime >= end - 1e-3 ? 0 : s.currentTime };
  }
  let newId: string | null = null;
  commit((p) => {
    const r = addAssetClip(p, asset, opts);
    newId = r.clip.id;
    return r.project;
  });
  if (newId) selectClip(newId);
}

export function addText(style: Partial<TextStyle> = {}): void {
  const t = useEditor.getState().currentTime;
  let newId: string | null = null;
  commit((p) => {
    const r = addTextClip(p, t, style);
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

/** 再生位置で分割する。選んでいるクリップがあればそれだけを、なければ再生位置にあるクリップすべてを分ける */
export function splitAtPlayhead(): void {
  const s = useEditor.getState();
  const t = snapToFrame(s.currentTime);
  const sel = s.selectedClipId ? getClip(s.project, s.selectedClipId) : undefined;
  if (sel && !(sel.start < t && clipEnd(sel) > t)) {
    showToast('選んでいるクリップの上に再生位置（白い線）を合わせてから分割してください');
    return;
  }
  const targets = sel ? [sel] : clipsAt(s.project, t);
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
  if (s.selectedTransitionClipId) {
    const id = s.selectedTransitionClipId;
    commit((p) => setTransition(p, id, null));
    selectTransition(null);
    return;
  }
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

// ---------- コピー・貼り付け・複製 ----------

let clipboard: { clip: Clip; kind: TrackKind } | null = null;

export function copySelected(): void {
  const s = useEditor.getState();
  const clip = s.selectedClipId ? getClip(s.project, s.selectedClipId) : undefined;
  const kind = clip && trackKindOfClip(s.project, clip);
  if (!clip || !kind) return;
  clipboard = { clip: structuredClone(clip), kind };
  showToast('コピーしました（Ctrl+V で白い線の位置に貼り付け）');
}

export function hasClipboard(): boolean {
  return !!clipboard;
}

export function pasteAtPlayhead(): void {
  if (!clipboard) return;
  const cb = clipboard;
  if (cb.clip.type === 'media' && !useEditor.getState().assets[cb.clip.assetId]) {
    showToast('元の素材がないため貼り付けできません');
    return;
  }
  let newId: string | null = null;
  commit((p) => {
    const r = pasteClip(p, cb.clip, cb.kind, useEditor.getState().currentTime);
    newId = r.clip.id;
    return r.project;
  });
  if (newId) selectClip(newId);
}

export function duplicateSelected(): void {
  const id = useEditor.getState().selectedClipId;
  if (!id) return;
  let newId: string | null = null;
  commit((p) => {
    const r = duplicateClip(p, id);
    newId = r.clip?.id ?? null;
    return r.project;
  });
  if (newId) selectClip(newId);
}

/** 動画の音声を別の音声クリップに分ける */
export function detachSelectedAudio(): void {
  const s = useEditor.getState();
  const clip = s.selectedClipId ? getClip(s.project, s.selectedClipId) : undefined;
  if (!clip || clip.type !== 'media') return;
  const asset = s.assets[clip.assetId];
  if (asset?.kind !== 'video' || trackKindOfClip(s.project, clip) !== 'video') return;
  if (asset.hasAudio === false) {
    showToast('この動画には音声が入っていません');
    return;
  }
  commit((p) => detachAudio(p, clip.id).project);
  showToast('音声を下の音声トラックに分けました');
}

// ---------- 切り替え効果・フィルター ----------

/**
 * 切り替え効果を付ける。つなぎ目を選んでいればそこに、
 * クリップを選んでいればそのクリップの前（なければ後ろ）のつなぎ目に付ける。
 */
export function applyTransition(type: TransitionType): void {
  const s = useEditor.getState();
  let targetId = s.selectedTransitionClipId;
  if (!targetId && s.selectedClipId) {
    const clip = getClip(s.project, s.selectedClipId);
    if (clip) {
      if (adjacentPrev(s.project, clip)) targetId = clip.id;
      else targetId = adjacentNext(s.project, clip)?.id ?? null;
    }
  }
  if (!targetId) {
    showToast('2つのクリップをすき間なく並べ、つなぎ目の「⇄」かクリップを選んでから使ってください');
    return;
  }
  const id = targetId;
  const prevDur = getClip(s.project, id)?.transitionIn?.duration;
  commit((p) => setTransition(p, id, { type, duration: prevDur ?? 0.8 }));
  selectTransition(id);
}

export function applyFilter(filterId: string): void {
  const s = useEditor.getState();
  const clip = s.selectedClipId ? getClip(s.project, s.selectedClipId) : undefined;
  if (!clip || clip.type !== 'media' || trackKindOfClip(s.project, clip) !== 'video') {
    showToast('フィルターをかける映像（動画・画像）のクリップを選んでください');
    return;
  }
  commit((p) => updateMediaClip(p, clip.id, { filter: { id: filterId, intensity: clip.filter.intensity || 1 } }));
}

// ---------- 素材・プロジェクト ----------

export function deleteAsset(asset: Asset): void {
  if (!removeAsset(asset.id)) {
    showToast('タイムラインで使っている素材は削除できません。先にクリップを削除してください');
    return;
  }
  deleteAssetRecord(asset.id).catch(() => {});
}

export async function newProject(): Promise<void> {
  const s = useEditor.getState();
  if (s.project.clips.length > 0 || s.assetOrder.length > 0) {
    const ok = window.confirm('今の作業を消して、新しいプロジェクトを始めますか？（元に戻せません）');
    if (!ok) return;
  }
  await clearSession().catch(() => {});
  resetEditor(createEmptyProject(s.project.settings.ratio));
}
