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
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import { SAMPLE_RATE } from '../media/audio';
import { waitForAudio } from '../media/assets';
import { Asset, FPS, MediaClip, OUT_HEIGHT, OUT_WIDTH, Project, projectDuration } from '../model/types';
import { useEditor } from '../model/store';
import { renderFrame, VisualSource } from '../render/compositor';

export interface ExportProgress {
  /** 0〜1 */
  ratio: number;
  message: string;
}

export interface ExportResult {
  blob: Blob;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
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
  const trackKinds = new Map(project.tracks.map((t) => [t.id, t.kind]));
  for (const clip of project.clips) {
    if (clip.type !== 'media') continue;
    const kind = trackKinds.get(clip.trackId);
    if (kind !== 'video' && kind !== 'audio') continue;
    const buf = assets[clip.assetId]?.audioBuffer;
    if (!buf) continue;
    if (clip.inPoint >= buf.duration) continue;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.start(clip.start, clip.inPoint, clip.duration);
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

function isActiveAt(clip: MediaClip, t: number): boolean {
  return clip.start <= t + 1e-6 && t < clip.start + clip.duration - 1e-6;
}

/** このクリップが表示されるフレームごとの、素材の中での時間 */
function frameTimesForClip(clip: MediaClip, firstTimestamp: number): number[] {
  const from = Math.max(0, Math.floor(clip.start * FPS) - 1);
  const to = Math.ceil((clip.start + clip.duration) * FPS) + 1;
  const times: number[] = [];
  for (let f = from; f <= to; f++) {
    const t = f / FPS;
    if (isActiveAt(clip, t)) times.push(Math.max(firstTimestamp, clip.inPoint + (t - clip.start)));
  }
  return times;
}

async function openMediabunnyReader(clip: MediaClip, asset: Asset): Promise<ClipFrameReader> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(asset.file) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    input.dispose();
    throw new Error('no video track');
  }
  if (!(await track.canDecode())) {
    input.dispose();
    throw new Error('cannot decode');
  }
  const firstTs = await track.getFirstTimestamp();
  const sink = new CanvasSink(track, { poolSize: 3 });
  const times = frameTimesForClip(clip, firstTs);
  const iter = sink.canvasesAtTimestamps(times);
  let last: WrappedCanvas | null = null;
  return {
    async next() {
      const r = await iter.next();
      if (!r.done && r.value) last = r.value;
      if (!last) return null;
      return { image: last.canvas, width: last.canvas.width, height: last.canvas.height };
    },
    dispose() {
      iter.return(undefined).catch(() => {});
      input.dispose();
    },
  };
}

/** 予備の方法: <video> 要素を1フレームずつ動かして取り出す（遅いが多くの形式で動く） */
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
      const target = clip.inPoint + (t - clip.start);
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
      return { image: el, width: el.videoWidth, height: el.videoHeight };
    },
    dispose() {
      el.removeAttribute('src');
      el.load();
    },
  };
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
  const totalFrames = Math.max(1, Math.ceil(duration * FPS - 1e-6));
  const checkCancel = () => {
    if (signal.aborted) throw new ExportCanceled();
  };

  onProgress({ ratio: 0, message: '準備しています…' });
  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], {
    width: OUT_WIDTH,
    height: OUT_HEIGHT,
    quality: QUALITY_HIGH,
    frameRate: FPS,
  });
  if (!videoCodec) throw new Error('このブラウザでは 1920x1080 の映像を書き出せません');
  const audioCodec = await chooseAudioCodec();
  checkCancel();

  // 音声の解析が終わっていない素材を待つ
  const usedAssetIds = new Set(project.clips.flatMap((c) => (c.type === 'media' ? [c.assetId] : [])));
  onProgress({ ratio: 0, message: '音声を準備しています…' });
  for (const id of usedAssetIds) await waitForAudio(id);
  checkCancel();
  const latestAssets = { ...assets, ...useEditor.getState().assets };
  const mixed = await mixAudio(project, latestAssets, totalFrames / FPS);
  checkCancel();

  const canvas = document.createElement('canvas');
  canvas.width = OUT_WIDTH;
  canvas.height = OUT_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  if (!ctx) throw new Error('canvas が使えません');

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
  const audioSource = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  output.addAudioTrack(audioSource);

  const readers = new Map<string, ClipFrameReader>();
  const trackKinds = new Map(project.tracks.map((t) => [t.id, t.kind]));
  const videoClips = project.clips.filter(
    (c): c is MediaClip =>
      c.type === 'media' && trackKinds.get(c.trackId) === 'video' && latestAssets[c.assetId]?.kind === 'video',
  );

  const openReader = async (clip: MediaClip): Promise<ClipFrameReader> => {
    const asset = latestAssets[clip.assetId];
    try {
      return await openMediabunnyReader(clip, asset);
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
      const t = f / FPS;

      // 映像より少し先まで音声を入れておく（交互に入れるとメモリを使いすぎない）
      const audioUntil = Math.min(mixed.length, Math.ceil((t + 1) * SAMPLE_RATE));
      while (audioPos < audioUntil) {
        const to = Math.min(mixed.length, audioPos + audioChunk);
        await audioSource.add(sliceAudio(mixed, audioPos, to));
        audioPos = to;
      }

      // 必要な動画クリップの映像を取り出す
      const frames = new Map<string, VisualSource | null>();
      for (const clip of videoClips) {
        const end = clip.start + clip.duration;
        const active = isActiveAt(clip, t);
        let reader = readers.get(clip.id);
        if (active) {
          if (!reader) {
            reader = await openReader(clip);
            readers.set(clip.id, reader);
          }
          frames.set(clip.id, await reader.next(t));
        } else if (reader && t >= end - 1e-6) {
          reader.dispose();
          readers.delete(clip.id);
        }
      }

      renderFrame(ctx, project, t, (clip) => {
        const asset = latestAssets[clip.assetId];
        if (!asset) return null;
        if (asset.kind === 'image') {
          return asset.image ? { image: asset.image, width: asset.image.width, height: asset.image.height } : null;
        }
        return frames.get(clip.id) ?? null;
      });
      await videoSource.add(t, 1 / FPS);

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
  return { blob: new Blob([buffer], { type: 'video/mp4' }), videoCodec, audioCodec };
}
