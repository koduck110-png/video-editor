// 音声関係の共通処理
import { PEAKS_PER_SEC } from '../model/types';

export const SAMPLE_RATE = 48000;

let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch {
      ctx = new AudioContext();
    }
  }
  return ctx;
}

/** 波形表示用に、一定間隔ごとの音の大きさ（最大値）を求める */
export function computePeaks(buffer: AudioBuffer): Float32Array {
  const step = Math.max(1, Math.floor(buffer.sampleRate / PEAKS_PER_SEC));
  const count = Math.ceil(buffer.length / step);
  const peaks = new Float32Array(count);
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(buffer.numberOfChannels, 2); c++) channels.push(buffer.getChannelData(c));
  for (let i = 0; i < count; i++) {
    let max = 0;
    const from = i * step;
    const to = Math.min(buffer.length, from + step);
    for (const data of channels) {
      // 全部見ると重いので間引いて調べる
      for (let j = from; j < to; j += 4) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
    }
    peaks[i] = Math.min(1, max);
  }
  return peaks;
}
