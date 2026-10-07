// BeatClock — the song, the metronome and all sound effects.
//
// Everything is synthesised with the Web Audio API so the game ships with
// zero audio files. The clock is the single source of truth for musical
// time: targets are launched so that they peak exactly on a beat tick, and
// slice timing is judged against the same clock.

const LOOKAHEAD = 0.2;      // seconds of drum hits scheduled ahead of time
const TICKS_PER_BEAT = 4;   // we think in 16th notes
const TICKS_PER_BAR = 16;

export class BeatClock {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.bpm = 120;
    this.startTime = 0;
    this.running = false;
    this.nextTick = 0;
    this.timer = null;
    this.noise = null;
  }

  get beatLen() { return 60 / this.bpm; }
  get tickLen() { return this.beatLen / TICKS_PER_BEAT; }
  static get TICKS_PER_BEAT() { return TICKS_PER_BEAT; }
  static get TICKS_PER_BAR() { return TICKS_PER_BAR; }

  /** Must be called from a user gesture the first time (autoplay policy). */
  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  start(bpm) {
    this.ensureContext();
    this.bpm = bpm;
    this.startTime = this.ctx.currentTime + 0.2;
    this.nextTick = 0;
    this.running = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.scheduleAhead(), 25);
    this.scheduleAhead();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  pause() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  /** Seconds since the first beat. Negative during the count-in gap. */
  now() { return this.ctx ? this.ctx.currentTime - this.startTime : 0; }

  /** Absolute song time (seconds) of a given 16th-note tick. */
  tickTime(tick) { return tick * this.tickLen; }

  /** 0..1 progress through the current beat — drives the visual pulse. */
  beatPhase() {
    const t = this.now();
    if (t < 0) return 0;
    return (t / this.beatLen) % 1;
  }

  scheduleAhead() {
    if (!this.running) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    while (this.startTime + this.tickTime(this.nextTick) < horizon) {
      const t = this.startTime + this.tickTime(this.nextTick);
      const inBar = this.nextTick % TICKS_PER_BAR;
      if (inBar % 4 === 0) this.kick(t, inBar === 0 ? 1 : 0.85);
      if (inBar === 4 || inBar === 12) this.snare(t);
      if (inBar % 2 === 0) this.hat(t, inBar % 4 === 0 ? 0.22 : 0.1);
      if (inBar === 14) this.hat(t + this.tickLen * 0.5, 0.08);
      this.nextTick++;
    }
  }

  // ---------------------------------------------------------------- drums

  noiseBuffer() {
    if (this.noise) return this.noise;
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  kick(t, vol = 1) {
    const c = this.ctx;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  snare(t) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuffer();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.2);

    const osc = c.createOscillator();
    const og = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190, t);
    og.gain.setValueAtTime(0.35, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  hat(t, vol) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuffer();
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    src.connect(hp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.06);
  }

  // ------------------------------------------------------------------ sfx

  slice() {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuffer();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(5000, t + 0.08);
    const g = c.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.14);
  }

  perfect() {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    [880, 1320].forEach((f, i) => {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'square';
      osc.frequency.value = f;
      const at = t + i * 0.05;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.12);
      osc.connect(g).connect(this.master);
      osc.start(at);
      osc.stop(at + 0.14);
    });
  }

  explode() {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuffer();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.5);
    const g = c.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.6);

    const osc = c.createOscillator();
    const og = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.4);
    og.gain.setValueAtTime(0.8, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  miss() {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.25);
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);
  }
}
