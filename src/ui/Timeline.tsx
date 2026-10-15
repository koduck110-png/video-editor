import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  addAssetToTimeline,
  addNewTrack,
  addText,
  copySelected,
  deleteSelected,
  deleteTrack,
  detachSelectedAudio,
  duplicateSelected,
  hasClipboard,
  pasteAtPlayhead,
  splitAtPlayhead,
} from '../model/actions';
import { adjacentPrev, moveClip, trimClipEnd, trimClipStart } from '../model/ops';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  beginGesture,
  commit,
  endGesture,
  getAsset,
  selectClip,
  selectTransition,
  setCurrentTime,
  setZoom,
  useEditor,
} from '../model/store';
import { Asset, Clip, PEAKS_PER_SEC, Track, TrackKind, clipEnd, projectDuration, snapToFrame } from '../model/types';
import { TRANSITIONS } from '../render/effects';
import { ASSET_DRAG_TYPE } from './MediaPanel';

const RULER_H = 28;
const SNAP_PX = 8;

const TRACK_COLORS: Record<Track['kind'], string> = {
  video: 'var(--video)',
  text: 'var(--text-clip)',
  audio: 'var(--audio)',
};

function zoomToSlider(z: number): number {
  return (Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 100;
}
function sliderToZoom(v: number): number {
  return ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / 100);
}

/** 目盛りの間隔を拡大率に合わせて選ぶ */
function pickTickStep(zoom: number): number {
  const steps = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s * zoom >= 70) return s;
  return 1200;
}

function formatRuler(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

function Ruler({
  zoom,
  scrollLeft,
  viewWidth,
  onSeekStart,
}: {
  zoom: number;
  scrollLeft: number;
  viewWidth: number;
  onSeekStart: (e: React.PointerEvent) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(viewWidth * dpr));
    c.height = RULER_H * dpr;
    c.style.width = `${viewWidth}px`;
    c.style.height = `${RULER_H}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewWidth, RULER_H);
    const step = pickTickStep(zoom);
    const minor = step / 5;
    const t0 = scrollLeft / zoom;
    const t1 = (scrollLeft + viewWidth) / zoom;
    ctx.strokeStyle = '#4a4f5c';
    ctx.fillStyle = '#9aa0ad';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
      const t = i * minor;
      const x = Math.round(t * zoom - scrollLeft) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, major ? 12 : 20);
      ctx.lineTo(x, RULER_H);
      if (major) ctx.fillText(formatRuler(t, step), x + 4, 3);
    }
    ctx.stroke();
  }, [zoom, scrollLeft, viewWidth]);
  return (
    <div className="ruler" onPointerDown={onSeekStart} data-testid="ruler">
      <canvas ref={ref} />
    </div>
  );
}

function Waveform({ asset, clip, width, height }: { asset: Asset; clip: Clip; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const inPoint = clip.type === 'media' ? clip.inPoint : 0;
  const span = clip.type === 'media' ? clip.duration * clip.speed : clip.duration;
  useEffect(() => {
    const c = ref.current;
    const peaks = asset.peaks;
    if (!c || !peaks) return;
    const w = Math.max(1, Math.min(4000, Math.floor(width)));
    c.width = w;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const mid = height / 2;
    for (let x = 0; x < w; x++) {
      const t0 = inPoint + (x / w) * span;
      const t1 = inPoint + ((x + 1) / w) * span;
      let max = 0;
      for (let i = Math.floor(t0 * PEAKS_PER_SEC); i <= Math.floor(t1 * PEAKS_PER_SEC) && i < peaks.length; i++) {
        if (peaks[i] > max) max = peaks[i];
      }
      const h = Math.max(1, max * (height - 6));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
  }, [asset.peaks, inPoint, span, width, height]);
  return <canvas ref={ref} className="clip-wave" />;
}

type DragMode = 'move' | 'left' | 'right';

interface ClipViewProps {
  clip: Clip;
  trackKind: TrackKind;
  zoom: number;
  selected: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: DragMode) => void;
  onContextMenu: (e: React.MouseEvent, clip: Clip) => void;
}

const ClipView = memo(function ClipView({ clip, trackKind, zoom, selected, dragging, onPointerDown, onContextMenu }: ClipViewProps) {
  const asset = useEditor((s) => (clip.type === 'media' ? s.assets[clip.assetId] : undefined));
  const left = clip.start * zoom;
  const width = Math.max(4, clip.duration * zoom);
  const kindClass = clip.type === 'text' ? 'text' : trackKind === 'audio' ? 'audio' : 'video';
  const label =
    clip.type === 'text' ? `T  ${clip.text.replace(/\n/g, ' ') || '（空の文字）'}` : asset ? asset.name : '（素材が見つかりません）';
  const badges: string[] = [];
  if (clip.type === 'media') {
    if (clip.speed !== 1) badges.push(`${clip.speed}x`);
    if (clip.filter.id !== 'none') badges.push('🎨');
    if (clip.volume === 0 || clip.audioDetached) badges.push('🔇');
  }
  if (clip.animIn || clip.animOut) badges.push('✦');
  return (
    <div
      className={`clip ${kindClass}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      style={{ left, width }}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
      onContextMenu={(e) => onContextMenu(e, clip)}
      data-testid="clip"
      data-clip-id={clip.id}
      data-clip-type={kindClass}
    >
      {asset?.thumbnail && kindClass === 'video' && (
        <div className="clip-thumbs" style={{ backgroundImage: `url(${asset.thumbnail})` }} />
      )}
      {kindClass === 'audio' && asset?.peaks && <Waveform asset={asset} clip={clip} width={width} height={44} />}
      <div className="clip-label">{label}</div>
      {badges.length > 0 && <div className="clip-badges">{badges.join(' ')}</div>}
      <div
        className="clip-handle left"
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDown(e, clip, 'left');
        }}
        title="ドラッグして長さを変える"
        data-testid="handle-left"
      />
      <div
        className="clip-handle right"
        onPointerDown={(e) => {
          e.stopPropagation();
          onPointerDown(e, clip, 'right');
        }}
        title="ドラッグして長さを変える"
        data-testid="handle-right"
      />
    </div>
  );
});

function Playhead({ zoom, scrollRef }: { zoom: number; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const t = useEditor((s) => s.currentTime);
  const playing = useEditor((s) => s.playing);
  const x = t * zoom;
  // 再生中に白い線が見えなくなったら追いかける
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    if (x > el.scrollLeft + el.clientWidth - 30) el.scrollLeft = x - 60;
    else if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60);
  }, [x, playing, scrollRef]);
  return <div className="playhead" style={{ left: x }} data-testid="playhead" />;
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const selectedId = useEditor((s) => s.selectedClipId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewWidth, setViewWidth] = useState(800);
  const [dragId, setDragId] = useState<string | null>(null);
  const [snapX, setSnapX] = useState<number | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  const zoomAnchor = useRef<{ time: number; px: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; clip: Clip } | null>(null);
  const selectedTrans = useEditor((s) => s.selectedTransitionClipId);

  // 右クリックのメニューは、ほかの場所を押したら閉じる
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const onClipContextMenu = useCallback((e: React.MouseEvent, clip: Clip) => {
    e.preventDefault();
    selectClip(clip.id);
    setMenu({ x: e.clientX, y: e.clientY, clip });
  }, []);

  const duration = projectDuration(project);
  const contentWidth = Math.max(viewWidth, (duration + 30) * zoom);

  // 表示幅を監視
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
    ro.observe(el);
    setViewWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollLeft(el.scrollLeft);
    if (headersRef.current) headersRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
  };

  /** 拡大率を変える。anchorTime の位置が画面上で動かないようにする */
  const changeZoom = useCallback((z: number, anchorTime?: number, anchorPx?: number) => {
    const el = scrollRef.current;
    const cur = useEditor.getState().zoom;
    const time = anchorTime ?? useEditor.getState().currentTime;
    const px = anchorPx ?? (el ? time * cur - el.scrollLeft : 0);
    zoomAnchor.current = { time, px };
    setZoom(z);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = zoomAnchor.current;
    if (el && a) {
      el.scrollLeft = Math.max(0, a.time * zoom - a.px);
      zoomAnchor.current = null;
    }
  }, [zoom]);

  // Ctrl + ホイールで拡大・縮小
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const cur = useEditor.getState().zoom;
      const time = (el.scrollLeft + px) / cur;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      changeZoom(cur * factor, time, px);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [changeZoom]);

  // 新しく追加して選んだクリップが見えていなければ、見える位置までスクロールする
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !selectedId) return;
    const s = useEditor.getState();
    const clip = s.project.clips.find((c) => c.id === selectedId);
    if (!clip) return;
    const x0 = clip.start * s.zoom;
    const x1 = clipEnd(clip) * s.zoom;
    if (x1 < el.scrollLeft + 20 || x0 > el.scrollLeft + el.clientWidth - 20) {
      el.scrollLeft = Math.max(0, x0 - 40);
    }
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-track-id="${clip.trackId}"]`);
    if (row) {
      const top = row.offsetTop - RULER_H;
      const bottom = row.offsetTop + row.offsetHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    }
  }, [selectedId]);

  const timeFromClientX = (clientX: number): number => {
    const rect = contentRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / useEditor.getState().zoom);
  };

  // 目盛りをクリック・ドラッグして再生位置を動かす
  const onSeekStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const seek = (clientX: number) => setCurrentTime(snapToFrame(timeFromClientX(clientX)));
    seek(e.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // クリップのドラッグ（移動・長さの変更）
  const onClipPointerDown = useCallback((e: React.PointerEvent, clip: Clip, mode: DragMode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    const s = useEditor.getState();
    const z = s.zoom;
    const startX = e.clientX;
    // つかんだ位置とクリップの端のずれ（つかんだ瞬間に端が飛ばないように）
    const grabOffset = timeFromClientX(e.clientX) - (mode === 'right' ? clipEnd(clip) : clip.start);
    // 吸着させる位置: 0、再生位置、ほかのクリップの端
    const snapPoints = [0, s.currentTime];
    for (const c of s.project.clips) {
      if (c.id === clip.id) continue;
      snapPoints.push(c.start, clipEnd(c));
    }
    const threshold = SNAP_PX / z;
    const snap = (t: number): [number, number | null] => {
      let best: number | null = null;
      let bestD = threshold;
      for (const p of snapPoints) {
        const d = Math.abs(p - t);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return best === null ? [t, null] : [best, best];
    };
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - startX) < 3 && mode === 'move' && Math.abs(ev.clientY - e.clientY) < 3) return;
        started = true;
        beginGesture();
        setDragId(clip.id);
      }
      const cur = useEditor.getState().project.clips.find((c) => c.id === clip.id);
      if (!cur) return;
      const t = timeFromClientX(ev.clientX);
      if (mode === 'move') {
        let desired = t - grabOffset;
        const [sStart, lineA] = snap(desired);
        const [sEnd, lineB] = snap(desired + cur.duration);
        let line: number | null = null;
        if (lineA !== null && (lineB === null || Math.abs(sStart - desired) <= Math.abs(sEnd - (desired + cur.duration)))) {
          desired = sStart;
          line = lineA;
        } else if (lineB !== null) {
          desired = sEnd - cur.duration;
          line = lineB;
        }
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-track-id]');
        const trackId = under?.dataset.trackId ?? cur.trackId;
        commit((p) => moveClip(p, clip.id, trackId, desired));
        setSnapX(line);
      } else if (mode === 'left') {
        const [st, line] = snap(t - grabOffset);
        commit((p) => trimClipStart(p, clip.id, st, getAsset));
        setSnapX(line);
      } else {
        const [en, line] = snap(t - grabOffset);
        commit((p) => trimClipEnd(p, clip.id, en, getAsset));
        setSnapX(line);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (started) endGesture();
      setDragId(null);
      setSnapX(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, []);

  // 素材パネルからのドラッグ＆ドロップ
  const onRowDragOver = (e: React.DragEvent, track: Track) => {
    if (!Array.from(e.dataTransfer.types).includes(ASSET_DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (dropTrack !== track.id) setDropTrack(track.id);
  };
  const onRowDrop = (e: React.DragEvent, track: Track) => {
    const id = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTrack(null);
    const asset = getAsset(id);
    if (asset) addAssetToTimeline(asset, { trackId: track.id, at: snapToFrame(timeFromClientX(e.clientX)) });
  };

  const fitAll = () => {
    const d = Math.max(1, duration);
    const z = (viewWidth - 40) / d;
    zoomAnchor.current = { time: 0, px: 0 };
    setZoom(z);
  };

  const canDelete = !!selectedId;

  return (
    <section className="timeline">
      <div className="timeline-toolbar">
        <button onClick={splitAtPlayhead} title="白い線の位置でクリップを分ける（Ctrl+B）" data-testid="split">
          ✂ 分割
        </button>
        <button onClick={deleteSelected} disabled={!canDelete} title="選んだクリップを消す（Delete）" data-testid="delete">
          🗑 削除
        </button>
        <span className="sep" />
        <button onClick={() => addText()} title="白い線の位置に文字を追加" data-testid="add-text">
          T 文字を追加
        </button>
        <span className="sep" />
        <button onClick={() => addNewTrack('video')} title="映像のトラックを増やす（上にあるものが手前に表示されます）">
          ＋映像トラック
        </button>
        <button onClick={() => addNewTrack('text')}>＋文字トラック</button>
        <button onClick={() => addNewTrack('audio')}>＋音声トラック</button>
        <span className="spacer" />
        <div className="zoom-control">
          <button className="icon" onClick={() => changeZoom(zoom / 1.4)} title="縮小" data-testid="zoom-out">
            －
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={zoomToSlider(zoom)}
            onChange={(e) => changeZoom(sliderToZoom(Number(e.target.value)))}
            aria-label="タイムラインの拡大率"
            data-testid="zoom-slider"
          />
          <button className="icon" onClick={() => changeZoom(zoom * 1.4)} title="拡大" data-testid="zoom-in">
            ＋
          </button>
          <button onClick={fitAll} title="全体が見えるようにする">
            全体を表示
          </button>
        </div>
      </div>
      <div className="timeline-main">
        <div className="track-headers">
          <div className="track-headers-inner" ref={headersRef}>
            {project.tracks.map((track) => (
              <div className="track-header" key={track.id}>
                <span className="track-dot" style={{ background: TRACK_COLORS[track.kind] }} />
                <span className="name">{track.name}</span>
                <button onClick={() => deleteTrack(track.id)} title="このトラックを削除">
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="timeline-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="timeline-content" ref={contentRef} style={{ width: contentWidth }}>
            <Ruler zoom={zoom} scrollLeft={scrollLeft} viewWidth={viewWidth} onSeekStart={onSeekStart} />
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={`track-row${dropTrack === track.id ? ' drop-target' : ''}`}
                data-track-id={track.id}
                data-track-kind={track.kind}
                data-testid={`track-${track.kind}`}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) selectClip(null);
                }}
                onDragOver={(e) => onRowDragOver(e, track)}
                onDragLeave={() => setDropTrack(null)}
                onDrop={(e) => onRowDrop(e, track)}
              >
                {project.clips
                  .filter((c) => c.trackId === track.id)
                  .map((c) => (
                    <ClipView
                      key={c.id}
                      clip={c}
                      trackKind={track.kind}
                      zoom={zoom}
                      selected={c.id === selectedId}
                      dragging={c.id === dragId}
                      onPointerDown={onClipPointerDown}
                      onContextMenu={onClipContextMenu}
                    />
                  ))}
                {track.kind === 'video' &&
                  !dragId &&
                  project.clips
                    .filter((c) => c.trackId === track.id && adjacentPrev(project, c))
                    .map((c) => {
                      const tr = c.transitionIn;
                      const icon = tr ? TRANSITIONS.find((x) => x.type === tr.type)?.icon ?? '⇄' : '⇄';
                      return (
                        <button
                          key={`j-${c.id}`}
                          className={`junction${tr ? ' has' : ''}${selectedTrans === c.id ? ' selected' : ''}`}
                          style={{ left: c.start * zoom }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => selectTransition(c.id)}
                          title={tr ? '切り替え効果（押して変更）' : '切り替え効果を付ける'}
                          data-testid="junction"
                        >
                          {icon}
                        </button>
                      );
                    })}
              </div>
            ))}
            <Playhead zoom={zoom} scrollRef={scrollRef} />
            {snapX !== null && <div className="snap-line" style={{ left: snapX * zoom }} />}
          </div>
          {project.clips.length === 0 && (
            <div className="timeline-empty">素材をここへドラッグするか、素材の「＋追加」を押してください</div>
          )}
        </div>
      </div>
      {menu && (
        <div
          className="context-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 260) }}
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="context-menu"
        >
          {[
            { label: 'コピー（Ctrl+C）', run: copySelected },
            { label: '貼り付け（Ctrl+V）', run: pasteAtPlayhead, disabled: !hasClipboard() },
            { label: '複製（Ctrl+D）', run: duplicateSelected },
            { label: '白い線で分割（Ctrl+B）', run: splitAtPlayhead },
            ...(menu.clip.type === 'media' && project.tracks.find((t) => t.id === menu.clip.trackId)?.kind === 'video'
              ? [{ label: '音声を分離', run: detachSelectedAudio }]
              : []),
            { label: '削除（Delete）', run: deleteSelected, danger: true },
          ].map((it) => (
            <button
              key={it.label}
              className={it.danger ? 'danger' : ''}
              disabled={it.disabled}
              onClick={() => {
                setMenu(null);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
