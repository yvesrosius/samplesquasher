/* ============================================================================
 * Audio engine for Stem Squash.
 *
 * Renders a track's assigned samples into a single WAV: decode each source,
 * overlay-mix them (sum, length = longest source), normalize the result to
 * −0.3 dBFS, then encode to 16-bit / 24-bit PCM or 32-bit float ("source").
 *
 * All decoding/processing runs through a single OfflineAudioContext used as a
 * decode + buffer factory — `decodeAudioData` resamples every source to a
 * common sample rate, so mixing never has to resample by hand, and no user
 * gesture / autoplay permission is needed (nothing is ever played back here).
 * Demo samples (no real audio file) are synthesized deterministically so the
 * export produces audible content out of the box.
 * ==========================================================================*/

export interface SampleAudio {
  id: string;
  name: string;
  dur: number;
  url?: string;
}

export type Format = '16' | '24' | 'source';

/** Target peak for normalization: −0.3 dBFS. */
const TARGET = Math.pow(10, -0.3 / 20);
const SAMPLE_RATE = 44100;

let _ctx: OfflineAudioContext | null = null;
function engineCtx(): OfflineAudioContext {
  if (_ctx) return _ctx;
  const Ctor = (window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext) as typeof OfflineAudioContext;
  _ctx = new Ctor(2, 1, SAMPLE_RATE);
  return _ctx;
}

const cache = new Map<string, AudioBuffer>();

function seed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic percussive/tonal buffer for demo samples that have no file. */
function synth(ctx: OfflineAudioContext, sample: SampleAudio): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor((sample.dur || 1) * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  let a = seed(sample.name) || 1;
  const rnd = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const freq = 60 + rnd() * 340;
  const decay = 3 + rnd() * 6;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t * decay);
    const tone = Math.sin(2 * Math.PI * freq * t);
    const noise = rnd() * 2 - 1;
    d[i] = (tone * 0.6 + noise * 0.4) * env * 0.7;
  }
  return buf;
}

async function decodeSample(ctx: OfflineAudioContext, sample: SampleAudio): Promise<AudioBuffer> {
  const hit = cache.get(sample.id);
  if (hit) return hit;
  let buf: AudioBuffer;
  if (sample.url) {
    try {
      const ab = await (await fetch(sample.url)).arrayBuffer();
      buf = await ctx.decodeAudioData(ab);
    } catch {
      buf = synth(ctx, sample);
    }
  } else {
    buf = synth(ctx, sample);
  }
  cache.set(sample.id, buf);
  return buf;
}

function mixBuffers(ctx: OfflineAudioContext, bufs: AudioBuffer[]): AudioBuffer {
  if (!bufs.length) return ctx.createBuffer(1, 1, ctx.sampleRate);
  const outCh = Math.max(1, ...bufs.map((b) => b.numberOfChannels));
  const len = Math.max(1, ...bufs.map((b) => b.length));
  const out = ctx.createBuffer(outCh, len, ctx.sampleRate);
  for (const b of bufs) {
    for (let c = 0; c < outCh; c++) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      const dst = out.getChannelData(c);
      const n = b.length;
      for (let i = 0; i < n; i++) dst[i] += src[i];
    }
  }
  return out;
}

function normalize(buffer: AudioBuffer): AudioBuffer {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0) {
    const g = TARGET / peak;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }
  return buffer;
}

function encodeWav(buffer: AudioBuffer, format: Format): Uint8Array {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const sampleRate = buffer.sampleRate;
  const isFloat = format === 'source';
  const bits = format === '16' ? 16 : format === '24' ? 24 : 32;
  const bytesPer = bits / 8;
  const blockAlign = numCh * bytesPer;
  const dataSize = len * blockAlign;

  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  let p = 0;
  const wstr = (s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i));
  };
  const u32 = (v: number) => {
    dv.setUint32(p, v, true);
    p += 4;
  };
  const u16 = (v: number) => {
    dv.setUint16(p, v, true);
    p += 2;
  };

  wstr('RIFF');
  u32(36 + dataSize);
  wstr('WAVE');
  wstr('fmt ');
  u32(16);
  u16(isFloat ? 3 : 1); // 3 = IEEE float, 1 = PCM
  u16(numCh);
  u32(sampleRate);
  u32(sampleRate * blockAlign);
  u16(blockAlign);
  u16(bits);
  wstr('data');
  u32(dataSize);

  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));

  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let v = chans[c][i];
      if (isFloat) {
        dv.setFloat32(p, v, true);
        p += 4;
      } else if (bits === 16) {
        v = Math.max(-1, Math.min(1, v));
        dv.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        p += 2;
      } else {
        v = Math.max(-1, Math.min(1, v));
        let s = Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff);
        if (s > 0x7fffff) s = 0x7fffff;
        if (s < -0x800000) s = -0x800000;
        s &= 0xffffff;
        dv.setUint8(p++, s & 0xff);
        dv.setUint8(p++, (s >> 8) & 0xff);
        dv.setUint8(p++, (s >> 16) & 0xff);
      }
    }
  }
  return new Uint8Array(ab);
}

/** Decode → overlay-mix → normalize → encode one track's samples to a WAV. */
export async function renderTrackWav(samples: SampleAudio[], format: Format): Promise<Uint8Array> {
  const ctx = engineCtx();
  const bufs: AudioBuffer[] = [];
  for (const s of samples) bufs.push(await decodeSample(ctx, s));
  const mixed = normalize(mixBuffers(ctx, bufs));
  return encodeWav(mixed, format);
}
