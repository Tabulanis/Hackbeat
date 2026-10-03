/* =====================================================================
   hbchain.js — a Hackbeat track's sound: EQ -> pan -> drive -> crush ->
   chorus -> fader, with delay and reverb sends to the song's shared buses.

   SHARED: Garden Rhythm carries a word-for-word copy (src/audio/hbchain.js,
   refreshed by its tools/sync-hackbeat-audio.mjs), so a round written here
   sounds the same in the game. Keep it free of anything app-specific.
   ===================================================================== */
(function () {
const impulseCache = new WeakMap();   // per audio context: decay -> impulse
function makeImpulse(ctx, decay) {
  if (!impulseCache.has(ctx)) impulseCache.set(ctx, new Map());
  const cache = impulseCache.get(ctx), key = decay.toFixed(2);
  if (cache.has(key)) return cache.get(key);
  const len = Math.max(1, Math.floor(ctx.sampleRate * Math.min(6, decay)));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  
  // Simulated room IR with algorithmic high-frequency dampening
  let lpL = 0, lpR = 0;
  const dL = buf.getChannelData(0);
  const dR = buf.getChannelData(1);
  for (let i = 0; i < len; i++) {
    const env = Math.pow(1 - i / len, 3.0); 
    const noiseL = (Math.random() * 2 - 1) * env;
    const noiseR = (Math.random() * 2 - 1) * env;
    lpL = lpL + 0.2 * (noiseL - lpL);
    lpR = lpR + 0.2 * (noiseR - lpR);
    dL[i] = lpL;
    dR[i] = lpR;
  }
  cache.set(key, buf);
  return buf;
}

function distCurve(drive) {
  const k = drive * 120;
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function bitcrushCurve(bits) {
  const n = Math.pow(2, bits);
  const curve = new Float32Array(4096);
  for (let i = 0; i < 4096; i++) {
    const x = (i / 4095) * 2 - 1;
    curve[i] = Math.round(x * n) / n;
  }
  return curve;
}

function buildSendBuses(ctx, dest) {
  const reverbIn = ctx.createGain();
  const conv = ctx.createConvolver();
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 1;
  reverbIn.connect(conv);
  conv.connect(reverbReturn);
  reverbReturn.connect(dest);

  const delayIn = ctx.createGain();
  const dl = ctx.createDelay(2.0);
  const fb = ctx.createGain();
  const delayReturn = ctx.createGain();
  delayReturn.gain.value = 1;
  delayIn.connect(dl);
  dl.connect(fb);
  fb.connect(dl);
  dl.connect(delayReturn);
  delayReturn.connect(dest);

  return {
    reverbIn,
    delayIn,
    setReverb(decay) { conv.buffer = makeImpulse(ctx, decay); },
    setDelay(time, feedback) {
      dl.delayTime.value = time;
      fb.gain.value = Math.min(0.9, feedback);
    },
  };
}

function buildChain(ctx, dest, sendBuses) {
  const input = ctx.createGain();

  // Channel Strip
  const panner = ctx.createStereoPanner();
  const eqLow = ctx.createBiquadFilter(); eqLow.type = "lowshelf"; eqLow.frequency.value = 250;
  const eqMid = ctx.createBiquadFilter(); eqMid.type = "peaking"; eqMid.frequency.value = 1000; eqMid.Q.value = 1.0;
  const eqHigh = ctx.createBiquadFilter(); eqHigh.type = "highshelf"; eqHigh.frequency.value = 4000;

  // Insert FX
  const distShaper = ctx.createWaveShaper(); distShaper.oversample = "2x";
  const crushShaper = ctx.createWaveShaper();

  // Chorus
  const chorusDry = ctx.createGain();
  const chorusWet = ctx.createGain();
  const chorusDelay = ctx.createDelay(); chorusDelay.delayTime.value = 0.03;
  const lfo = ctx.createOscillator(); lfo.type = "sine";
  const lfoGain = ctx.createGain();
  lfo.connect(lfoGain); lfoGain.connect(chorusDelay.delayTime);
  lfo.start(); 

  const chanGain = ctx.createGain();
  const reverbSend = ctx.createGain();
  const delaySend = ctx.createGain();
  reverbSend.gain.value = 0;
  delaySend.gain.value = 0;

  // Wiring Pipeline
  input.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh); eqHigh.connect(panner);
  panner.connect(distShaper); distShaper.connect(crushShaper);

  crushShaper.connect(chorusDry); chorusDry.connect(chanGain);
  crushShaper.connect(chorusDelay); chorusDelay.connect(chorusWet); chorusWet.connect(chanGain);

  chanGain.connect(dest);
  /* sends tapped post-fader: a muted/silent channel sends nothing,
     matching how a real console's aux sends behave */
  if (sendBuses) {
    chanGain.connect(reverbSend); reverbSend.connect(sendBuses.reverbIn);
    chanGain.connect(delaySend); delaySend.connect(sendBuses.delayIn);
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  chanGain.connect(analyser);

  const chain = {
    input,
    analyser,
    update(fx, audible) {
      // Strip
      chanGain.gain.value = audible ? fx.vol : 0;
      panner.pan.value = fx.pan || 0;
      eqLow.gain.value = fx.eq.low;
      eqMid.gain.value = fx.eq.mid;
      eqHigh.gain.value = fx.eq.high;

      // Crush & Dist
      distShaper.curve = fx.dist.on ? distCurve(fx.dist.drive) : null;
      crushShaper.curve = fx.crush.on ? bitcrushCurve(fx.crush.bits) : null;

      // Chorus
      if (fx.chorus.on) {
        lfo.frequency.value = fx.chorus.rate;
        lfoGain.gain.value = fx.chorus.depth;
        chorusWet.gain.value = fx.chorus.mix;
        chorusDry.gain.value = 1.0 - fx.chorus.mix;
      } else {
        chorusWet.gain.value = 0;
        chorusDry.gain.value = 1;
      }

      // Sends (bus character - decay/time/feedback - is global; see song.fxBus)
      delaySend.gain.value = fx.delay.on ? fx.delay.send : 0;
      reverbSend.gain.value = fx.reverb.on ? fx.reverb.send : 0;
    },
  };
  return chain;
}

window.HB_CHAIN = { makeImpulse, distCurve, bitcrushCurve, buildSendBuses, buildChain };
})();
