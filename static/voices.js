/* =====================================================================
   voices.js — the instrument you actually play.

   Before this, pressing a key called createBufferSource().start() and that
   was the whole story: the sample ran to its end, at one volume, and
   nothing you did to the key afterwards mattered. Fine for triggering a
   drum hit; not an instrument.

   A voice here has:
     * an envelope — attack, hold, decay, sustain, release — so a note can
       swell, and can STOP when you let go instead of always running out
     * velocity — how hard you hit it changes both loudness and brightness,
       which is most of what makes a keyboard feel responsive
     * a filter that opens with velocity, because loud notes are brighter
       in every real instrument
     * proper stealing — a polyphony cap, oldest voice released first, so
       holding a chord and rolling into another doesn't pile up into mud

   Everything is per-instrument and saved with the song, so a plucky lead
   and a slow pad can live in the same tune.
   ===================================================================== */

/** What a brand-new instrument sounds like: immediate, natural decay. */
const DEFAULT_VOICE = {
  attack: 0.002,   // seconds to full volume
  hold: 0.0,       // seconds held at full before decaying
  decay: 0.08,     // seconds falling to the sustain level
  sustain: 1.0,    // 0..1 — level held while the key is down
  release: 0.12,   // seconds to silence after the key comes up
  cutoff: 1.0,     // 0..1 filter openness at full velocity (1 = wide open)
  reso: 0.0,       // 0..1 filter resonance
  velToCutoff: 0.6,// how much velocity opens the filter
  glide: 0.0,      // seconds to slide between notes (mono-ish lead feel)
  pan: 0.0,        // -1..1
  gain: 1.0,       // instrument trim
  loop: false,     // hold the sample looping while the key is down
};

const MAX_VOICES = 24;

function voiceSettings(inst) {
  return Object.assign({}, DEFAULT_VOICE, (inst && inst.voice) || {});
}

/**
 * One playing note. Kept as an object rather than a bare AudioBufferSource
 * so it can be released later — the thing the old code had no way to do.
 */
class Voice {
  constructor(ctx, buffer, opts) {
    const v = opts.settings;
    const now = opts.when != null ? opts.when : ctx.currentTime;
    const vel = Math.max(0.02, Math.min(1, opts.velocity != null ? opts.velocity : 1));

    this.ctx = ctx;
    this.midi = opts.midi;
    this.started = now;
    this.settings = v;
    this.released = false;

    this.src = ctx.createBufferSource();
    this.src.buffer = buffer;
    this.rate = Math.pow(2, (opts.midi - opts.baseNote) / 12);
    this.src.playbackRate.value = this.rate;
    if (v.loop && buffer.duration > 0.05) {
      this.src.loop = true;
      // avoid the click at the very start/end of a trimmed sample
      this.src.loopStart = Math.min(0.01, buffer.duration * 0.05);
      this.src.loopEnd = buffer.duration - Math.min(0.01, buffer.duration * 0.05);
    }

    // filter: brighter the harder you play
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    const openness = Math.min(1, v.cutoff * (1 - v.velToCutoff + v.velToCutoff * vel));
    // exponential feels linear to the ear across the audible range
    this.filter.frequency.value = 120 * Math.pow(160, openness);
    this.filter.Q.value = 0.0001 + v.reso * 18;

    this.amp = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.pan.pan.value = Math.max(-1, Math.min(1, v.pan));

    this.src.connect(this.filter);
    this.filter.connect(this.amp);
    this.amp.connect(this.pan);
    this.pan.connect(opts.destination);

    // --- the envelope ---
    const peak = vel * v.gain;
    const sus = peak * v.sustain;
    const g = this.amp.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(peak, now + Math.max(0.001, v.attack));
    const afterHold = now + Math.max(0.001, v.attack) + v.hold;
    if (v.decay > 0.001 && v.sustain < 0.999) {
      g.setValueAtTime(peak, afterHold);
      g.exponentialRampToValueAtTime(Math.max(0.0001, sus), afterHold + v.decay);
    }

    this.src.start(now, opts.offset || 0);
    this.peak = peak;
  }

  /** Slide to a new pitch instead of retriggering — a lead-line glide. */
  glideTo(midi, baseNote, seconds) {
    const target = Math.pow(2, (midi - baseNote) / 12);
    const t = this.ctx.currentTime;
    this.src.playbackRate.cancelScheduledValues(t);
    this.src.playbackRate.setValueAtTime(this.src.playbackRate.value, t);
    this.src.playbackRate.linearRampToValueAtTime(target, t + Math.max(0.005, seconds));
    this.midi = midi;
  }

  /** Key up: fade out over the release time, then clean up. */
  release(when) {
    if (this.released) return;
    this.released = true;
    const t = when != null ? when : this.ctx.currentTime;
    const r = Math.max(0.005, this.settings.release);
    const g = this.amp.gain;
    g.cancelScheduledValues(t);
    // hold whatever level we're actually at, or the ramp jumps before falling
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.exponentialRampToValueAtTime(0.0001, t + r);
    try { this.src.stop(t + r + 0.02); } catch (_) {}
    this.src.onended = () => this.dispose();
  }

  /** Cut fast — for voice stealing. "Fast" still means a 10ms fade: a true
      instant stop leaves the wave mid-swing and pops, loudest on bass. */
  kill() {
    const t = this.ctx.currentTime;
    const g = this.amp.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, g.value), t);
      g.exponentialRampToValueAtTime(0.0001, t + 0.01);
      this.src.stop(t + 0.02);
      this.src.onended = () => this.dispose();
    } catch (_) {
      try { this.src.stop(); } catch (_) {}
      this.dispose();
    }
  }

  dispose() {
    try { this.src.disconnect(); } catch (_) {}
    try { this.filter.disconnect(); } catch (_) {}
    try { this.amp.disconnect(); } catch (_) {}
    try { this.pan.disconnect(); } catch (_) {}
  }
}

/**
 * Keeps track of what's sounding, so notes can be let go of and so a wall
 * of held keys doesn't turn to mush.
 */
class VoicePool {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = [];               // Voice[]
    this.held = new Map();          // "ch:midi" -> Voice, for key-up matching
  }

  static key(ch, midi) { return ch + ":" + midi; }

  noteOn(opts) {
    // one voice per (channel, pitch): retriggering the same key shouldn't
    // stack two copies on top of each other
    const k = VoicePool.key(opts.channel, opts.midi);
    const existing = this.held.get(k);
    if (existing) existing.release();

    if (this.active.length >= MAX_VOICES) {
      // steal the oldest that's already fading, else the plain oldest
      const idx = this.active.findIndex((v) => v.released);
      const victim = this.active.splice(idx >= 0 ? idx : 0, 1)[0];
      if (victim) victim.kill();
    }

    const v = new Voice(this.ctx, opts.buffer, opts);
    v.channel = opts.channel;
    this.active.push(v);
    this.held.set(k, v);
    v.src.addEventListener("ended", () => {
      const i = this.active.indexOf(v);
      if (i >= 0) this.active.splice(i, 1);
      if (this.held.get(k) === v) this.held.delete(k);
    });
    return v;
  }

  noteOff(channel, midi, when) {
    const k = VoicePool.key(channel, midi);
    const v = this.held.get(k);
    if (!v) return;
    v.release(when);
    this.held.delete(k);
  }

  /** Everything on a channel stops — what a === row means in a tracker. */
  allOff(channel, when) {
    for (const v of this.active) {
      if (channel == null || v.channel === channel) v.release(when);
    }
    for (const [k, v] of [...this.held]) {
      if (channel == null || v.channel === channel) this.held.delete(k);
    }
  }

  panic() {
    for (const v of this.active) v.kill();
    this.active.length = 0;
    this.held.clear();
  }

  get count() { return this.active.length; }
}

/* ---------------------------------------------------------------------
   Presets — starting points that sound like something, so a new user
   isn't asked to understand five envelope numbers before making a noise.
   --------------------------------------------------------------------- */
const VOICE_PRESETS = {
  "Natural":   { attack: 0.002, hold: 0, decay: 0.08, sustain: 1.0, release: 0.12 },
  "Pluck":     { attack: 0.001, hold: 0, decay: 0.22, sustain: 0.0, release: 0.10 },
  "Pad":       { attack: 0.45,  hold: 0, decay: 0.6,  sustain: 0.8, release: 0.9, loop: true },
  "Stab":      { attack: 0.001, hold: 0.04, decay: 0.09, sustain: 0.0, release: 0.06 },
  "Swell":     { attack: 0.9,   hold: 0, decay: 0.2,  sustain: 0.9, release: 0.7, loop: true },
  "Lead":      { attack: 0.004, hold: 0, decay: 0.15, sustain: 0.85, release: 0.18,
                 glide: 0.05, loop: true },
  "Soft keys": { attack: 0.02,  hold: 0, decay: 0.5,  sustain: 0.4, release: 0.35,
                 cutoff: 0.62, velToCutoff: 0.8 },
  "One shot":  { attack: 0.001, hold: 0, decay: 0.0,  sustain: 1.0, release: 4.0 },
};

window.HB_VOICES = {
  DEFAULT_VOICE, VOICE_PRESETS, MAX_VOICES, Voice, VoicePool, voiceSettings,
};
