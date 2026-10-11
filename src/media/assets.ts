// 素材ファイルの読み込み。ファイルはブラウザの中だけで扱い、どこにも送らない。
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { Asset, AssetKind, newId } from '../model/types';
import { patchAsset, showToast, upsertAsset } from '../model/store';
import { computePeaks, getAudioContext } from './audio';

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'weba'];

export const ACCEPT = 'video/*,image/*,audio/*,' + [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT].map((e) => '.' + e).join(',');

function detectKind(file: File): AssetKind | null {
  const t = file.type;
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

function waitEvent(el: HTMLMediaElement, ok: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('media error'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, timeoutMs);
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });
}

function makeThumbnail(source: CanvasImageSource, w: number, h: number): Promise<string | undefined> {
  const tw = 160;
  const th = 90;
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx || !w || !h) return Promise.resolve(undefined);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, tw, th);
  const scale = Math.min(tw / w, th / h);
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(source, (tw - dw) / 2, (th - dh) / 2, dw, dh);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : undefined), 'image/jpeg', 0.75);
  });
}

async function mediabunnyDuration(file: File): Promise<number | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const d = await input.computeDuration();
    return isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

async function loadVideo(asset: Asset): Promise<Partial<Asset> | 'audio-only'> {
  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  el.playsInline = true;
  el.src = asset.url;
  try {
    try {
      await waitEvent(el, 'loadeddata');
    } catch {
      throw new Error(`「${asset.name}」はこのブラウザで再生できない動画形式です`);
    }
    let duration = el.duration;
    if (!isFinite(duration) || duration <= 0) {
      duration = (await mediabunnyDuration(asset.file)) ?? NaN;
    }
    if (!isFinite(duration) || duration <= 0) throw new Error(`「${asset.name}」の長さを読み取れませんでした`);
    const width = el.videoWidth;
    const height = el.videoHeight;
    if (!width || !height) return 'audio-only';
    // サムネイル用に少し先の場面を表示する
    try {
      el.currentTime = Math.min(1, duration * 0.1);
      await waitEvent(el, 'seeked', 8000);
    } catch {
      /* サムネイルが作れなくても続ける */
    }
    const thumbnail = await makeThumbnail(el, width, height).catch(() => undefined);
    return { duration, width, height, thumbnail };
  } finally {
    el.removeAttribute('src');
    el.load();
  }
}

async function loadImage(asset: Asset): Promise<Partial<Asset>> {
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(asset.file);
  } catch {
    // SVG などは <img> 経由で読み込む
    const img = new Image();
    img.src = asset.url;
    try {
      await img.decode();
    } catch {
      throw new Error(`「${asset.name}」はこのブラウザで開けない画像形式です`);
    }
    const w = img.naturalWidth || 1920;
    const h = img.naturalHeight || 1080;
    image = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h });
  }
  const thumbnail = await makeThumbnail(image, image.width, image.height).catch(() => undefined);
  return { duration: Infinity, width: image.width, height: image.height, image, thumbnail };
}

/** 動画ファイルの中の音声を取り出す（取り出せないときは null） */
async function decodeAudioWithMediabunny(file: File): Promise<AudioBuffer | null | 'unsupported'> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    if (!(await input.canRead())) return 'unsupported';
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    if (!(await track.canDecode())) return 'unsupported';
    const channels = Math.max(1, track.numberOfChannels);
    const duration = await track.computeDuration();
    if (!isFinite(duration) || duration <= 0) return null;
    // 実際に取り出した音の細かさ（サンプルレート）に合わせて入れ物を作る
    let sr = 0;
    let length = 0;
    let out: AudioBuffer | null = null;
    const sink = new AudioBufferSink(track);
    for await (const wb of sink.buffers()) {
      const b = wb.buffer;
      if (!out) {
        sr = b.sampleRate;
        length = Math.ceil((duration + 0.05) * sr);
        out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: sr });
      } else if (b.sampleRate !== sr) {
        return 'unsupported';
      }
      let offset = Math.round(wb.timestamp * sr);
      let srcStart = 0;
      if (offset < 0) {
        srcStart = -offset;
        offset = 0;
      }
      if (offset >= length) continue;
      for (let c = 0; c < channels; c++) {
        const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
        const end = Math.min(src.length, srcStart + (length - offset));
        if (end > srcStart) out.copyToChannel(src.subarray(srcStart, end), c, offset);
      }
    }
    return out;
  } catch (e) {
    console.warn('mediabunny audio decode failed', e);
    return 'unsupported';
  } finally {
    input.dispose();
  }
}

async function decodeAudioWithWebAudio(file: File): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  return await getAudioContext().decodeAudioData(data);
}

// 音声の解析は重いので1つずつ順番に行う
let audioQueue: Promise<void> = Promise.resolve();
const audioWaiters = new Map<string, Promise<void>>();

function queueAudioDecode(asset: Asset): void {
  const job = audioQueue.then(async () => {
    try {
      let buffer: AudioBuffer | null = null;
      if (asset.kind === 'video') {
        const r = await decodeAudioWithMediabunny(asset.file);
        if (r === 'unsupported') {
          // 大きすぎるファイルは丸ごと読み込むとメモリが足りなくなるのでやめる
          if (asset.file.size < 700 * 1024 * 1024) {
            buffer = await decodeAudioWithWebAudio(asset.file).catch(() => null);
          }
        } else {
          buffer = r;
        }
      } else {
        try {
          buffer = await decodeAudioWithWebAudio(asset.file);
        } catch {
          const r = await decodeAudioWithMediabunny(asset.file);
          buffer = r === 'unsupported' ? null : r;
        }
      }
      if (buffer) {
        patchAsset(asset.id, { hasAudio: true, audioBuffer: buffer, peaks: computePeaks(buffer) });
      } else {
        patchAsset(asset.id, { hasAudio: false });
        if (asset.kind === 'audio') {
          patchAsset(asset.id, { status: 'error', error: '音声を読み取れませんでした' });
          showToast(`「${asset.name}」の音声を読み取れませんでした`, 'error');
        }
      }
    } catch (e) {
      console.warn('audio decode failed', e);
      patchAsset(asset.id, { hasAudio: false });
    }
  });
  audioQueue = job;
  audioWaiters.set(asset.id, job);
}

/** 音声の解析が終わるまで待つ（書き出しの前に使う） */
export async function waitForAudio(assetId: string): Promise<void> {
  await audioWaiters.get(assetId);
}

async function loadAudioMeta(asset: Asset): Promise<Partial<Asset>> {
  const el = document.createElement('audio');
  el.preload = 'metadata';
  el.src = asset.url;
  try {
    await waitEvent(el, 'loadedmetadata');
  } catch {
    throw new Error(`「${asset.name}」はこのブラウザで再生できない音声形式です`);
  }
  let duration = el.duration;
  if (!isFinite(duration) || duration <= 0) duration = (await mediabunnyDuration(asset.file)) ?? NaN;
  if (!isFinite(duration) || duration <= 0) throw new Error(`「${asset.name}」の長さを読み取れませんでした`);
  el.removeAttribute('src');
  return { duration };
}

async function importOne(file: File): Promise<Asset | null> {
  let kind = detectKind(file);
  if (!kind) {
    showToast(`「${file.name}」は読み込めない種類のファイルです`, 'error');
    return null;
  }
  const asset: Asset = {
    id: newId('asset'),
    name: file.name,
    kind,
    file,
    url: URL.createObjectURL(file),
    status: 'loading',
    duration: 0,
    width: 0,
    height: 0,
  };
  upsertAsset(asset);
  try {
    let patch: Partial<Asset>;
    if (kind === 'video') {
      const r = await loadVideo(asset);
      if (r === 'audio-only') {
        kind = 'audio';
        patch = { kind, ...(await loadAudioMeta({ ...asset, kind })) };
      } else {
        patch = r;
      }
    } else if (kind === 'image') {
      patch = await loadImage(asset);
    } else {
      patch = await loadAudioMeta(asset);
    }
    const ready: Asset = { ...asset, ...patch, kind, status: 'ready' };
    upsertAsset(ready);
    if (kind !== 'image') queueAudioDecode(ready);
    return ready;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    patchAsset(asset.id, { status: 'error', error: msg });
    showToast(msg, 'error');
    return null;
  }
}

/** ファイルをまとめて読み込む。読み込めた素材を返す */
export async function importFiles(files: File[]): Promise<Asset[]> {
  const out: Asset[] = [];
  for (const f of files) {
    const a = await importOne(f);
    if (a) out.push(a);
  }
  return out;
}
