import { useEffect, useRef, useState } from 'react';
import { activeClipOnTrack, getClip, updateClipCommon } from '../model/ops';
import { beginGesture, commit, endGesture, selectClip, setCurrentTime, useEditor } from '../model/store';
import { Clip, FPS, Project, Transform, formatTime, projectDuration, snapToFrame } from '../model/types';
import { player } from '../player/player';
import { Box, mediaBox, pointInBox, textBox } from '../render/compositor';

type Assets = ReturnType<typeof useEditor.getState>['assets'];

/** クリップの表示範囲（画面の座標）。動画・画像・文字以外は null */
function clipBox(project: Project, assets: Assets, clip: Clip): Box | null {
  const kind = project.tracks.find((t) => t.id === clip.trackId)?.kind;
  if (clip.type === 'text') return textBox(project, clip);
  if (kind !== 'video') return null;
  const a = assets[clip.assetId];
  if (!a || a.status !== 'ready' || !a.width || !a.height) return null;
  return mediaBox(project, clip, a.width, a.height);
}

/** 画面のその位置にある、いちばん手前のクリップ */
function hitTest(project: Project, assets: Assets, t: number, x: number, y: number): Clip | undefined {
  for (const track of project.tracks) {
    if (track.kind === 'audio') continue;
    const c = activeClipOnTrack(project, track.id, t);
    if (!c) continue;
    const b = clipBox(project, assets, c);
    if (b && pointInBox(b, x, y)) return c;
  }
  return undefined;
}

type DragMode = 'move' | 'scale' | 'rotate';

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState({ w: 640, h: 360 });
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const project = useEditor((s) => s.project);
  const assets = useEditor((s) => s.assets);
  const currentTime = useEditor((s) => s.currentTime);
  const playing = useEditor((s) => s.playing);
  const selectedId = useEditor((s) => s.selectedClipId);
  const duration = projectDuration(project);
  const { width: W, height: H } = project.settings;

  useEffect(() => {
    if (canvasRef.current) player.attach(canvasRef.current);
    return () => player.detach();
  }, []);

  // 表示できる広さに合わせて画面比率どおりの大きさを決める
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const pad = 24;
      const aw = Math.max(16, el.clientWidth - pad);
      const ah = Math.max(9, el.clientHeight - pad);
      const ratio = W / H;
      const w = Math.floor(Math.min(aw, ah * ratio));
      setFrameSize({ w, h: Math.floor(w / ratio) });
    };
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [W, H]);

  const f = frameSize.w / W; // 画面の座標 → 表示の画素

  const selected = selectedId ? getClip(project, selectedId) : undefined;
  const showBox =
    !playing && selected && selected.start <= currentTime + 1e-6 && currentTime < selected.start + selected.duration - 1e-6;
  const box = showBox && selected ? clipBox(project, assets, selected) : null;

  /** 選んだクリップを動かす・大きさを変える・回す */
  const startDrag = (e: React.PointerEvent, clip: Clip, mode: DragMode) => {
    if (e.button !== 0 || !frameRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = frameRef.current.getBoundingClientRect();
    const t0: Transform = { ...clip.transform };
    const b0 = clipBox(useEditor.getState().project, useEditor.getState().assets, clip);
    const cx = rect.left + (b0 ? b0.cx : t0.x * W) * (rect.width / W);
    const cy = rect.top + (b0 ? b0.cy : t0.y * H) * (rect.height / H);
    const startX = e.clientX;
    const startY = e.clientY;
    const d0 = Math.max(4, Math.hypot(startX - cx, startY - cy));
    const a0 = Math.atan2(startY - cy, startX - cx);
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 3) return;
        started = true;
        beginGesture();
      }
      let next: Transform = { ...t0 };
      let gv = false;
      let gh = false;
      if (mode === 'move') {
        let x = t0.x + (ev.clientX - startX) / rect.width;
        let y = t0.y + (ev.clientY - startY) / rect.height;
        // 中央付近では中央にぴったり合わせる
        const snap = 8 / rect.width;
        if (Math.abs(x - 0.5) < snap) {
          x = 0.5;
          gv = true;
        }
        if (Math.abs(y - 0.5) < 8 / rect.height) {
          y = 0.5;
          gh = true;
        }
        next = { ...t0, x, y };
      } else if (mode === 'scale') {
        const d1 = Math.hypot(ev.clientX - cx, ev.clientY - cy);
        let scale = Math.min(10, Math.max(0.05, (t0.scale * d1) / d0));
        if (Math.abs(scale - 1) < 0.03) scale = 1;
        next = { ...t0, scale };
      } else {
        const a1 = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        let rot = t0.rotation + ((a1 - a0) * 180) / Math.PI;
        rot = ((((rot + 180) % 360) + 360) % 360) - 180;
        if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
        else {
          const near = Math.round(rot / 90) * 90;
          if (Math.abs(rot - near) < 4) rot = near;
        }
        next = { ...t0, rotation: rot };
      }
      setGuides({ v: gv, h: gh });
      commit((p) => updateClipCommon(p, clip.id, { transform: next }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setGuides({ v: false, h: false });
      if (started) endGesture();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** 画面をクリックしたら、そこにあるクリップを選んで動かせるようにする */
  const onFramePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !frameRef.current || playing) return;
    const rect = frameRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    const s = useEditor.getState();
    const hit = hitTest(s.project, s.assets, s.currentTime, x, y);
    if (!hit) {
      selectClip(null);
      return;
    }
    selectClip(hit.id);
    startDrag(e, hit, 'move');
  };

  const step = (dir: number) => setCurrentTime(snapToFrame(currentTime + dir / FPS));

  return (
    <section className="preview">
      <div className="preview-stage" ref={stageRef}>
        <div
          className="preview-frame"
          ref={frameRef}
          style={{ width: frameSize.w, height: frameSize.h }}
          onPointerDown={onFramePointerDown}
          data-testid="preview-frame"
        >
          <canvas ref={canvasRef} data-testid="preview-canvas" />
          {guides.v && <div className="guide guide-v" />}
          {guides.h && <div className="guide guide-h" />}
          {box && selected && (
            <div
              className="transform-box"
              style={{
                left: box.cx * f,
                top: box.cy * f,
                width: Math.abs(box.w) * f,
                height: Math.abs(box.h) * f,
                transform: `translate(-50%, -50%) rotate(${box.rotation}deg)`,
              }}
              onPointerDown={(e) => startDrag(e, selected, 'move')}
              onDoubleClick={() => {
                if (selected.type === 'text') document.querySelector<HTMLTextAreaElement>('[data-testid=text-input]')?.focus();
              }}
              title="ドラッグで移動・角で大きさ・上の丸で回転"
              data-testid={selected.type === 'text' ? 'text-box' : 'media-box'}
            >
              {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                <div
                  key={c}
                  className={`tb-handle tb-${c}`}
                  onPointerDown={(e) => startDrag(e, selected, 'scale')}
                  data-testid={`handle-scale-${c}`}
                />
              ))}
              <div className="tb-rotate" onPointerDown={(e) => startDrag(e, selected, 'rotate')} data-testid="handle-rotate" />
            </div>
          )}
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
        <span className="ratio-badge" title="画面比率（何も選んでいないときに右の設定で変えられます）">
          {project.settings.ratio}
        </span>
      </div>
    </section>
  );
}
