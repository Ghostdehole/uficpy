const RATE = 48000;
const CHANNELS = 2;
const MAGIC = 0x55464941;

function bytesOf(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function isAudioPacket(data) {
  const bytes = bytesOf(data);
  return !!bytes && bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) === MAGIC;
}

export function decodePCM(data) {
  const bytes = bytesOf(data);
  if (!isAudioPacket(bytes) || bytes.byteLength < 16 || bytes.byteLength > 4108 || (bytes.byteLength - 12) % 4) {
    throw new Error('无效 PCM 音频数据');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pts = view.getUint32(4) * 4294967296 + view.getUint32(8);
  if (!Number.isSafeInteger(pts)) throw new Error('音频时间戳超出范围');
  const frames = (bytes.byteLength - 12) / 4;
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i++) {
    channels[0][i] = view.getInt16(12 + i * 4, true) / 32768;
    channels[1][i] = view.getInt16(14 + i * 4, true) / 32768;
  }
  return {pts, frames, channels, sampleRate: RATE};
}

// AudioBufferSourceNode works on HTTP LAN pages, unlike AudioWorklet. Raw PCM
// bypasses browser audio-codec support. Playback is opt-in on every page load.
export class PCMPlayer {
  constructor({onState = () => {}, latencyMs = 60, maxBufferMs = 250, AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext} = {}) {
    if (!Number.isFinite(latencyMs) || !Number.isFinite(maxBufferMs) || latencyMs < 0 || maxBufferMs < 50 || maxBufferMs > 2000 || latencyMs >= maxBufferMs) {
      throw new Error('音频缓冲参数无效');
    }
    this.Context = AudioContext;
    this.onState = onState;
    this.latency = latencyMs / 1000;
    this.maxBuffer = maxBufferMs / 1000;
    this.context = null;
    this.gain = null;
    this.volume = 1;
    this.enabled = false;
    this.generation = 0;
    this.sources = new Set();
    this.anchorPTS = null;
    this.anchorTime = 0;
    this.lastPTS = null;
    this.nextTime = 0;
  }

  async enable() {
    const generation = ++this.generation;
    if (!this.Context) throw new Error('当前浏览器不支持 Web Audio');
    if (!this.context || this.context.state === 'closed') {
      this.context = new this.Context({latencyHint: 'interactive'});
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    await this.context.resume();
    // A second click, disconnect, or teardown may happen while resume awaits
    // the browser's permission. Never enable a player after it was disabled.
    if (generation !== this.generation) return;
    if (this.context.state !== 'running') throw new Error('浏览器暂停了音频，请再次点击开启声音');
    this.reset();
    this.enabled = true;
    this.onState('enabled', '声音已开启');
  }

  disable() {
    ++this.generation;
    this.enabled = false;
    this.reset();
    this.onState('disabled', '声音已关闭');
  }

  setVolume(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('播放音量应为 0..1');
    this.volume = value;
    if (this.gain) this.gain.gain.value = value;
  }

  reset() {
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.sources.clear();
    this.anchorPTS = null;
    this.lastPTS = null;
    this.nextTime = 0;
  }

  push(data) {
    if (!this.enabled || !this.context || this.context.state !== 'running') return false;
    const pcm = decodePCM(data);
    const now = this.context.currentTime;
    const duration = pcm.frames / RATE;
    // A restart can reset PTS. Re-anchor after a gap, underrun, clock drift,
    // or a network burst instead of accumulating increasingly delayed audio.
    let start = this.anchorPTS === null ? NaN : this.anchorTime + (pcm.pts - this.anchorPTS) / 1000000;
    if (!Number.isFinite(start) || (this.lastPTS !== null && pcm.pts <= this.lastPTS) || start < now - 0.05 || start + duration > now + this.maxBuffer || this.sources.size >= 64) {
      this.reset();
      this.anchorPTS = pcm.pts;
      this.anchorTime = now + this.latency;
      start = this.anchorTime;
    }
    start = Math.max(now, start, this.nextTime);
    if (start + duration > now + this.maxBuffer) {
      this.reset();
      this.anchorPTS = pcm.pts;
      this.anchorTime = now + this.latency;
      start = this.anchorTime;
    }
    const buffer = this.context.createBuffer(CHANNELS, pcm.frames, RATE);
    for (let channel = 0; channel < CHANNELS; channel++) buffer.getChannelData(channel).set(pcm.channels[channel]);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.sources.add(source);
    try {
      source.start(start);
    } catch (error) {
      this.sources.delete(source);
      source.disconnect();
      throw error;
    }
    this.lastPTS = pcm.pts;
    this.nextTime = start + duration;
    return true;
  }

  async close() {
    this.disable();
    const context = this.context;
    this.context = null;
    this.gain = null;
    if (context && context.state !== 'closed') await context.close();
  }
}
