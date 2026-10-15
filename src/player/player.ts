// プレビューの再生を担当する。映像は <video> 要素、音は Web Audio で鳴らし、
// 音の時計に映像を合わせる。
import { getAudioContext } from '../media/audio';
import { clipHasSound, scheduleClipAudio } from '../media/mix';
import { clipVisibleRange } from '../model/ops';
import { setPlaying, useEditor } from '../model/store';
import { Asset, FPS, MediaClip, ProjectSettings, projectDuration, snapToFrame, sourceTimeAt } from '../model/types';
import { renderFrame } from '../render/compositor';

/** プレビューの canvas の長い辺の画素数 */
const PREVIEW_LONG_SIDE = 1280;

export function previewSize(s: ProjectSettings): { width: number; height: number; k: number } {
  const k = PREVIEW_LONG_SIDE / Math.max(s.width, s.height);
  return { width: Math.round(s.width * k), height: Math.round(s.height * k), k };
}

interface VideoSlot {
  el: HTMLVideoElement;
  assetId: string;
  lastUsed: number;
}

const MAX_IDLE_VIDEOS = 8;

class PlayerEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private videos = new Map<string, VideoSlot>();
  private audioNodes: AudioBufferSourceNode[] = [];
  private master: GainNode | null = null;
  private startT = 0;
  private startCtx = 0;
  private startPerf = 0;
  private useAudioClock = false;
  private raf = 0;
  private redrawRaf = 0;
  private selfUpdate = false;
  private unsub: (() => void) | null = null;
  private k = 1;

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.resizeCanvas();
    this.unsub = useEditor.subscribe((s, prev) => {
      if (s.playing !== prev.playing) {
        if (s.playing) this.startPlayback();
        else this.stopPlayback();
      } else if (s.currentTime !== prev.currentTime && !this.selfUpdate) {
        if (s.playing) this.restartFrom(s.currentTime);
        else this.requestRedraw();
      }
      if (s.project !== prev.project || s.assets !== prev.assets) {
        if (s.project.settings !== prev.project.settings) this.resizeCanvas();
        this.cleanupVideos();
        // 再生中の編集では時計はそのままにして、音だけ並べ直す
        if (s.playing) this.rescheduleAudio();
        else this.requestRedraw();
      }
    });
    this.requestRedraw();
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.redrawRaf);
    this.redrawRaf = 0;
    this.stopAudio();
    for (const id of [...this.videos.keys()]) this.releaseVideo(id);
    this.ctx = null;
    this.canvas = null;
  }

  private resizeCanvas(): void {
    if (!this.canvas) return;
    const size = previewSize(useEditor.getState().project.settings);
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
    }
    this.k = size.k;
  }

  /** 現在の再生位置（秒） */
  now(): number {
    const s = useEditor.getState();
    if (!s.playing) return s.currentTime;
    if (this.useAudioClock) {
      return this.startT + Math.max(0, getAudioContext().currentTime - this.startCtx);
    }
    return this.startT + (performance.now() - this.startPerf) / 1000;
  }

  togglePlay(): void {
    const s = useEditor.getState();
    setPlaying(!s.playing);
  }

  private setTimeSilently(t: number): void {
    this.selfUpdate = true;
    try {
      useEditor.setState({ currentTime: t });
    } finally {
      this.selfUpdate = false;
    }
  }

  private startPlayback(): void {
    const s = useEditor.getState();
    const dur = projectDuration(s.project);
    if (dur <= 0) {
      setPlaying(false);
      return;
    }
    let t = s.currentTime;
    if (t >= dur - 1 / 60) {
      t = 0;
      this.setTimeSilently(0);
    }
    this.startClock(t);
    this.syncVideos(t, true);
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const st = useEditor.getState();
      if (!st.playing) return;
      const d = projectDuration(st.project);
      const now = this.now();
      if (now >= d) {
        this.setTimeSilently(d);
        setPlaying(false);
        return;
      }
      this.setTimeSilently(now);
      this.syncVideos(now, true);
      this.draw(now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopPlayback(): void {
    cancelAnimationFrame(this.raf);
    const s = useEditor.getState();
    // playing は既に false なので、時計から直接求める
    const raw = this.useAudioClock
      ? this.startT + Math.max(0, getAudioContext().currentTime - this.startCtx)
      : this.startT + (performance.now() - this.startPerf) / 1000;
    const dur = projectDuration(s.project);
    const t = Math.min(dur, Math.max(0, snapToFrame(Math.min(raw, s.currentTime + 0.1))));
    this.stopAudio();
    for (const v of this.videos.values()) {
      if (!v.el.paused) v.el.pause();
    }
    this.setTimeSilently(t);
    this.requestRedraw();
  }

  private restartFrom(t: number): void {
    this.startClock(t);
    this.syncVideos(t, true);
  }

  private startClock(t: number): void {
    const ac = getAudioContext();
    this.stopAudio();
    this.startT = t;
    this.startPerf = performance.now();
    if (ac.state === 'running') {
      this.useAudioClock = true;
      this.startCtx = ac.currentTime + 0.05;
      this.scheduleAudio(t, this.startCtx);
    } else {
      this.useAudioClock = false;
      ac.resume()
        .then(() => {
          if (useEditor.getState().playing && !this.useAudioClock) this.restartFrom(this.now());
        })
        .catch(() => {});
    }
  }

  private getMaster(): GainNode {
    const ac = getAudioContext();
    if (!this.master) {
      this.master = ac.createGain();
      this.master.connect(ac.destination);
    }
    return this.master;
  }

  private scheduleAudio(t: number, when: number): void {
    const s = useEditor.getState();
    const ac = getAudioContext();
    const dest = this.getMaster();
    for (const clip of s.project.clips) {
      if (clip.type !== 'media') continue;
      const asset = s.assets[clip.assetId];
      if (!clipHasSound(s.project, clip, asset)) continue;
      const node = scheduleClipAudio(ac, dest, clip, asset!.audioBuffer!, t, when);
      if (node) this.audioNodes.push(node);
    }
  }

  /** 再生を止めずに音の予定を作り直す（古い音は新しい音が始まる瞬間に止める） */
  private rescheduleAudio(): void {
    if (!this.useAudioClock) return;
    const ac = getAudioContext();
    const when = Math.max(ac.currentTime + 0.03, this.startCtx);
    const t = this.startT + (when - this.startCtx);
    for (const n of this.audioNodes) {
      try {
        n.stop(when);
      } catch {
        /* 既に止まっている */
      }
    }
    this.audioNodes = [];
    this.scheduleAudio(t, when);
  }

  private stopAudio(): void {
    for (const n of this.audioNodes) {
      try {
        n.stop();
      } catch {
        /* まだ始まっていない場合など */
      }
      n.disconnect();
    }
    this.audioNodes = [];
  }

  private getVideo(clip: MediaClip, asset: Asset): HTMLVideoElement {
    let slot = this.videos.get(clip.id);
    if (!slot || slot.assetId !== asset.id) {
      if (slot) this.releaseVideo(clip.id);
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.src = asset.url;
      el.addEventListener('seeked', () => this.requestRedraw());
      el.addEventListener('loadeddata', () => this.requestRedraw());
      slot = { el, assetId: asset.id, lastUsed: performance.now() };
      this.videos.set(clip.id, slot);
    }
    slot.lastUsed = performance.now();
    return slot.el;
  }

  private releaseVideo(id: string): void {
    const slot = this.videos.get(id);
    if (!slot) return;
    slot.el.pause();
    slot.el.removeAttribute('src');
    slot.el.load();
    this.videos.delete(id);
  }

  private cleanupVideos(): void {
    const s = useEditor.getState();
    const ids = new Set(s.project.clips.map((c) => c.id));
    for (const id of [...this.videos.keys()]) if (!ids.has(id)) this.releaseVideo(id);
  }

  /** 時間 t に合わせて <video> 要素の位置や再生状態をそろえる */
  private syncVideos(t: number, playing: boolean): void {
    const s = useEditor.getState();
    const trackKinds = new Map(s.project.tracks.map((tr) => [tr.id, tr.kind]));
    const used = new Set<string>();
    for (const clip of s.project.clips) {
      if (clip.type !== 'media' || trackKinds.get(clip.trackId) !== 'video') continue;
      const asset = s.assets[clip.assetId];
      if (!asset || asset.kind !== 'video' || asset.status !== 'ready') continue;
      const [from, to] = clipVisibleRange(s.project, clip);
      const lookahead = playing ? 1.5 : 0;
      if (t < from - lookahead || t >= to) continue;
      used.add(clip.id);
      const el = this.getVideo(clip, asset);
      const maxSrc = Math.max(0, asset.duration - 0.04);
      if (t >= from) {
        const raw = sourceTimeAt(clip, t);
        const target = Math.min(maxSrc, Math.max(0, raw));
        // 素材の外側（切り替え効果で延びた部分で素材が足りないとき）は止めた絵を見せる
        const frozen = raw < 0 || raw > maxSrc;
        if (playing && !frozen) {
          const diff = el.currentTime - target;
          const tol = 0.04 * Math.max(1, clip.speed);
          if (el.paused) {
            if (Math.abs(diff) > 0.05 && !el.seeking) el.currentTime = target;
            el.playbackRate = clip.speed;
            el.play().catch(() => {});
          } else if (Math.abs(diff) > 0.5 * Math.max(1, clip.speed)) {
            el.currentTime = target;
          } else if (Math.abs(diff) > tol) {
            el.playbackRate = clip.speed * (diff > 0 ? 0.92 : 1.08);
          } else {
            el.playbackRate = clip.speed;
          }
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - target) > (playing ? 0.05 : 0.0005) && !(playing && el.seeking)) {
            el.currentTime = target;
          }
        }
      } else {
        // もうすぐ始まるクリップは先に頭出ししておく
        if (!el.paused) el.pause();
        const first = Math.min(maxSrc, Math.max(0, sourceTimeAt(clip, from)));
        if (Math.abs(el.currentTime - first) > 0.05 && !el.seeking) el.currentTime = first;
      }
    }
    const idle: [string, VideoSlot][] = [];
    for (const [id, slot] of this.videos) {
      if (used.has(id)) continue;
      if (!slot.el.paused) slot.el.pause();
      idle.push([id, slot]);
    }
    if (idle.length > MAX_IDLE_VIDEOS) {
      idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [id] of idle.slice(0, idle.length - MAX_IDLE_VIDEOS)) this.releaseVideo(id);
    }
  }

  requestRedraw(): void {
    if (this.redrawRaf) return;
    this.redrawRaf = requestAnimationFrame(() => {
      this.redrawRaf = 0;
      const s = useEditor.getState();
      if (s.playing) return; // 再生中は毎フレーム描いている
      // 最後まで再生したときは真っ黒にせず最後の場面を表示する
      const dur = projectDuration(s.project);
      const t = dur > 0 ? Math.min(s.currentTime, dur - 0.5 / FPS) : s.currentTime;
      this.syncVideos(t, false);
      this.draw(t);
    });
  }

  private draw(t: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = useEditor.getState();
    ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
    renderFrame(
      ctx,
      s.project,
      t,
      (clip) => {
        const asset = s.assets[clip.assetId];
        if (!asset || asset.status !== 'ready') return null;
        if (asset.kind === 'image') {
          return asset.image ? { image: asset.image, width: asset.image.width, height: asset.image.height } : null;
        }
        if (asset.kind === 'video') {
          const slot = this.videos.get(clip.id);
          if (slot && slot.el.readyState >= 2 && slot.el.videoWidth > 0) {
            return { image: slot.el, width: slot.el.videoWidth, height: slot.el.videoHeight, opaque: true };
          }
        }
        return null;
      },
      this.k,
      () => this.requestRedraw(),
    );
  }
}

export const player = new PlayerEngine();
