'use strict';

/**
 * Audio mixer for the shared stream. There is no microphone and no camera anywhere in the app:
 * the mix consists of the system sound (loopback) and/or the sound of individual applications that
 * the native helper captures. Everything ends up in one stereo track that is sent to all viewers.
 */

(function (root) {
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  class StfMixer {
    constructor() {
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      this.dest = this.ctx.createMediaStreamDestination();
      this.dest.channelCount = 2;
      this.dest.channelCountMode = 'explicit';

      // Master: soft limiter so that several loud apps cannot clip the mix
      this.master = this.ctx.createGain();
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.1;
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 1024;
      this.master.connect(this.limiter);
      this.limiter.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.dest);

      this.sysGain = this.ctx.createGain();
      this.sysAnalyser = this.ctx.createAnalyser();
      this.sysAnalyser.fftSize = 1024;
      this.sysGain.connect(this.sysAnalyser);
      this.sysAnalyser.connect(this.master);
      this.sysSource = null;
      this.sysStream = null;
      this.sysEnabled = true;

      this.apps = new Map(); // pid -> { name, node, gain, analyser }
      this.workletReady = null;
      this.buf = new Float32Array(1024);
    }

    get track() {
      return this.dest.stream.getAudioTracks()[0];
    }

    resume() {
      return this.ctx.state === 'running' ? Promise.resolve() : this.ctx.resume();
    }

    /** System-wide loopback from getDisplayMedia (null removes it). */
    setSystemStream(stream) {
      if (this.sysSource) {
        this.sysSource.disconnect();
        this.sysSource = null;
      }
      if (this.sysStream && this.sysStream !== stream) this.sysStream.getTracks().forEach((t) => t.stop());
      this.sysStream = stream;
      if (stream && stream.getAudioTracks().length) {
        this.sysSource = this.ctx.createMediaStreamSource(stream);
        this.sysSource.connect(this.sysGain);
      }
    }

    /** Off while individual apps are selected, so the mix does not contain everything twice. */
    setSystemEnabled(on) {
      this.sysEnabled = on;
      this.sysGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
    }

    async addApp(pid, name) {
      if (this.apps.has(pid)) return;
      if (!this.workletReady) this.workletReady = this.ctx.audioWorklet.addModule('pcm-worklet.js');
      await this.workletReady;
      if (this.apps.has(pid)) return;
      const node = new AudioWorkletNode(this.ctx, 'stf-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
      const gain = this.ctx.createGain();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      node.connect(gain);
      gain.connect(analyser);
      analyser.connect(this.master);
      this.apps.set(pid, { name, node, gain, analyser });
    }

    pushApp(pid, chunk) {
      const app = this.apps.get(pid);
      if (!app) return;
      const copy = new Uint8Array(chunk); // detached copy at offset 0 -> safe to view as Int16
      app.node.port.postMessage(new Int16Array(copy.buffer, 0, copy.byteLength >> 1), [copy.buffer]);
    }

    removeApp(pid) {
      const app = this.apps.get(pid);
      if (!app) return;
      app.node.disconnect();
      app.gain.disconnect();
      app.analyser.disconnect();
      this.apps.delete(pid);
    }

    /** Peak level 0..1 on a -60..0 dBFS scale. */
    level(analyser) {
      analyser.getFloatTimeDomainData(this.buf);
      let peak = 0;
      for (let i = 0; i < this.buf.length; i++) peak = Math.max(peak, Math.abs(this.buf[i]));
      if (peak <= 0.001) return 0;
      return clamp((20 * Math.log10(peak) + 60) / 60, 0, 1);
    }

    close() {
      this.setSystemStream(null);
      for (const pid of [...this.apps.keys()]) this.removeApp(pid);
      return this.ctx.close();
    }
  }

  root.StfMixer = StfMixer;
})(window);
