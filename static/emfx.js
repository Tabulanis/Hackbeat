/* emfx.js — the sample editor's effects rack (2026-10-02).
 *
 * One sample, turned into another: every effect renders offline, then is
 * blended with the original along the ENVELOPE — a line drawn over the
 * waveform that says how much of the effect is in at each moment (flat =
 * all the way through; fade in, swell, pulses...). Works the same for every
 * effect, so any of them can come in, go out, or pulse.
 *
 * Applies to the dragged selection if there is one (its tail rings on into
 * what follows), otherwise to the whole sample. Preview plays the result
 * without keeping it; Apply keeps it (Undo takes it back).
 *
 * An effect: { name, group, params: [{label, min, max, step, def, fmt}],
 *              stereo?, tail?(p, dur) seconds of ring-out,
 *              build?(oc, input, p, buf) -> output node (offline graph),
 *              pre?(chs, sr, p) / js?(chs, sr, p) in-place on Float32Arrays }
 */
(function () {
  "use strict";
  const hz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v)) + "Hz";
  const pct = (v) => Math.round(v * 100) + "%";
  const db = (v) => (v > 0 ? "+" : "") + v.toFixed(1) + "dB";
  const ms = (v) => (v < 1 ? Math.round(v * 1000) + "ms" : v.toFixed(2) + "s");
  const P = (label, min, max, step, def, fmt, log) => ({ label, min, max, step, def, fmt: fmt || ((v) => String(+v.toFixed(2))), log });

  /* ---------- graph helpers ---------- */
  function lfo(oc, rate, depth, param, type) {
    const o = oc.createOscillator(); o.type = type || "sine"; o.frequency.value = rate;
    const g = oc.createGain(); g.gain.value = depth;
    o.connect(g); g.connect(param); o.start(0);
    return o;
  }
  function filt(oc, type, f, q, gain) {
    const b = oc.createBiquadFilter(); b.type = type; b.frequency.value = f;
    if (q != null) b.Q.value = q;
    if (gain != null) b.gain.value = gain;
    return b;
  }
  function chain(...nodes) { for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }
  function sum(oc, ...ins) { const s = oc.createGain(); for (const [n, g] of ins) { const k = oc.createGain(); k.gain.value = g; n.connect(k); k.connect(s); } return s; }
  function shaper(oc, fn) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
    const s = oc.createWaveShaper(); s.curve = c; s.oversample = "4x"; return s;
  }
  const soft = (k) => (x) => Math.tanh(k * x) / Math.tanh(k);
  function ir(oc, seconds, bright, pre) {
    const sr = oc.sampleRate, len = Math.max(1, Math.floor(sr * (seconds + (pre || 0))));
    const b = oc.createBuffer(2, len, sr), p0 = Math.floor((pre || 0) * sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let lp = 0;
      const a = 0.05 + 0.9 * bright;
      for (let i = p0; i < len; i++) {
        const t = (i - p0) / (len - p0);
        lp += a * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - t, 2.5) * Math.exp(-3 * t);
      }
    }
    return b;
  }
  function reverb(oc, input, seconds, bright, pre, wet) {
    const cv = oc.createConvolver(); cv.buffer = ir(oc, seconds, bright, pre);
    input.connect(cv);
    return sum(oc, [input, 1], [cv, wet]);
  }
  function noiseSrc(oc, fill) {
    const b = oc.createBuffer(1, oc.length, oc.sampleRate);
    fill(b.getChannelData(0), oc.sampleRate);
    const s = oc.createBufferSource(); s.buffer = b; s.start(0); return s;
  }
  const hiss = (level) => (d) => { let lp = 0; for (let i = 0; i < d.length; i++) { lp += 0.3 * ((Math.random() * 2 - 1) - lp); d[i] = lp * level; } };
  const crackle = (rate, level) => (d, sr) => {
    hiss(level * 0.25)(d);
    let i = 0;
    while (i < d.length) {
      i += Math.floor(-Math.log(Math.random()) * sr / rate);
      const amp = level * (0.3 + Math.random()) * (Math.random() < 0.5 ? -1 : 1);
      for (let k = 0; k < 40 && i + k < d.length; k++) d[i + k] += amp * Math.exp(-k / 6);
    }
  };
  function wow(oc, input, slowDepth, fastDepth) {
    const dl = oc.createDelay(0.1); dl.delayTime.value = 0.02;
    lfo(oc, 0.6, slowDepth, dl.delayTime);
    lfo(oc, 6.5, fastDepth, dl.delayTime);
    input.connect(dl); return dl;
  }
  function comp(oc, input, thr, ratio, makeup) {
    const c = oc.createDynamicsCompressor();
    c.threshold.value = thr; c.ratio.value = ratio; c.attack.value = 0.005; c.release.value = 0.15; c.knee.value = 6;
    const g = oc.createGain(); g.gain.value = Math.pow(10, (makeup || 0) / 20);
    input.connect(c); c.connect(g); return g;
  }
  // a layer of the ORIGINAL buffer at another rate / detune (octaves, unison)
  function layer(oc, buf, rate, detune, gain, pan) {
    const s = oc.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; s.detune.value = detune || 0;
    const g = oc.createGain(); g.gain.value = gain;
    s.connect(g); s.start(0);
    if (pan != null && oc.createStereoPanner) { const p = oc.createStereoPanner(); p.pan.value = pan; g.connect(p); return p; }
    return g;
  }
  // envelope follower over the mono mix: attack/release in seconds
  function follow(chs, sr, att, rel) {
    const n = chs[0].length, out = new Float32Array(n);
    const a = Math.exp(-1 / (att * sr)), r = Math.exp(-1 / (rel * sr));
    let e = 0;
    for (let i = 0; i < n; i++) {
      let x = 0; for (const c of chs) x = Math.max(x, Math.abs(c[i]));
      e = x > e ? a * e + (1 - a) * x : r * e + (1 - r) * x;
      out[i] = e;
    }
    return out;
  }
  const VOWELS = [[800, 1150, 2900], [400, 1600, 2700], [350, 2300, 3000], [450, 800, 2830], [325, 700, 2530]];

  /* ---------- the rack ---------- */
  const FX = {
    // TONE
    lowpass:  { group: "Tone", name: "Lowpass", params: [P("Cutoff", 40, 18000, 1, 1200, hz, true), P("Resonance", 0.1, 20, 0.1, 1)],
                build: (oc, i, p) => chain(i, filt(oc, "lowpass", p[0], p[1])) },
    highpass: { group: "Tone", name: "Highpass", params: [P("Cutoff", 20, 12000, 1, 400, hz, true), P("Resonance", 0.1, 20, 0.1, 1)],
                build: (oc, i, p) => chain(i, filt(oc, "highpass", p[0], p[1])) },
    bandpass: { group: "Tone", name: "Bandpass", params: [P("Center", 60, 12000, 1, 1000, hz, true), P("Narrow", 0.3, 20, 0.1, 2)],
                build: (oc, i, p) => chain(i, filt(oc, "bandpass", p[0], p[1])) },
    eq:       { group: "Tone", name: "EQ (low / mid / high)", params: [P("Low", -18, 18, 0.5, 0, db), P("Mid", -18, 18, 0.5, 0, db), P("High", -18, 18, 0.5, 0, db)],
                build: (oc, i, p) => chain(i, filt(oc, "lowshelf", 200, null, p[0]), filt(oc, "peaking", 1200, 0.8, p[1]), filt(oc, "highshelf", 5000, null, p[2])) },
    sweep:    { group: "Tone", name: "Filter sweep", params: [P("From", 40, 18000, 1, 8000, hz, true), P("To", 40, 18000, 1, 200, hz, true), P("Resonance", 0.1, 25, 0.1, 6)],
                build: (oc, i, p, buf) => { const f = filt(oc, "lowpass", p[0], p[2]); f.frequency.setValueAtTime(p[0], 0); f.frequency.exponentialRampToValueAtTime(p[1], Math.max(0.05, buf.duration)); return chain(i, f); } },
    vowel:    { group: "Tone", name: "Vowel (talk box)", params: [P("Vowel A·E·I·O·U", 0, 4, 0.01, 0, (v) => "AEIOU"[Math.round(v)]), P("Sharpness", 2, 25, 0.5, 10)],
                build: (oc, i, p) => {
                  const k = Math.floor(Math.min(3.999, p[0])), t = p[0] - k, a = VOWELS[k], b = VOWELS[Math.min(4, k + 1)];
                  return sum(oc, ...[0, 1, 2].map((j) => [chain(i, filt(oc, "bandpass", a[j] + (b[j] - a[j]) * t, p[1])), [3, 2, 1.2][j]]));
                } },
    // DIRT
    drive:    { group: "Dirt", name: "Overdrive", params: [P("Drive", 1, 30, 0.1, 4), P("Tone", 500, 16000, 1, 6000, hz, true)],
                build: (oc, i, p) => chain(i, shaper(oc, soft(p[0])), filt(oc, "lowpass", p[1], 0.7)) },
    fuzz:     { group: "Dirt", name: "Fuzz", params: [P("Gain", 2, 100, 1, 30), P("Tone", 500, 16000, 1, 4000, hz, true)],
                build: (oc, i, p) => { const g = oc.createGain(); g.gain.value = p[0]; return chain(i, g, shaper(oc, (x) => Math.max(-1, Math.min(1, x)) * 0.7), filt(oc, "lowpass", p[1], 0.7)); } },
    tape:     { group: "Dirt", name: "Tape saturation", params: [P("Heat", 1, 8, 0.1, 2.5)],
                build: (oc, i, p) => chain(i, shaper(oc, (x) => Math.tanh(p[0] * x + 0.15 * x * x) / Math.tanh(p[0])), filt(oc, "highshelf", 7000, null, -4)) },
    crush:    { group: "Dirt", name: "Bitcrush", params: [P("Bits", 2, 16, 1, 6), P("Rate ÷", 1, 40, 1, 4)],
                js: (chs, sr, p) => { const q = Math.pow(2, p[0] - 1); for (const d of chs) { let h = 0; for (let i = 0; i < d.length; i++) { if (i % p[1] === 0) h = Math.round(d[i] * q) / q; d[i] = h; } } } },
    // MOVEMENT
    chorus:   { group: "Movement", name: "Chorus", stereo: true, params: [P("Rate", 0.1, 5, 0.05, 0.8), P("Depth", 0, 1, 0.01, 0.5, pct)],
                build: (oc, i, p) => {
                  const mk = (ph, pan) => { const d = oc.createDelay(0.1); d.delayTime.value = 0.02; lfo(oc, p[0] * ph, 0.008 * p[1], d.delayTime); const s = oc.createStereoPanner(); s.pan.value = pan; return chain(i, d, s); };
                  return sum(oc, [i, 0.7], [mk(1, -0.7), 0.5], [mk(1.13, 0.7), 0.5]);
                } },
    flanger:  { group: "Movement", name: "Flanger", params: [P("Rate", 0.05, 5, 0.05, 0.3), P("Depth", 0, 1, 0.01, 0.7, pct), P("Feedback", 0, 0.95, 0.01, 0.6, pct)],
                build: (oc, i, p) => { const d = oc.createDelay(0.05); d.delayTime.value = 0.004; lfo(oc, p[0], 0.0035 * p[1], d.delayTime); const fb = oc.createGain(); fb.gain.value = p[2]; i.connect(d); d.connect(fb); fb.connect(d); return sum(oc, [i, 0.7], [d, 0.7]); } },
    phaser:   { group: "Movement", name: "Phaser", params: [P("Rate", 0.05, 8, 0.05, 0.5), P("Depth", 0, 1, 0.01, 0.8, pct), P("Feedback", 0, 0.9, 0.01, 0.4, pct)],
                build: (oc, i, p) => {
                  const st = [0, 1, 2, 3, 4, 5].map(() => filt(oc, "allpass", 900, 0.6));
                  const o = oc.createOscillator(); o.frequency.value = p[0]; o.start(0);
                  for (const s of st) { const g = oc.createGain(); g.gain.value = 800 * p[1]; o.connect(g); g.connect(s.frequency); }
                  const fb = oc.createGain(); fb.gain.value = p[2];
                  const head = oc.createGain(); i.connect(head); chain(head, ...st); st[5].connect(fb); fb.connect(head);
                  return sum(oc, [i, 0.6], [st[5], 0.6]);
                } },
    tremolo:  { group: "Movement", name: "Tremolo", params: [P("Rate", 0.5, 20, 0.1, 6), P("Depth", 0, 1, 0.01, 0.7, pct)],
                build: (oc, i, p) => { const g = oc.createGain(); g.gain.value = 1 - p[1] / 2; lfo(oc, p[0], p[1] / 2, g.gain); return chain(i, g); } },
    vibrato:  { group: "Movement", name: "Vibrato", params: [P("Rate", 0.5, 12, 0.1, 5.5), P("Depth", 0, 1, 0.01, 0.4, pct)],
                build: (oc, i, p) => { const d = oc.createDelay(0.05); d.delayTime.value = 0.01; lfo(oc, p[0], 0.0025 * p[1], d.delayTime); return chain(i, d); } },
    ringmod:  { group: "Movement", name: "Ring mod (metallic)", params: [P("Frequency", 10, 3000, 1, 300, hz, true)],
                build: (oc, i, p) => { const g = oc.createGain(); g.gain.value = 0; lfo(oc, p[0], 1, g.gain); return chain(i, g); } },
    autopan:  { group: "Movement", name: "Auto-pan", stereo: true, params: [P("Rate", 0.1, 10, 0.05, 1), P("Width", 0, 1, 0.01, 0.8, pct)],
                build: (oc, i, p) => { const s = oc.createStereoPanner(); lfo(oc, p[0], p[1], s.pan); return chain(i, s); } },
    // SPACE
    reverb:   { group: "Space", name: "Reverb", stereo: true, params: [P("Size", 0.2, 8, 0.05, 2, ms), P("Brightness", 0, 1, 0.01, 0.5, pct), P("Wet", 0, 2, 0.01, 0.6, pct)],
                tail: (p) => p[0] + 0.2, build: (oc, i, p) => reverb(oc, i, p[0], p[1], 0.02, p[2]) },
    delay:    { group: "Space", name: "Echo", params: [P("Time", 0.02, 1.5, 0.01, 0.3, ms), P("Feedback", 0, 0.9, 0.01, 0.45, pct), P("Wet", 0, 1, 0.01, 0.5, pct)],
                tail: (p) => p[0] * Math.ceil(Math.log(0.01) / Math.log(Math.max(0.05, p[1]))) + 0.1,
                build: (oc, i, p) => { const d = oc.createDelay(2); d.delayTime.value = p[0]; const fb = oc.createGain(); fb.gain.value = p[1]; i.connect(d); d.connect(fb); fb.connect(d); return sum(oc, [i, 1], [d, p[2]]); } },
    pingpong: { group: "Space", name: "Ping-pong echo", stereo: true, params: [P("Time", 0.02, 1, 0.01, 0.25, ms), P("Feedback", 0, 0.9, 0.01, 0.5, pct), P("Wet", 0, 1, 0.01, 0.5, pct)],
                tail: (p) => 2 * p[0] * Math.ceil(Math.log(0.01) / Math.log(Math.max(0.05, p[1]))) + 0.1,
                build: (oc, i, p) => {
                  const L = oc.createDelay(2), R = oc.createDelay(2); L.delayTime.value = R.delayTime.value = p[0];
                  const fb = oc.createGain(); fb.gain.value = p[1];
                  const m = oc.createChannelMerger(2);
                  i.connect(L); L.connect(R); R.connect(fb); fb.connect(L);
                  L.connect(m, 0, 0); R.connect(m, 0, 1);
                  return sum(oc, [i, 1], [m, p[2]]);
                } },
    revrev:   { group: "Space", name: "Reverse reverb (swell-in)", stereo: true, params: [P("Size", 0.3, 6, 0.05, 1.5, ms), P("Wet", 0, 2, 0.01, 1, pct)],
                tail: (p) => p[0] + 0.2,
                pre: (chs) => { for (const d of chs) d.reverse(); },
                build: (oc, i, p) => reverb(oc, i, p[0], 0.5, 0, p[1]),
                js: (chs) => { for (const d of chs) d.reverse(); } },
    // SHAPE
    shape:    { group: "Shape", name: "Shape (attack / decay)", params: [P("Attack", 0, 1, 0.001, 0.005, ms), P("Decay", 0.02, 8, 0.01, 1, ms), P("Curve", 0.5, 6, 0.1, 2)],
                js: (chs, sr, p) => { const a = p[0] * sr, d = p[1] * sr; for (const c of chs) for (let i = 0; i < c.length; i++) { const at = a > 0 ? Math.min(1, i / a) : 1; const t = Math.max(0, i - a) / d; c[i] *= at * (t >= 1 ? 0 : Math.pow(1 - t, p[2])); } } },
    punch:    { group: "Shape", name: "Punch (transients)", params: [P("Attack", -1, 1, 0.01, 0.6, pct), P("Sustain", -1, 1, 0.01, 0, pct)],
                js: (chs, sr, p) => {
                  const fast = follow(chs, sr, 0.001, 0.02), slow = follow(chs, sr, 0.02, 0.25);
                  for (let i = 0; i < fast.length; i++) {
                    const t = Math.max(0, Math.min(1, (fast[i] - slow[i]) / (fast[i] + 1e-6)));
                    const g = Math.max(0, 1 + p[0] * 2 * t) * Math.max(0, 1 + p[1] * (1 - t));
                    for (const c of chs) c[i] *= g;
                  }
                } },
    compress: { group: "Shape", name: "Compressor", params: [P("Threshold", -60, 0, 0.5, -24, db), P("Ratio", 1, 20, 0.1, 4), P("Makeup", 0, 24, 0.5, 6, db)],
                build: (oc, i, p) => comp(oc, i, p[0], p[1], p[2]) },
    gate:     { group: "Shape", name: "Gate", params: [P("Threshold", -70, 0, 0.5, -35, db), P("Release", 0.005, 1, 0.005, 0.08, ms)],
                js: (chs, sr, p) => { const e = follow(chs, sr, 0.001, 0.01), thr = Math.pow(10, p[0] / 20), r = Math.exp(-1 / (p[1] * sr)); let g = 0; for (let i = 0; i < e.length; i++) { const want = e[i] > thr ? 1 : 0; g = want > g ? want : r * g; for (const c of chs) c[i] *= g; } } },
    // PITCH & THICKNESS
    octaves:  { group: "Pitch & thickness", name: "Octave layers", params: [P("Octave down", 0, 1, 0.01, 0.6, pct), P("Octave up", 0, 1, 0.01, 0, pct)],
                tail: (p, dur) => (p[0] > 0 ? dur : 0),
                build: (oc, i, p, buf) => sum(oc, [i, 1], [layer(oc, buf, 0.5, 0, p[0]), 1], [layer(oc, buf, 2, 0, p[1]), 1]) },
    unison:   { group: "Pitch & thickness", name: "Unison (thicken)", stereo: true, params: [P("Detune", 0, 50, 0.5, 12, (v) => v.toFixed(1) + "ct"), P("Voices", 2, 7, 1, 4)],
                build: (oc, i, p, buf) => { const n = p[1], ins = [[i, 0.5]]; for (let k = 0; k < n; k++) { const x = n === 1 ? 0 : (k / (n - 1)) * 2 - 1; ins.push([layer(oc, buf, 1, x * p[0], 0.7 / Math.sqrt(n), x * 0.8), 1]); } return sum(oc, ...ins); } },

    // RECORDING STYLES — the same sound, recorded somewhere else
    studio:   { group: "Recording style", name: "Studio (clean, close mic)", params: [],
                build: (oc, i) => comp(oc, chain(i, filt(oc, "highpass", 35, 0.7), filt(oc, "peaking", 3500, 0.9, 2.5), filt(oc, "highshelf", 10000, null, 1.5)), -20, 3, 3) },
    room:     { group: "Recording style", name: "Small room", stereo: true, params: [], tail: () => 0.7,
                build: (oc, i) => reverb(oc, chain(i, filt(oc, "peaking", 400, 1, 2)), 0.5, 0.45, 0.004, 0.45) },
    hall:     { group: "Recording style", name: "Concert hall", stereo: true, params: [], tail: () => 3.4,
                build: (oc, i) => reverb(oc, i, 3, 0.4, 0.03, 0.7) },
    church:   { group: "Recording style", name: "Stone church", stereo: true, params: [], tail: () => 6.3,
                build: (oc, i) => reverb(oc, chain(i, filt(oc, "lowshelf", 250, null, 3)), 6, 0.3, 0.05, 0.9) },
    nextroom: { group: "Recording style", name: "Through the wall", params: [], tail: () => 1,
                build: (oc, i) => reverb(oc, chain(i, filt(oc, "lowpass", 600, 0.9)), 0.7, 0.2, 0.01, 0.35) },
    tapeold:  { group: "Recording style", name: "Old reel tape", params: [],
                build: (oc, i) => sum(oc, [chain(wow(oc, i, 0.0012, 0.00015), shaper(oc, soft(2)), filt(oc, "lowpass", 9000, 0.7), filt(oc, "highpass", 50, 0.7)), 1], [noiseSrc(oc, hiss(0.006)), 1]) },
    cassette: { group: "Recording style", name: "Cassette", params: [],
                build: (oc, i) => sum(oc, [chain(wow(oc, i, 0.0022, 0.0003), shaper(oc, soft(2.5)), filt(oc, "lowpass", 6000, 0.7), filt(oc, "highpass", 70, 0.7)), 1], [noiseSrc(oc, hiss(0.012)), 1]) },
    vinyl:    { group: "Recording style", name: "Vinyl record", params: [],
                build: (oc, i) => sum(oc, [chain(wow(oc, i, 0.0008, 0), filt(oc, "lowpass", 8000, 0.7), filt(oc, "highpass", 60, 0.7)), 1], [noiseSrc(oc, crackle(6, 0.05)), 1]) },
    record78: { group: "Recording style", name: "Old 78 (1930s)", params: [],
                build: (oc, i) => sum(oc, [chain(i, filt(oc, "highpass", 300, 0.8), filt(oc, "lowpass", 3200, 1), shaper(oc, soft(2))), 1], [chain(noiseSrc(oc, crackle(18, 0.09)), filt(oc, "bandpass", 1500, 0.5)), 1]) },
    phone:    { group: "Recording style", name: "Telephone", params: [],
                build: (oc, i) => chain(i, filt(oc, "highpass", 350, 1), filt(oc, "lowpass", 3300, 1), shaper(oc, soft(3))) },
    radio:    { group: "Recording style", name: "AM radio", params: [],
                build: (oc, i) => sum(oc, [comp(oc, chain(i, filt(oc, "highpass", 200, 0.8), filt(oc, "lowpass", 4500, 1.2), shaper(oc, soft(2))), -30, 6, 8), 1], [noiseSrc(oc, hiss(0.01)), 1]) },
    megaphone:{ group: "Recording style", name: "Megaphone", params: [],
                build: (oc, i) => chain(i, filt(oc, "highpass", 700, 1.5), filt(oc, "peaking", 1800, 2, 8), filt(oc, "lowpass", 3000, 1.5), shaper(oc, soft(8))) },
    under:    { group: "Recording style", name: "Underwater", params: [], tail: () => 0.8,
                build: (oc, i) => { const d = oc.createDelay(0.05); d.delayTime.value = 0.01; lfo(oc, 0.7, 0.003, d.delayTime); return reverb(oc, chain(i, filt(oc, "lowpass", 450, 2), d), 0.6, 0.1, 0, 0.5); } },
  };

  /* ---------- the envelope: effect amount over time ---------- */
  const PRESETS = {
    "Flat (all the way)": [[0, 1], [1, 1]],
    "Fade in": [[0, 0], [1, 1]],
    "Fade out": [[0, 1], [1, 0]],
    "Swell (in, then out)": [[0, 0], [0.5, 1], [1, 0]],
    "Dip (out in the middle)": [[0, 1], [0.5, 0], [1, 1]],
    "Hit only (attack)": [[0, 1], [0.08, 1], [0.2, 0], [1, 0]],
    "Tail only (after the attack)": [[0, 0], [0.1, 0], [0.3, 1], [1, 1]],
    "Pulses x4": [[0, 1], [0.125, 0], [0.25, 1], [0.375, 0], [0.5, 1], [0.625, 0], [0.75, 1], [0.875, 0], [1, 1]],
  };
  const env = { pts: PRESETS["Flat (all the way)"].map((p) => p.slice()), edit: false };
  function envAt(x) {
    const p = env.pts;
    if (x <= p[0][0]) return p[0][1];
    for (let k = 1; k < p.length; k++) if (x <= p[k][0]) { const [x0, y0] = p[k - 1], [x1, y1] = p[k]; return y0 + (y1 - y0) * (x1 > x0 ? (x - x0) / (x1 - x0) : 1); }
    return p[p.length - 1][1];
  }

  /* ---------- rendering ---------- */
  const paramValues = () => [0, 1, 2].map((k) => { const el = document.getElementById("em-fp" + k); return el ? sliderValue(el) : 0; });
  function sliderValue(el) { const d = el._def; if (!d) return 0; const t = +el.value; return d.log ? d.min * Math.pow(d.max / d.min, t) : t; }

  async function render(buf, fx, p, a, b) {
    const sr = buf.sampleRate, n = b - a;
    const outCh = Math.max(buf.numberOfChannels, fx.stereo ? 2 : 1);
    const tail = fx.tail ? Math.max(0, fx.tail(p, n / sr)) : 0;
    const len = n + Math.ceil(tail * sr);
    // the selected slice (pre-processed if the effect wants)
    const slice = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: n, sampleRate: sr });
    for (let c = 0; c < buf.numberOfChannels; c++) slice.copyToChannel(buf.getChannelData(c).slice(a, b), c);
    if (fx.pre) { const chs = []; for (let c = 0; c < slice.numberOfChannels; c++) chs.push(slice.getChannelData(c)); fx.pre(chs, sr, p); }
    let wet;
    if (fx.build) {
      const oc = new OfflineAudioContext(outCh, len, sr);
      const src = oc.createBufferSource(); src.buffer = slice; src.start(0);
      const pass = oc.createGain(); src.connect(pass);
      fx.build(oc, pass, p, slice).connect(oc.destination);
      wet = await oc.startRendering();
    } else {
      wet = new AudioBuffer({ numberOfChannels: outCh, length: len, sampleRate: sr });
      for (let c = 0; c < outCh; c++) wet.copyToChannel(slice.getChannelData(Math.min(c, slice.numberOfChannels - 1)), c);
    }
    const chs = []; for (let c = 0; c < wet.numberOfChannels; c++) chs.push(wet.getChannelData(c));
    if (fx.js) fx.js(chs, sr, p);
    // blend along the envelope: x runs over the selection, the tail keeps the last value
    const dry = []; for (let c = 0; c < wet.numberOfChannels; c++) dry.push(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
    for (let i = 0; i < len; i++) {
      const e = envAt(Math.min(1, i / n));
      if (e >= 0.9999) continue;
      for (let c = 0; c < chs.length; c++) chs[c][i] = chs[c][i] * e + (i < n ? dry[c][a + i] : 0) * (1 - e);
    }
    // splice back: the slice replaced, its tail rings on over what follows
    const total = Math.max(buf.length, a + len), ch = Math.max(buf.numberOfChannels, outCh);
    const out = new AudioBuffer({ numberOfChannels: ch, length: total, sampleRate: sr });
    for (let c = 0; c < ch; c++) {
      const d = out.getChannelData(c);
      d.set(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
      d.fill(0, a, b);
      const w = wet.getChannelData(Math.min(c, wet.numberOfChannels - 1));
      for (let i = 0; i < len; i++) d[a + i] += w[i];
    }
    return out;
  }

  async function processed() {
    if (!em.buf) { toast("No audio loaded"); return null; }
    const fx = FX[document.getElementById("em-fx").value];
    const [a, b] = emRegion();
    return render(em.buf, fx, paramValues(), a, b);
  }

  async function preview() {
    const out = await processed(); if (!out) return;
    emStop(); AC.resume();
    const s = AC.createBufferSource(); s.buffer = out; s.connect(master);
    const [a] = emRegion();
    s.start(0, a / out.sampleRate);
    em.playSrc = s;
  }
  async function apply() {
    const out = await processed(); if (!out) return;
    emStop(); emPushUndo();
    em.buf = out; em.sel = null; emDraw();
    toast("Applied " + FX[document.getElementById("em-fx").value].name);
  }

  /* ONE HIT: cut the sample down to its first clean note/hit — from the first
     sound to where it dies away or the next hit starts, with a short fade. */
  function oneHit() {
    if (!em.buf) { toast("No audio loaded"); return; }
    const buf = em.buf, sr = buf.sampleRate, chs = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const win = Math.floor(sr * 0.01), nW = Math.floor(buf.length / win), rms = new Float32Array(nW);
    for (let w = 0; w < nW; w++) { let s = 0; for (const d of chs) for (let i = w * win; i < (w + 1) * win; i++) s += d[i] * d[i]; rms[w] = Math.sqrt(s / (win * chs.length)); }
    const peak = Math.max(...rms); if (!peak) { toast("It's silent"); return; }
    let start = rms.findIndex((v) => v > peak * 0.05); start = Math.max(0, start - 1);
    let top = start; while (top + 1 < nW && rms[top + 1] >= rms[top]) top++;
    let end = nW, low = rms[top];
    for (let w = top + 1; w < nW; w++) {
      low = Math.min(low, rms[w]);
      if (rms[w] < peak * 0.003) { end = w; break; }                       // died away (-50 dB)
      if (w > top + 5 && rms[w] > low * 3 && rms[w] > peak * 0.1) { end = w; break; }   // the next hit
    }
    const a = start * win, b = Math.min(buf.length, end * win), n = b - a, fade = Math.min(Math.floor(sr * 0.015), n >> 2);
    const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: n, sampleRate: sr });
    for (let c = 0; c < chs.length; c++) { const d = chs[c].slice(a, b); for (let i = 0; i < fade; i++) d[n - 1 - i] *= i / fade; out.copyToChannel(d, c); }
    emStop(); emPushUndo(); em.buf = out; em.sel = null; emDraw();
    toast("One hit: " + (n / sr).toFixed(2) + "s");
  }

  /* ---------- UI ---------- */
  function setupParams() {
    const fx = FX[document.getElementById("em-fx").value];
    for (let k = 0; k < 3; k++) {
      const d = fx.params[k], el = document.getElementById("em-fp" + k), lab = document.getElementById("em-fl" + k), val = document.getElementById("em-fv" + k);
      const show = !!d;
      [el, lab, val].forEach((x) => (x.style.display = show ? "" : "none"));
      if (!d) { el._def = null; continue; }
      el._def = d; lab.textContent = d.label;
      if (d.log) { el.min = 0; el.max = 1; el.step = 0.001; el.value = Math.log(d.def / d.min) / Math.log(d.max / d.min); }
      else { el.min = d.min; el.max = d.max; el.step = d.step; el.value = d.def; }
      val.textContent = d.fmt(sliderValue(el));
    }
    document.getElementById("em-fx-none").style.display = fx.params.length ? "none" : "";
  }

  function drawEnvelope() {
    if (!em.buf) return;
    const cv = document.getElementById("em-wave"), g = cv.getContext("2d");
    const [a, b] = emRegion(), x0 = (a / em.buf.length) * cv.width, x1 = (b / em.buf.length) * cv.width;
    const X = (x) => x0 + x * (x1 - x0), Y = (y) => 8 + (1 - y) * (cv.height - 16);
    g.save();
    g.globalAlpha = env.edit ? 1 : 0.55;
    g.strokeStyle = "#ff9b3d"; g.lineWidth = 2; g.beginPath();
    env.pts.forEach(([x, y], k) => (k ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.stroke();
    if (env.edit) { g.fillStyle = "#ffd3a1"; for (const [x, y] of env.pts) { g.beginPath(); g.arc(X(x), Y(y), 5, 0, Math.PI * 2); g.fill(); } }
    g.fillStyle = "#ff9b3d"; g.font = "11px system-ui";
    g.fillText("effect amount", X(0) + 4, 14);
    g.restore();
  }

  function wireEnvelopeEditing() {
    const cv = document.getElementById("em-wave");
    let drag = -1;
    const pos = (e) => {
      const r = cv.getBoundingClientRect(), [a, b] = emRegion();
      const fx = ((e.clientX - r.left) / r.width) * em.buf.length;
      const x = Math.max(0, Math.min(1, (fx - a) / (b - a)));
      const y = Math.max(0, Math.min(1, 1 - ((e.clientY - r.top) / r.height * cv.height - 8) / (cv.height - 16)));
      return [x, y];
    };
    const near = (x, y) => { const r = cv.getBoundingClientRect(), [a, b] = emRegion(), w = ((b - a) / em.buf.length) * r.width; return env.pts.findIndex(([px, py]) => Math.hypot((px - x) * w, (py - y) * r.height) < 10); };
    cv.addEventListener("pointerdown", (e) => {
      if (!env.edit || !em.buf) return;
      const [x, y] = pos(e);
      drag = near(x, y);
      if (drag < 0) { env.pts.push([x, y]); env.pts.sort((p, q) => p[0] - q[0]); drag = env.pts.findIndex((p) => p[0] === x && p[1] === y); }
      cv.setPointerCapture(e.pointerId); emDraw();
    });
    cv.addEventListener("pointermove", (e) => {
      if (!env.edit || drag < 0) return;
      const [x, y] = pos(e), last = env.pts.length - 1;
      // the ends stay at the ends; middle points can't cross their neighbours
      const lo = drag === 0 ? 0 : env.pts[drag - 1][0], hi = drag === last ? 1 : env.pts[drag + 1][0];
      env.pts[drag] = [drag === 0 ? 0 : drag === last ? 1 : Math.max(lo, Math.min(hi, x)), y];
      emDraw();
    });
    cv.addEventListener("pointerup", () => { drag = -1; });
    cv.addEventListener("dblclick", (e) => {
      if (!env.edit) return;
      const k = near(...pos(e));
      if (k > 0 && k < env.pts.length - 1) { env.pts.splice(k, 1); emDraw(); }
    });
  }

  function init() {
    const sel = document.getElementById("em-fx");
    sel.innerHTML = "";
    const groups = {};
    for (const [id, fx] of Object.entries(FX)) {
      if (!groups[fx.group]) { groups[fx.group] = document.createElement("optgroup"); groups[fx.group].label = fx.group; sel.appendChild(groups[fx.group]); }
      groups[fx.group].appendChild(new Option(fx.name, id));
    }
    sel.addEventListener("change", setupParams);
    for (let k = 0; k < 3; k++) {
      const el = document.getElementById("em-fp" + k);
      el.addEventListener("input", () => { if (el._def) document.getElementById("em-fv" + k).textContent = el._def.fmt(sliderValue(el)); });
    }
    const ps = document.getElementById("em-env-preset");
    for (const name of Object.keys(PRESETS)) ps.add(new Option(name, name));
    ps.addEventListener("change", () => { env.pts = PRESETS[ps.value].map((p) => p.slice()); emDraw(); });
    const eb = document.getElementById("em-env-edit");
    eb.addEventListener("click", () => { env.edit = !env.edit; eb.classList.toggle("accent", env.edit); eb.textContent = env.edit ? "✎ Drawing envelope (click to stop)" : "✎ Draw envelope"; emDraw(); });
    document.getElementById("em-fxpreview").addEventListener("click", () => preview().catch((e) => toast(e.message)));
    document.getElementById("em-fxapply").addEventListener("click", () => apply().catch((e) => toast(e.message)));
    document.getElementById("em-onehit").addEventListener("click", oneHit);
    wireEnvelopeEditing();
    setupParams();
  }

  window.HB_EMFX = { FX, PRESETS, env, envAt, render, oneHit, drawEnvelope, init, setupParams };
})();
