// MP4 への書き出し。すべてブラウザの中で行う（WebCodecs + Mediabunny）。
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import { SAMPLE_RATE } from '../media/audio';
import { waitForAudio } from '../media/assets';
import { clipHasSound, scheduleClipAudio } from '../media/mix';
import { clipVisibleRange } from '../model/ops';
import { useEditor } from '../model/store';
import { Asset, MediaClip, Project, exportSize, projectDuration, sourceTimeAt } from '../model/types';
import { renderFrame, VisualSource } from '../render/compositor';
import { ensureFont } from '../render/fonts';

export interface ExportProgress {
  /** 0〜1 */
  ratio: number;
  message: string;
}

export interface ExportResult {
  blob: Blob;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  width: number;
  height: number;
}

export class ExportCanceled extends Error {
  constructor() {
    super('canceled');
  }
}

export function canExportInThisBrowser(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
}

let aacRegistered = false;

async function chooseAudioCodec(): Promise<AudioCodec> {
  const opts = { numberOfChannels: 2, sampleRate: SAMPLE_RATE, quality: QUALITY_HIGH };
  if (await canEncodeAudio('aac', opts)) return 'aac';
  // ブラウザが AAC を作れない場合は、AAC を作る部品を読み込んで使う
  try {
    if (!aacRegistered) {
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
      registerAacEncoder();
      aacRegistered = true;
    }
    if (await canEncodeAudio('aac', opts)) return 'aac';
  } catch (e) {
    console.warn('AAC encoder extension failed', e);
  }
  if (await canEncodeAudio('opus', opts)) return 'opus';
  throw new Error('このブラウザでは音声を書き出せません');
}

/** すべての音を1本に混ぜる */
async function mixAudio(project: Project, assets: Record<string, Asset>, duration: number): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: SAMPLE_RATE });
  for (const clip of project.clips) {
    if (clip.type !== 'media') continue;
    const asset = assets[clip.assetId];
    if (!clipHasSound(project, clip, asset)) continue;
    scheduleClipAudio(ctx, ctx.destination, clip, asset.audioBuffer!, 0, 0);
  }
  return await ctx.startRendering();
}

function sliceAudio(buf: AudioBuffer, from: number, to: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: to - from, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.copyToChannel(buf.getChannelData(c).subarray(from, to), c);
  }
  return out;
}

/** 書き出し中に1つの動画クリップの映像を順番に取り出す */
interface ClipFrameReader {
  next(t: number): Promise<VisualSource | null>;
  dispose(): void;
}

/** 書き出しのコマ f にそのクリップが画面に出ているか */
function makeActivePredicate(project: Project, clip: MediaClip): (t: number) => boolean {
  const [from, to] = clipVisibleRange(project, clip);
  return (t) => from <= t + 1e-6 && t < to - 1e-6;
}

/** 素材の中での時間（範囲の外は端の絵で止める） */
function clampedSourceTime(clip: MediaClip, t: number, firstTs: number, srcDur: number): number {
  return Math.min(Math.max(firstTs, sourceTimeAt(clip, t)), Math.max(firstTs, srcDur - 0.001));
}

async function openMediabunnyReader(
  clip: MediaClip,
  asset: Asset,
  frameTimes: number[],
): Promise<ClipFrameReader> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(asset.file) });
  let iter: AsyncGenerator<WrappedCanvas | null, void, unknown>;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    if (!(await track.canDecode())) throw new Error('cannot decode');
    const firstTs = await track.getFirstTimestamp();
    const sink = new CanvasSink(track, { poolSize: 3 });
    iter = sink.canvasesAtTimestamps(frameTimes.map((t) => clampedSourceTime(clip, t, firstTs, asset.duration)));
  } catch (e) {
    input.dispose();
    throw e;
  }
  let last: WrappedCanvas | null = null;
  return {
    async next() {
      const r = await iter.next();
      if (!r.done && r.value) last = r.value;
      if (!last) return null;
      return { image: last.canvas, width: last.canvas.width, height: last.canvas.height, opaque: true };
    },
    dispose() {
      iter.return(undefined).catch(() => {});
      input.dispose();
    },
  };
}

/** 予備の方法: <video> 要素を1コマずつ動かして取り出す（遅いが多くの形式で動く） */
async function openElementReader(clip: MediaClip, asset: Asset): Promise<ClipFrameReader> {
  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  el.src = asset.url;
  await new Promise<void>((resolve, reject) => {
    el.addEventListener('loadeddata', () => resolve(), { once: true });
    el.addEventListener('error', () => reject(new Error('video load error')), { once: true });
  });
  return {
    async next(t: number) {
      const target = clampedSourceTime(clip, t, 0, asset.duration);
      if (Math.abs(el.currentTime - target) > 0.0005) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          el.addEventListener(
            'seeked',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          el.currentTime = target;
        });
      }
      return { image: el, width: el.videoWidth, height: el.videoHeight, opaque: true };
    },
    dispose() {
      el.removeAttribute('src');
      el.load();
    },
  };
}

/** 文字に使うフォントを先に読み込んでおく */
async function prepareFonts(project: Project): Promise<void> {
  const jobs: Promise<boolean>[] = [];
  for (const c of project.clips) {
    if (c.type === 'text' && c.text) jobs.push(ensureFont(c.fontFamily, c.bold, c.text));
  }
  await Promise.all(jobs);
}

export async function exportProject(
  project: Project,
  assets: Record<string, Asset>,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  if (!canExportInThisBrowser()) {
    throw new Error('このブラウザは書き出しに対応していません。最新の Google Chrome を使ってください。');
  }
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('タイムラインが空です');
  const { width: outW, height: outH, scale } = exportSize(project.settings);
  const fps = project.settings.export.fps;
  const quality =
    project.settings.export.quality === 'max'
      ? QUALITY_VERY_HIGH
      : project.settings.export.quality === 'standard'
        ? QUALITY_MEDIUM
        : QUALITY_HIGH;
  const totalFrames = Math.max(1, Math.ceil(duration * fps - 1e-6));
  const checkCancel = () => {
    if (signal.aborted) throw new ExportCanceled();
  };

  onProgress({ ratio: 0, message: '準備しています…' });
  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'hevc'], {
    width: outW,
    height: outH,
    quality,
    frameRate: fps,
  });
  if (!videoCodec) throw new Error(`このパソコンでは ${outW}×${outH} の映像を書き出せません。解像度を下げてください。`);
  const audioCodec = await chooseAudioCodec();
  checkCancel();

  // 音声の解析が終わっていない素材を待つ
  const usedAssetIds = new Set(project.clips.flatMap((c) => (c.type === 'media' ? [c.assetId] : [])));
  onProgress({ ratio: 0, message: '音声を準備しています…' });
  for (const id of usedAssetIds) await waitForAudio(id);
  checkCancel();
  const latestAssets = { ...assets, ...useEditor.getState().assets };
  const mixed = await mixAudio(project, latestAssets, totalFrames / fps);
  checkCancel();
  onProgress({ ratio: 0, message: 'フォントを準備しています…' });
  await prepareFonts(project);
  checkCancel();

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('canvas が使えません');

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality, keyFrameInterval: 2 });
  const audioSource = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
  output.addVideoTrack(videoSource, { frameRate: fps });
  output.addAudioTrack(audioSource);

  const readers = new Map<string, ClipFrameReader>();
  const trackKinds = new Map(project.tracks.map((t) => [t.id, t.kind]));
  const videoClips = project.clips
    .filter(
      (c): c is MediaClip =>
        c.type === 'media' && trackKinds.get(c.trackId) === 'video' && latestAssets[c.assetId]?.kind === 'video',
    )
    .map((clip) => {
      const active = makeActivePredicate(project, clip);
      const times: number[] = [];
      for (let f = 0; f < totalFrames; f++) if (active(f / fps)) times.push(f / fps);
      const last = times.length ? times[times.length - 1] : -1;
      return { clip, active, times, last };
    });

  const openReader = async (clip: MediaClip, times: number[]): Promise<ClipFrameReader> => {
    const asset = latestAssets[clip.assetId];
    try {
      return await openMediabunnyReader(clip, asset, times);
    } catch (e) {
      console.warn('mediabunny reader failed, falling back to <video>', e);
      return await openElementReader(clip, asset);
    }
  };

  try {
    await output.start();
    let audioPos = 0; // 追加済みの音声（サンプル数）
    const audioChunk = SAMPLE_RATE; // 1秒ずつ

    for (let f = 0; f < totalFrames; f++) {
      checkCancel();
      const t = f / fps;

      // 映像より少し先まで音声を入れておく（交互に入れるとメモリを使いすぎない）
      const audioUntil = Math.min(mixed.length, Math.ceil((t + 1) * SAMPLE_RATE));
      while (audioPos < audioUntil) {
        const to = Math.min(mixed.length, audioPos + audioChunk);
        await audioSource.add(sliceAudio(mixed, audioPos, to));
        audioPos = to;
      }

      // 必要な動画クリップの映像を取り出す
      const frames = new Map<string, VisualSource | null>();
      const finished: string[] = [];
      for (const v of videoClips) {
        if (!v.active(t)) continue;
        let reader = readers.get(v.clip.id);
        if (!reader) {
          reader = await openReader(v.clip, v.times);
          readers.set(v.clip.id, reader);
        }
        frames.set(v.clip.id, await reader.next(t));
        if (Math.abs(t - v.last) < 1e-9) finished.push(v.clip.id);
      }

      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      renderFrame(
        ctx,
        project,
        t,
        (clip) => {
          const asset = latestAssets[clip.assetId];
          if (!asset) return null;
          if (asset.kind === 'image') {
            return asset.image ? { image: asset.image, width: asset.image.width, height: asset.image.height } : null;
          }
          return frames.get(clip.id) ?? null;
        },
        scale,
      );
      await videoSource.add(t, 1 / fps);
      // 最後のコマを使い終わったクリップは片付ける
      for (const id of finished) {
        readers.get(id)?.dispose();
        readers.delete(id);
      }

      if (f % 5 === 0 || f === totalFrames - 1) {
        onProgress({ ratio: (f + 1) / totalFrames, message: '書き出しています…' });
      }
    }
    while (audioPos < mixed.length) {
      const to = Math.min(mixed.length, audioPos + audioChunk);
      await audioSource.add(sliceAudio(mixed, audioPos, to));
      audioPos = to;
    }
    checkCancel();
    onProgress({ ratio: 1, message: '仕上げています…' });
    await output.finalize();
  } catch (e) {
    for (const r of readers.values()) r.dispose();
    readers.clear();
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    throw e;
  }
  for (const r of readers.values()) r.dispose();

  const buffer = target.buffer;
  if (!buffer) throw new Error('書き出しに失敗しました');
  return { blob: new Blob([buffer], { type: 'video/mp4' }), videoCodec, audioCodec, width: outW, height: outH };
}
