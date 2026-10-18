import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodePCM, isAudioPacket, PCMPlayer} from '../web/audio.mjs';

function packet(pts = 0, frames = 1024) {
  const bytes = new Uint8Array(12 + frames * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x55464941);
  view.setBigUint64(4, BigInt(pts));
  for (let i = 0; i < frames; i++) {
    view.setInt16(12 + i * 4, -32768, true);
    view.setInt16(14 + i * 4, 32767, true);
  }
  return bytes;
}

class AudioContextMock {
  constructor() { this.currentTime = 0; this.state = 'suspended'; this.destination = {}; this.created = []; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createGain() { this.gain = {gain: {value: 1}, connect() {}}; return this.gain; }
  createBuffer(channels, frames, rate) {
    const data = Array.from({length: channels}, () => new Float32Array(frames));
    return {rate, duration: frames / rate, getChannelData: index => data[index]};
  }
  createBufferSource() {
    const source = {connect() {}, disconnect() { this.disconnected = true; }, start(time) { this.time = time; }, stop() { this.stopped = true; }};
    this.created.push(source);
    return source;
  }
}

test('PCM framing preserves signed little-endian stereo and 64-bit microsecond PTS', () => {
  const original = packet(1234567890123, 1);
  const padded = new Uint8Array(original.length + 7);
  padded.set(original, 7);
  const pcm = decodePCM(padded.subarray(7));
  assert.equal(pcm.pts, 1234567890123);
  assert.equal(pcm.sampleRate, 48000);
  assert.equal(pcm.channels[0][0], -1);
  assert.equal(pcm.channels[1][0], 32767 / 32768);
  assert.ok(isAudioPacket(original.buffer));
  assert.equal(isAudioPacket(new Uint8Array([0x40, 0, 0, 0])), false);
  for (const bad of [null, new Uint8Array(), original.subarray(0, 12), original.subarray(0, 15), packet(0, 1025)]) assert.throws(() => decodePCM(bad), /PCM/);
  const hugeTimestamp = packet();
  new DataView(hugeTimestamp.buffer).setBigUint64(4, 9007199254740992n);
  assert.throws(() => decodePCM(hugeTimestamp), /时间戳/);
});

test('audio is never played before the explicit enable action; volume is browser-only', async () => {
  const player = new PCMPlayer({AudioContext: AudioContextMock});
  assert.equal(player.push(packet()), false);
  assert.equal(player.context, null);
  player.setVolume(0.2);
  await player.enable();
  assert.equal(player.context.gain.gain.value, 0.2);
  assert.equal(player.push(packet(1000000)), true);
  assert.equal(player.context.created[0].time, 0.06);
  assert.equal(player.context.created[0].buffer.rate, 48000);
  assert.equal(player.context.created[0].buffer.getChannelData(0)[0], -1);
  const source = player.context.created[0];
  source.onended();
  assert.equal(player.sources.size, 0);
  assert.ok(source.disconnected);
  player.disable();
  assert.equal(player.push(packet()), false);
  for (const value of [-1, 2, NaN]) assert.throws(() => player.setVolume(value));
  await player.close();
  assert.equal(player.context, null);
});

test('bursts, PTS reset, suspension and underruns cannot accumulate an audio backlog', async () => {
  const player = new PCMPlayer({AudioContext: AudioContextMock});
  await player.enable();
  for (let i = 0; i < 1000; i++) {
    player.push(packet(1000000 + i * 21333));
    assert.ok(player.nextTime <= player.context.currentTime + 0.25);
    assert.ok(player.sources.size <= 12);
  }
  const old = [...player.sources];
  player.push(packet(0));
  assert.ok(old.every(source => source.stopped && source.disconnected));
  assert.equal(player.anchorPTS, 0);
  player.context.currentTime = 10;
  player.push(packet(21333));
  assert.equal(player.context.created.at(-1).time, 10.06);
  player.context.state = 'suspended';
  assert.equal(player.push(packet(42666)), false);
  player.reset();
  assert.equal(player.sources.size, 0);
  await player.close();
});

test('disabling while browser resume awaits never re-enables playback', async () => {
  let resumed;
  class DelayedContext extends AudioContextMock {
    resume() { return new Promise(resolve => { resumed = () => { this.state = 'running'; resolve(); }; }); }
  }
  const player = new PCMPlayer({AudioContext: DelayedContext});
  const pending = player.enable();
  player.disable();
  resumed();
  await pending;
  assert.equal(player.enabled, false);
  assert.equal(player.push(packet()), false);
  await player.close();
});

test('missing or blocked Web Audio gives an actionable error', async () => {
  const absent = new PCMPlayer({AudioContext: null});
  await assert.rejects(absent.enable(), /Web Audio/);
  class BlockedContext extends AudioContextMock { async resume() {} }
  const blocked = new PCMPlayer({AudioContext: BlockedContext});
  await assert.rejects(blocked.enable(), /再次点击/);
  assert.equal(blocked.enabled, false);
  await blocked.close();
});
