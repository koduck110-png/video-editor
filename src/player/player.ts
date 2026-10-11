// プレビューの再生を担当する。映像は <video> 要素、音は Web Audio で鳴らし、
// 音の時計に映像を合わせる。
import { getAudioContext } from '../media/audio';
import { setPlaying, useEditor } from '../model/store';
import { Asset, MediaClip, OUT_HEIGHT, OUT_WIDTH, projectDuration, snapToFrame } from '../model/types';
import { renderFrame } from '../render/compositor';

export const PREVIEW_W = 1280;
export const PREVIEW_H = 720;

interface VideoSlot {
  el: HTMLVideoElement;
  assetId: string;
  lastUsed: number;
}

const MAX_IDLE_VIDEOS = 8;

class PlayerEngine {
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

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.unsub = useEditor.subscribe((s, prev) => {
      if (s.playing !== prev.playing) {
        if (s.playing) this.startPlayback();
        else this.stopPlayback();
      } else if (s.currentTime !== prev.currentTime && !this.selfUpdate) {
        if (s.playing) this.restartFrom(s.currentTime);
        else this.requestRedraw();
      }
      if (s.project !== prev.project || s.assets !== prev.assets) {
        this.cleanupVideos();
        if (s.playing) this.restartFrom(this.now());
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
    this.stopAudio();
    for (const id of [...this.videos.keys()]) this.releaseVideo(id);
    this.ctx = null;
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
      v.el.playbackRate = 1;
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
    const trackKinds = new Map(s.project.tracks.map((tr) => [tr.id, tr.kind]));
    for (const clip of s.project.clips) {
      if (clip.type !== 'media') continue;
      const kind = trackKinds.get(clip.trackId);
      if (kind !== 'video' && kind !== 'audio') continue;
      const asset = s.assets[clip.assetId];
      const buf = asset?.audioBuffer;
      if (!buf) continue;
      const end = clip.start + clip.duration;
      if (end <= t) continue;
      const skip = Math.max(0, t - clip.start);
      const offset = clip.inPoint + skip;
      const dur = clip.duration - skip;
      if (offset >= buf.duration || dur <= 0) continue;
      const node = ac.createBufferSource();
      node.buffer = buf;
      node.connect(dest);
      node.start(when + Math.max(0, clip.start - t), offset, dur);
      this.audioNodes.push(node);
    }
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
      const end = clip.start + clip.duration;
      const lookahead = playing ? 1.5 : 0;
      if (t < clip.start - lookahead || t >= end) continue;
      used.add(clip.id);
      const el = this.getVideo(clip, asset);
      if (t >= clip.start) {
        const target = clip.inPoint + (t - clip.start);
        if (playing) {
          const diff = el.currentTime - target;
          if (el.paused) {
            if (Math.abs(diff) > 0.05 && !el.seeking) el.currentTime = target;
            el.playbackRate = 1;
            el.play().catch(() => {});
          } else if (Math.abs(diff) > 0.5) {
            el.currentTime = target;
          } else if (Math.abs(diff) > 0.04) {
            el.playbackRate = diff > 0 ? 0.92 : 1.08;
          } else {
            el.playbackRate = 1;
          }
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - target) > 0.0005) el.currentTime = target;
        }
      } else {
        // もうすぐ始まるクリップは先に頭出ししておく
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - clip.inPoint) > 0.05 && !el.seeking) el.currentTime = clip.inPoint;
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
      this.syncVideos(s.currentTime, false);
      this.draw(s.currentTime);
    });
  }

  private draw(t: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = useEditor.getState();
    ctx.setTransform(PREVIEW_W / OUT_WIDTH, 0, 0, PREVIEW_H / OUT_HEIGHT, 0, 0);
    renderFrame(ctx, s.project, t, (clip) => {
      const asset = s.assets[clip.assetId];
      if (!asset || asset.status !== 'ready') return null;
      if (asset.kind === 'image') {
        return asset.image ? { image: asset.image, width: asset.image.width, height: asset.image.height } : null;
      }
      if (asset.kind === 'video') {
        const slot = this.videos.get(clip.id);
        if (slot && slot.el.readyState >= 2 && slot.el.videoWidth > 0) {
          return { image: slot.el, width: slot.el.videoWidth, height: slot.el.videoHeight };
        }
      }
      return null;
    });
  }
}

export const player = new PlayerEngine();
