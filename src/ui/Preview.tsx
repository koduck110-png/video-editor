import { useEffect, useRef, useState } from 'react';
import { updateTextClip } from '../model/ops';
import { beginGesture, commit, endGesture, selectClip, setCurrentTime, useEditor } from '../model/store';
import { FPS, OUT_HEIGHT, OUT_WIDTH, TextClip, formatTime, projectDuration, snapToFrame } from '../model/types';
import { player } from '../player/player';
import { measureText, visibleTextClips } from '../render/compositor';

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
  return measureCtx;
}

function TextBox({ clip, frame, selected }: { clip: TextClip; frame: HTMLDivElement | null; selected: boolean }) {
  const [hover, setHover] = useState(false);
  const box = measureText(getMeasureCtx(), clip);
  const pad = 10;
  const style: React.CSSProperties = {
    left: `${((box.x - pad) / OUT_WIDTH) * 100}%`,
    top: `${((box.y - pad) / OUT_HEIGHT) * 100}%`,
    width: `${((box.w + pad * 2) / OUT_WIDTH) * 100}%`,
    height: `${((box.h + pad * 2) / OUT_HEIGHT) * 100}%`,
    opacity: selected || hover ? 1 : 0,
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!frame || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    const rect = frame.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = clip.x;
    const oy = clip.y;
    let started = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      if (!started) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 3) return;
        started = true;
        beginGesture();
      }
      let x = Math.min(1, Math.max(0, ox + dx));
      let y = Math.min(1, Math.max(0, oy + dy));
      // 中央付近では中央にぴったり合わせる
      if (Math.abs(x - 0.5) < 0.01) x = 0.5;
      if (Math.abs(y - 0.5) < 0.01) y = 0.5;
      commit((p) => updateTextClip(p, clip.id, { x, y }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (started) endGesture();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <div
      className={`text-box${!selected && hover ? ' hover' : ''}`}
      style={style}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={onPointerDown}
      title="ドラッグして文字の位置を動かす"
      data-testid="text-box"
    />
  );
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const project = useEditor((s) => s.project);
  const currentTime = useEditor((s) => s.currentTime);
  const playing = useEditor((s) => s.playing);
  const selectedId = useEditor((s) => s.selectedClipId);
  const duration = projectDuration(project);

  const stageRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState({ w: 640, h: 360 });

  useEffect(() => {
    if (canvasRef.current) player.attach(canvasRef.current);
    setFrameEl(frameRef.current);
    return () => player.detach();
  }, []);

  // 表示できる広さに合わせて 16:9 の大きさを決める
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const pad = 24;
      const aw = Math.max(16, el.clientWidth - pad);
      const ah = Math.max(9, el.clientHeight - pad);
      const w = Math.floor(Math.min(aw, (ah * 16) / 9));
      setFrameSize({ w, h: Math.floor((w * 9) / 16) });
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  const texts = playing ? [] : visibleTextClips(project, currentTime);
  const step = (dir: number) => setCurrentTime(snapToFrame(currentTime + dir / FPS));

  return (
    <section className="preview">
      <div className="preview-stage" ref={stageRef}>
        <div
          className="preview-frame"
          ref={frameRef}
          style={{ width: frameSize.w, height: frameSize.h }}
          onPointerDown={() => selectClip(null)}
        >
          <canvas ref={canvasRef} data-testid="preview-canvas" />
          {texts.map((c) => (
            <TextBox key={c.id} clip={c} frame={frameEl} selected={c.id === selectedId} />
          ))}
          {project.clips.length === 0 && (
            <div className="preview-empty">
              左の「素材」に動画や画像を読み込み、
              <br />
              「＋追加」でタイムラインに並べましょう
            </div>
          )}
        </div>
      </div>
      <div className="transport">
        <button className="icon" onClick={() => setCurrentTime(0)} title="最初へ（Home）">
          ⏮
        </button>
        <button className="icon" onClick={() => step(-1)} disabled={playing} title="1コマ戻る（←）">
          ‹ 1コマ
        </button>
        <button
          className="primary play-btn"
          onClick={() => player.togglePlay()}
          disabled={duration <= 0}
          title={playing ? '一時停止（スペース）' : '再生（スペース）'}
          data-testid="play"
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="icon" onClick={() => step(1)} disabled={playing} title="1コマ進む（→）">
          1コマ ›
        </button>
        <span className="time" data-testid="time">
          <b>{formatTime(currentTime)}</b> / {formatTime(duration)}
        </span>
      </div>
    </section>
  );
}
