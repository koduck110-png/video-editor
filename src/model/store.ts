// アプリ全体の状態。project の変更は履歴に残り、元に戻す・やり直しができる。
import { create } from 'zustand';
import { Asset, Project, projectDuration } from './types';
import { createEmptyProject } from './ops';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 1000;

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

interface EditorState {
  project: Project;
  past: Project[];
  future: Project[];
  /** ドラッグ中など、まとめて1回の履歴にしたい操作の開始時点 */
  gestureBase: Project | null;
  lastCoalesce: { key: string; time: number } | null;

  selectedClipId: string | null;
  currentTime: number;
  playing: boolean;
  /** タイムラインの拡大率（1秒あたりのピクセル数） */
  zoom: number;

  assets: Record<string, Asset>;
  assetOrder: string[];

  toasts: Toast[];
  /** 自動保存の状態 */
  saveState: 'saved' | 'saving' | 'error';
  /** 切り替え効果を選んでいるとき、その効果が付いている（後ろ側の）クリップ */
  selectedTransitionClipId: string | null;
}

export const useEditor = create<EditorState>(() => ({
  project: createEmptyProject(),
  past: [],
  future: [],
  gestureBase: null,
  lastCoalesce: null,
  selectedClipId: null,
  currentTime: 0,
  playing: false,
  zoom: 60,
  assets: {},
  assetOrder: [],
  toasts: [],
  saveState: 'saved',
  selectedTransitionClipId: null,
}));

const get = useEditor.getState;
const set = useEditor.setState;

/**
 * 編集操作を記録して反映する。
 * coalesceKey が同じ操作が続けて行われた場合（文字の入力など）は1回分の履歴にまとめる。
 */
export function commit(updater: (p: Project) => Project, coalesceKey?: string): void {
  const s = get();
  const next = updater(s.project);
  if (next === s.project) return;
  if (s.gestureBase) {
    set({ project: next });
    return;
  }
  const now = performance.now();
  if (coalesceKey && s.lastCoalesce && s.lastCoalesce.key === coalesceKey && now - s.lastCoalesce.time < COALESCE_MS) {
    set({ project: next, future: [], lastCoalesce: { key: coalesceKey, time: now } });
    return;
  }
  const past = [...s.past, s.project];
  if (past.length > HISTORY_LIMIT) past.shift();
  set({
    project: next,
    past,
    future: [],
    lastCoalesce: coalesceKey ? { key: coalesceKey, time: now } : null,
  });
}

/** ドラッグなどの開始。終わるまでの変更は1回の履歴になる */
export function beginGesture(): void {
  const s = get();
  if (!s.gestureBase) set({ gestureBase: s.project });
}

export function endGesture(): void {
  const s = get();
  const base = s.gestureBase;
  if (!base) return;
  if (base === s.project) {
    set({ gestureBase: null });
    return;
  }
  const past = [...s.past, base];
  if (past.length > HISTORY_LIMIT) past.shift();
  set({ gestureBase: null, past, future: [], lastCoalesce: null });
}

/** ドラッグを取り消して元の状態に戻す */
export function cancelGesture(): void {
  const s = get();
  if (!s.gestureBase) return;
  set({ project: s.gestureBase, gestureBase: null });
}

function fixSelection(p: Project, sel: string | null): string | null {
  // 元に戻したときに、なくなったクリップを選んだままにしない
  return sel && p.clips.some((c) => c.id === sel) ? sel : null;
}

export function undo(): void {
  const s = get();
  if (s.gestureBase || s.past.length === 0) return;
  const prev = s.past[s.past.length - 1];
  set({
    project: prev,
    past: s.past.slice(0, -1),
    future: [s.project, ...s.future],
    selectedClipId: fixSelection(prev, s.selectedClipId),
    selectedTransitionClipId: fixSelection(prev, s.selectedTransitionClipId),
    lastCoalesce: null,
  });
}

export function redo(): void {
  const s = get();
  if (s.gestureBase || s.future.length === 0) return;
  const next = s.future[0];
  set({
    project: next,
    past: [...s.past, s.project],
    future: s.future.slice(1),
    selectedClipId: fixSelection(next, s.selectedClipId),
    selectedTransitionClipId: fixSelection(next, s.selectedTransitionClipId),
    lastCoalesce: null,
  });
}

export function selectClip(id: string | null): void {
  const s = get();
  if (s.selectedClipId !== id || s.selectedTransitionClipId) {
    set({ selectedClipId: id, selectedTransitionClipId: null, lastCoalesce: null });
  }
}

/** 切り替え効果（clipId の前のつなぎ目）を選ぶ */
export function selectTransition(clipId: string | null): void {
  set({ selectedTransitionClipId: clipId, selectedClipId: null, lastCoalesce: null });
}

export function setCurrentTime(t: number): void {
  const max = projectDuration(get().project);
  set({ currentTime: Math.max(0, Math.min(t, Math.max(max, 0))) });
}

export function setPlaying(playing: boolean): void {
  set({ playing });
}

export const ZOOM_MIN = 4;
export const ZOOM_MAX = 400;

export function setZoom(z: number): void {
  set({ zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) });
}

export function upsertAsset(asset: Asset): void {
  const s = get();
  const exists = !!s.assets[asset.id];
  set({
    assets: { ...s.assets, [asset.id]: asset },
    assetOrder: exists ? s.assetOrder : [...s.assetOrder, asset.id],
  });
}

export function patchAsset(id: string, patch: Partial<Asset>): void {
  const s = get();
  const a = s.assets[id];
  if (!a) return;
  set({ assets: { ...s.assets, [id]: { ...a, ...patch } } });
}

export function getAsset(id: string): Asset | undefined {
  return get().assets[id];
}

const usesAsset = (p: Project, id: string) => p.clips.some((c) => c.type === 'media' && c.assetId === id);

/** 「元に戻す・やり直し」の履歴の中でその素材を使っているか */
export function assetUsedInHistory(id: string): boolean {
  const s = get();
  return [...s.past, ...s.future, ...(s.gestureBase ? [s.gestureBase] : [])].some((p) => usesAsset(p, id));
}

/** 素材を一覧から消す（タイムラインで使っているときは消さない）。消したら true */
export function removeAsset(id: string): boolean {
  const s = get();
  if (usesAsset(s.project, id)) return false;
  // 履歴に残っていると、元に戻したときに素材のないクリップができてしまうので履歴を消す
  if (assetUsedInHistory(id)) set({ past: [], future: [], lastCoalesce: null });
  const a = s.assets[id];
  if (a) {
    URL.revokeObjectURL(a.url);
    if (a.thumbnail) URL.revokeObjectURL(a.thumbnail);
  }
  const assets = { ...s.assets };
  delete assets[id];
  set({ assets, assetOrder: s.assetOrder.filter((x) => x !== id) });
  return true;
}

/** すべてを最初の状態に戻す（新しいプロジェクト） */
export function resetEditor(project: Project): void {
  const s = get();
  for (const a of Object.values(s.assets)) {
    URL.revokeObjectURL(a.url);
    if (a.thumbnail) URL.revokeObjectURL(a.thumbnail);
  }
  set({
    project,
    past: [],
    future: [],
    gestureBase: null,
    lastCoalesce: null,
    selectedClipId: null,
    selectedTransitionClipId: null,
    currentTime: 0,
    playing: false,
    assets: {},
    assetOrder: [],
  });
}

let toastSeq = 0;
export function showToast(message: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastSeq;
  set({ toasts: [...get().toasts, { id, message, kind }] });
  setTimeout(() => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  }, kind === 'error' ? 6000 : 3000);
}
