/**
 * AudioWorklet that plays raw PCM (48 kHz, stereo, signed 16-bit) pushed from the main thread.
 * Used for per-application audio captured by the native helper. A tiny jitter buffer keeps the
 * latency around 50 ms and drops old audio if the producer ever runs ahead.
 */

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000; // 1 s ring buffer per channel
    this.left = new Float32Array(this.cap);
    this.right = new Float32Array(this.cap);
    this.write = 0;
    this.read = 0;
    this.fill = 0;
    this.playing = false;
    this.startAt = 960; // 20 ms before (re)starting playback
    this.target = 2400; // 50 ms kept when trimming
    this.max = 9600; // 200 ms: above this the oldest audio is dropped

    this.port.onmessage = (event) => {
      const samples = event.data; // Int16Array, interleaved L/R
      const frames = samples.length >> 1;
      for (let i = 0; i < frames; i++) {
        this.left[this.write] = samples[2 * i] / 32768;
        this.right[this.write] = samples[2 * i + 1] / 32768;
        this.write = (this.write + 1) % this.cap;
      }
      this.fill += frames;
      if (this.fill > this.max) {
        const drop = this.fill - this.target;
        this.read = (this.read + drop) % this.cap;
        this.fill = this.target;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] || out[0];
    if (!this.playing && this.fill >= this.startAt) this.playing = true;

    for (let i = 0; i < l.length; i++) {
      if (this.playing && this.fill > 0) {
        l[i] = this.left[this.read];
        r[i] = this.right[this.read];
        this.read = (this.read + 1) % this.cap;
        this.fill--;
      } else {
        l[i] = 0;
        r[i] = 0;
        this.playing = false;
      }
    }
    return true;
  }
}

registerProcessor('stf-pcm', PcmProcessor);
