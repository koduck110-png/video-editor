import { newProject } from '../model/actions';
import { redo, undo, useEditor } from '../model/store';

const SAVE_LABEL = { saved: '✓ 保存済み', saving: '保存中…', error: '⚠ 保存できませんでした' } as const;

export function Header({ onExport }: { onExport: () => void }) {
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const hasClips = useEditor((s) => s.project.clips.length > 0);
  const saveState = useEditor((s) => s.saveState);
  return (
    <header className="header">
      <div className="logo">
        <span className="logo-mark">
          <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
            <path d="M0 0l12 7-12 7z" fill="#fff" />
          </svg>
        </span>
        かんたん動画編集
      </div>
      <button onClick={() => void newProject()} title="今の作業を消して新しく始める" data-testid="new-project">
        ＋ 新規
      </button>
      <button onClick={undo} disabled={!canUndo} title="元に戻す（Ctrl+Z）" data-testid="undo">
        ↶ 元に戻す
      </button>
      <button onClick={redo} disabled={!canRedo} title="やり直し（Ctrl+Y）" data-testid="redo">
        ↷ やり直し
      </button>
      <span className={`save-state ${saveState}`} data-testid="save-state" title="作業内容はこのパソコンのブラウザの中に自動で保存されます">
        {SAVE_LABEL[saveState]}
      </span>
      <div className="spacer" />
      <span className="privacy-note">ファイルはこのパソコンの中だけで処理され、どこにも送られません</span>
      <button className="primary" onClick={onExport} disabled={!hasClips} data-testid="export-open">
        ⬇ 書き出す（MP4）
      </button>
    </header>
  );
}
