import { useEffect, useRef, useState } from 'react';
import { ExportCanceled, ExportProgress, canExportInThisBrowser, exportProject } from '../export/exporter';
import { setPlaying, useEditor } from '../model/store';
import { formatTime, projectDuration } from '../model/types';

type Phase = 'confirm' | 'running' | 'done' | 'error';

function fileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `video-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;
}

function formatRemaining(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `残り約 ${Math.ceil(sec)} 秒`;
  return `残り約 ${Math.ceil(sec / 60)} 分`;
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('confirm');
  const [progress, setProgress] = useState<ExportProgress>({ ratio: 0, message: '' });
  const [error, setError] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const duration = useEditor((s) => projectDuration(s.project));

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const start = async () => {
    setPlaying(false);
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('running');
    setStartedAt(performance.now());
    setProgress({ ratio: 0, message: '準備しています…' });
    const s = useEditor.getState();
    try {
      const result = await exportProject(s.project, s.assets, setProgress, ac.signal);
      const n = fileName();
      const u = URL.createObjectURL(result.blob);
      setName(n);
      setUrl(u);
      const notes: string[] = [];
      if (result.videoCodec !== 'avc') notes.push('このブラウザでは標準の映像形式（H.264）が使えなかったため、別の形式で保存しました。古い再生ソフトでは再生できないことがあります。');
      if (result.audioCodec !== 'aac') notes.push('音声は Opus 形式で保存しました。');
      setNote(notes.join(' '));
      setPhase('done');
      // 自動でダウンロードを始める
      const a = document.createElement('a');
      a.href = u;
      a.download = n;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      if (e instanceof ExportCanceled) {
        onClose();
        return;
      }
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  };

  const elapsed = (performance.now() - startedAt) / 1000;
  const remaining = progress.ratio > 0.02 ? (elapsed / progress.ratio) * (1 - progress.ratio) : NaN;
  const pct = Math.floor(progress.ratio * 100);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" data-testid="export-dialog">
        {phase === 'confirm' && (
          <>
            <h2>動画を書き出す</h2>
            <p>
              1920×1080・30コマ/秒の MP4（音声付き）を作ります。
              <br />
              長さ: {formatTime(duration)}
            </p>
            {!canExportInThisBrowser() && (
              <p className="error-text">このブラウザは書き出しに対応していません。最新の Google Chrome で開いてください。</p>
            )}
            <p>書き出し中はこの画面を開いたままにしてください。</p>
            <div className="modal-actions">
              <button onClick={onClose}>やめる</button>
              <button className="primary" onClick={start} disabled={!canExportInThisBrowser()} data-testid="export-start">
                書き出し開始
              </button>
            </div>
          </>
        )}
        {phase === 'running' && (
          <>
            <h2>書き出し中…</h2>
            <p>{progress.message}</p>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-text">
              <span data-testid="export-percent">{pct}%</span>
              <span>{formatRemaining(remaining)}</span>
            </div>
            <div className="modal-actions">
              <button onClick={() => abortRef.current?.abort()}>中止</button>
            </div>
          </>
        )}
        {phase === 'done' && url && (
          <>
            <h2>完成しました！</h2>
            <p>ダウンロードが始まらない場合は、下の「保存する」を押してください。</p>
            {note && <p>{note}</p>}
            <div className="modal-actions">
              <button onClick={onClose} data-testid="export-close">
                閉じる
              </button>
              <a href={url} download={name} data-testid="export-download">
                <button className="primary">⬇ 保存する</button>
              </a>
            </div>
          </>
        )}
        {phase === 'error' && (
          <>
            <h2>書き出しできませんでした</h2>
            <p className="error-text" data-testid="export-error">
              {error}
            </p>
            <div className="modal-actions">
              <button onClick={onClose}>閉じる</button>
              <button className="primary" onClick={start}>
                もう一度
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
