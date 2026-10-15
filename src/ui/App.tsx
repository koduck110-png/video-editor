import { useEffect, useRef, useState } from 'react';
import { copySelected, deleteSelected, duplicateSelected, pasteAtPlayhead, splitAtPlayhead } from '../model/actions';
import { redo, selectClip, setCurrentTime, showToast, undo, useEditor } from '../model/store';
import { FPS, snapToFrame } from '../model/types';
import { importFiles } from '../media/assets';
import { requestPersistentStorage, restoreLastSession, startAutosave } from '../persist/autosave';
import { player } from '../player/player';
import { ExportDialog } from './ExportDialog';
import { Header } from './Header';
import { Inspector } from './Inspector';
import { MediaPanel } from './MediaPanel';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { Toasts } from './Toasts';

let toastShown = false;

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['range', 'color', 'checkbox', 'button'].includes(type);
  }
  return false;
}

export function App() {
  const [exporting, setExporting] = useState(false);
  const [fileDrag, setFileDrag] = useState(false);
  const dragDepth = useRef(0);
  const [timelineH, setTimelineH] = useState(300);

  // キーボード操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (exporting) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === 'z' && !e.shiftKey) {
        if (isTyping(e)) return;
        e.preventDefault();
        undo();
      } else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
        if (isTyping(e)) return;
        e.preventDefault();
        redo();
      } else if (isTyping(e)) {
        return;
      } else if (key === ' ') {
        e.preventDefault();
        player.togglePlay();
      } else if (ctrl && key === 'b') {
        e.preventDefault();
        splitAtPlayhead();
      } else if (ctrl && key === 'c') {
        e.preventDefault();
        copySelected();
      } else if (ctrl && key === 'v') {
        e.preventDefault();
        pasteAtPlayhead();
      } else if (ctrl && key === 'd') {
        e.preventDefault();
        duplicateSelected();
      } else if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        deleteSelected();
      } else if (key === 'escape') {
        selectClip(null);
      } else if (key === 'arrowleft' || key === 'arrowright') {
        e.preventDefault();
        const s = useEditor.getState();
        if (s.playing) return;
        const step = e.shiftKey ? 1 : 1 / FPS;
        setCurrentTime(snapToFrame(s.currentTime + (key === 'arrowleft' ? -step : step)));
      } else if (key === 'home') {
        setCurrentTime(0);
      }
    };
    // ボタンを押した直後にスペースを押しても、そのボタンがもう一度押されないようにする
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && !isTyping(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [exporting]);

  // 前回の作業を読み込み、そのあと自動保存を始める
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void restoreLastSession().then((restored) => {
      if (cancelled) return;
      if (restored && !toastShown) {
        toastShown = true;
        showToast('前回の作業を読み込みました');
      }
      stop = startAutosave();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // 保存が終わる前にページを閉じようとしたら確認する
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().saveState === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ファイルを画面のどこにドロップしても読み込めるようにする
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setFileDrag(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setFileDrag(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setFileDrag(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      requestPersistentStorage();
      void importFiles(files);
    }
  };

  const onSplitterDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = timelineH;
    const move = (ev: PointerEvent) => {
      const h = startH - (ev.clientY - startY);
      setTimelineH(Math.max(170, Math.min(window.innerHeight - 260, h)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className="app"
      style={{ ['--timeline-h' as string]: `${timelineH}px` }}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Header onExport={() => setExporting(true)} />
      <div className="workspace">
        <MediaPanel />
        <Preview />
        <Inspector />
      </div>
      <div className="splitter" onPointerDown={onSplitterDown} title="ドラッグしてタイムラインの高さを変える" />
      <Timeline />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {fileDrag && <div className="drop-overlay">ここにファイルをドロップして読み込み</div>}
      <Toasts />
    </div>
  );
}
