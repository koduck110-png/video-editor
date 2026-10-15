// 作業内容の自動保存と、次に開いたときの復元
import { restoreAssets } from '../media/assets';
import { normalizeProject } from '../model/defaults';
import { useEditor } from '../model/store';
import { clearSaved, loadSaved, saveStateRecord } from './db';
import { markDirty, trackWrite } from './status';

let restoring = false;

/** 編集するたびに少し待ってから保存する */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | null = null;
  const save = () => {
    const s = useEditor.getState();
    const r = release;
    release = null;
    trackWrite(saveStateRecord({ project: s.project, assetOrder: s.assetOrder, savedAt: Date.now() }))
      .catch(() => {})
      .finally(() => r?.());
  };
  return useEditor.subscribe((s, prev) => {
    if (restoring) return;
    if (s.project === prev.project && s.assetOrder === prev.assetOrder) return;
    markDirty();
    // 保存を待っている間も「保存中」に数える
    if (!release) void trackWrite(new Promise<void>((resolve) => (release = resolve)));
    clearTimeout(timer);
    timer = setTimeout(save, 700);
  });
}

let restorePromise: Promise<boolean> | null = null;

/** 前回の作業を読み込む。読み込めたら true（何度呼んでも1回だけ行う） */
export function restoreLastSession(): Promise<boolean> {
  if (!restorePromise) restorePromise = doRestore();
  return restorePromise;
}

async function doRestore(): Promise<boolean> {
  let saved;
  try {
    saved = await loadSaved();
  } catch (e) {
    console.warn('load saved failed', e);
    return false;
  }
  const project = saved.state ? normalizeProject(saved.state.project) : null;
  if (!project || (project.clips.length === 0 && saved.assets.length === 0)) return false;
  restoring = true;
  try {
    useEditor.setState({ project, past: [], future: [], selectedClipId: null, currentTime: 0 });
    const byId = new Map(saved.assets.map((a) => [a.id, a]));
    const order = saved.state?.assetOrder ?? [];
    const records = [
      ...order.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a),
      ...saved.assets.filter((a) => !order.includes(a.id)),
    ];
    const restoreJob = restoreAssets(records);
    restoring = false;
    await restoreJob;
  } finally {
    restoring = false;
  }
  return true;
}

/** 保存しておいた内容をすべて消す */
export async function clearSession(): Promise<void> {
  await clearSaved();
}

/** ブラウザに「消さないで」とお願いする（容量が足りないときに勝手に消されにくくなる） */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* 対応していないブラウザ */
  }
}
