// 保存の状態（保存中・保存済み・失敗）をまとめて管理する
import { showToast, useEditor } from '../model/store';

let pending = 0;
let failed = false;

/** 保存の処理を見張る。全部終わったら「保存済み」にする */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  pending++;
  if (useEditor.getState().saveState !== 'saving') useEditor.setState({ saveState: 'saving' });
  return p
    .then((v) => {
      return v;
    })
    .catch((e) => {
      console.warn('save failed', e);
      if (!failed) showToast('ブラウザに保存できませんでした（パソコンの空き容量が足りない可能性があります）', 'error');
      failed = true;
      throw e;
    })
    .finally(() => {
      pending--;
      if (pending === 0) useEditor.setState({ saveState: failed ? 'error' : 'saved' });
    });
}

/** これから保存する予定がある（少し待ってから保存するとき） */
export function markDirty(): void {
  failed = false;
  if (useEditor.getState().saveState !== 'saving') useEditor.setState({ saveState: 'saving' });
}

export function isWriting(): boolean {
  return pending > 0;
}
