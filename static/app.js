/* Hackbeat — tracker edition.
   OpenMPT-style top-down pattern editor. Cell = Note | Instrument | Volume.
   Per-channel FX chain (Web Audio): eq -> panner -> distortion -> bitcrush -> chorus -> delay -> reverb.
*/
"use strict";

const $ = (s) => document.querySelector(s);

/* ================= constants ================= */
const NOTE_OFF = -1;
const NOTE_NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
const BASE_NOTE = 60; // C-5
const KEYMAP = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
  q: 12, "2": 13, w: 14, "3": 15, e: 16, r: 17, "5": 18, t: 19, "6": 20,
  y: 21, "7": 22, u: 23, i: 24, "9": 25, o: 26, "0": 27, p: 28,
};
const SUBS = 3;
const CH_COLORS = ["#3f7fae", "#4f9d69", "#a05fa8", "#b3703b",
                   "#5b8fd6", "#3fa093", "#b05a68", "#8a8a45"];
function chTint(c, a) {
  const hex = CH_COLORS[c % CH_COLORS.length];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return "rgba(" + r + "," + g + "," + b + "," + a + ")";
}

function defaultFx() {
  return {
    vol: 0.85,
    pan: 0.0,
    eq: { low: 0, mid: 0, high: 0 },
    dist: { on: false, drive: 0.4 },
    crush: { on: false, bits: 8 },
    chorus: { on: false, rate: 1.5, depth: 0.01, mix: 0.5 },
    delay: { on: false, send: 0.3 },
    reverb: { on: false, send: 0.3 }
  };
}

function makeChannel(n) {
  return { name: "Ch " + n, mute: false, solo: false, fx: defaultFx() };
}
function makePattern(rows, channels) {
  return { rows, data: Array.from({ length: rows }, () => Array(channels).fill(null)) };
}
/** A blank project, same shape as the initial `song` below -- reused by
 * the New button so "new" and "first load ever" are guaranteed to mean
 * the same thing, not two independently-maintained defaults. */
function newSongData() {
  return {
    bpm: 125,
    rowsPerBeat: 4,
    instruments: [],
    channels: [1, 2, 3, 4, 5, 6, 7, 8].map(makeChannel),
    patterns: [makePattern(64, 8)],
    order: [0],
    fxBus: { reverbDecay: 2.0, delayTime: 0.3, delayFb: 0.35 },
  };
}

/* ================= song state ================= */
const song = {
  bpm: 125,
  rowsPerBeat: 4,
  instruments: [],
  channels: [makeChannel(1), makeChannel(2), makeChannel(3), makeChannel(4),
             makeChannel(5), makeChannel(6), makeChannel(7), makeChannel(8)],
  patterns: [makePattern(64, 8)],
  order: [0],
  fxBus: { reverbDecay: 2.0, delayTime: 0.3, delayFb: 0.35 },
};

const ui = {
  curPattern: 0,
  curInstrument: 0,
  cursor: { row: 0, ch: 0, sub: 0, slot: 0 },
  selection: null,
  clipboard: null,
  octave: 5,
  editMode: true,
  fxChannel: 0,
  showWave: true,
  showVU: true,
  zoom: 112,
};

const secPerRow = () => 60 / (song.bpm * song.rowsPerBeat);

/* ================= session autosave ================= */
/* True whenever there are changes not yet reflected in a named Save.
   autosave() fires after nearly every edit already, so it's the one
   choke point that sees every mutation -- reused here rather than
   threading a dirty=true call through every edit site individually.
   saveProject()/loadProject() explicitly clear it back to false right
   after their own autosave() call, since that one isn't "new changes",
   it's just persisting the just-saved/just-loaded state. */
let dirty = false;
function autosave() {
  dirty = true;
  try {
    localStorage.setItem("hackbeat_autosave", JSON.stringify(serialize()));
  } catch (e) {
    console.warn("Autosave failed", e);
  }
}
window.addEventListener("pagehide", autosave);
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") autosave();
});

/* ================= audio core ================= */
const AC = new (window.AudioContext || window.webkitAudioContext)();
const master = AC.createGain();
master.gain.value = 0.9;

/* headroom: as more channels sum in, trim the bus down (1/sqrt(N) is the
   standard summing-compensation curve - keeps perceived loudness roughly
   constant and stops the limiter from being slammed as track count grows) */
const headroom = AC.createGain();
headroom.gain.value = 1;

const limiter = AC.createDynamicsCompressor();
limiter.threshold.value = -6.0;
limiter.knee.value = 10.0;
limiter.ratio.value = 12.0;
limiter.attack.value = 0.003;
limiter.release.value = 0.15;

master.connect(headroom);
headroom.connect(limiter);
limiter.connect(AC.destination);

function updateHeadroom() {
  const n = Math.max(1, song.channels.filter((c, i) => channelAudible(i)).length);
  headroom.gain.value = 1 / Math.sqrt(n);
}

const buffers = new Map(); 
async function getBuffer(path) {
  if (buffers.has(path)) return buffers.get(path);
  const res = await fetch("/api/audio/" + encodeURI(path));
  if (!res.ok) throw new Error("Could not load " + path);
  const buf = await AC.decodeAudioData(await res.arrayBuffer());
  buffers.set(path, buf);
  return buf;
}

/* ---------- fx chain ---------- */
const impulseCache = new Map(); 
function makeImpulse(ctx, decay) {
  const key = (ctx === AC ? "rt" : "off") + ":" + decay.toFixed(2) + ":" + ctx.sampleRate;
  if (impulseCache.has(key)) return impulseCache.get(key);
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
  impulseCache.set(key, buf);
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

let chains = []; // realtime, one per channel
const sendBuses = buildSendBuses(AC, master);
function ensureChains() {
  while (chains.length < song.channels.length) {
    chains.push(buildChain(AC, master, sendBuses));
  }
  chains.length = song.channels.length;
  sendBuses.setReverb(song.fxBus.reverbDecay);
  sendBuses.setDelay(song.fxBus.delayTime, song.fxBus.delayFb);
  refreshChainParams();
}
function channelAudible(i) {
  const anySolo = song.channels.some((c) => c.solo);
  const ch = song.channels[i];
  return anySolo ? ch.solo : !ch.mute;
}
function refreshChainParams() {
  updateHeadroom();
  song.channels.forEach((ch, i) => {
    if (chains[i]) chains[i].update(ch.fx, channelAudible(i));
  });
}

/* ================= toast ================= */
let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ================= note helpers ================= */
function noteName(n) {
  if (n === NOTE_OFF) return "===";
  if (n == null) return "...";
  return NOTE_NAMES[n % 12] + Math.floor(n / 12);
}
function fmt2(v) {
  if (v == null) return "..";
  return String(v).padStart(2, "0");
}

/* ================= pattern grid ================= */
const grid = $("#pattern-grid");
let gridLastClick = null; // manual dblclick detection - see cell mousedown
let cellEls = [];  // cellEls[row][channel] — indexing unchanged by the layout
let laneEls = [];  // one horizontal lane element per channel
let playline = null;

function curPat() { return song.patterns[ui.curPattern]; }

function isSelected(r, c) {
  if (!ui.selection) return false;
  const rMin = Math.min(ui.selection.r1, ui.selection.r2);
  const rMax = Math.max(ui.selection.r1, ui.selection.r2);
  const cMin = Math.min(ui.selection.c1, ui.selection.c2);
  const cMax = Math.max(ui.selection.c1, ui.selection.c2);
  return r >= rMin && r <= rMax && c >= cMin && c <= cMax;
}

function updateSelectionVisuals() {
  for (let r = 0; r < curPat().rows; r++) {
    if (!cellEls[r]) continue;
    for (let c = 0; c < song.channels.length; c++) {
      if (cellEls[r][c]) cellEls[r][c].classList.toggle("selected", isSelected(r, c));
    }
  }
}

/* ================= vu meters + view toggles ================= */
let vuCanvases = [];
let fxBtns = [];
let vuLevels = [];
let vuRaf = null;
const vuData = new Uint8Array(256);

function startVuLoop() {
  if (vuRaf == null && ui.showVU) vuRaf = requestAnimationFrame(vuTick);
}
function vuTick() {
  if (!ui.showVU) { vuRaf = null; return; }
  for (let i = 0; i < chains.length; i++) {
    const cv = vuCanvases[i];
    const an = chains[i] && chains[i].analyser;
    if (!cv || !an) continue;
    an.getByteTimeDomainData(vuData);
    let peak = 0;
    for (let j = 0; j < vuData.length; j++) {
      const v = Math.abs(vuData[j] - 128) / 128;
      if (v > peak) peak = v;
    }
    vuLevels[i] = Math.max(peak, (vuLevels[i] || 0) * 0.88);
    const g = cv.getContext("2d");
    g.fillStyle = "#191d24";
    g.fillRect(0, 0, cv.width, cv.height);
    const wpx = Math.min(1, vuLevels[i]) * cv.width;
    g.fillStyle = vuLevels[i] > 0.92 ? "#d05050" : "#f2a33c";
    g.fillRect(0, 0, wpx, cv.height);
  }
  vuRaf = requestAnimationFrame(vuTick);
}

function setFxChannel(c) {
  ui.fxChannel = c;
  fxBtns.forEach((b, i) => { if (b) b.classList.toggle("fx-open", i === c); });
  renderFxPanel();
}

/* ================= waveform overlay =================
   One transparent canvas floated over the whole grid (pointer-events: none).
   Redrawn ONLY when pattern data / buffers / tempo change — never per frame —
   so the audio scheduler and grid input never feel it. */
let waveCanvas = null;
let waveDrawPending = false;

function scheduleWaveDraw() {
  if (waveDrawPending) return;
  waveDrawPending = true;
  requestAnimationFrame(() => {
    waveDrawPending = false;
    drawWaveOverlay();
  });
}

function drawWaveOverlay() {
  if (!ui.showWave) return;
  if (!waveCanvas || !laneEls.length || !cellEls.length) return;
  const pat = curPat();
  const cell0 = cellEls[0] && cellEls[0][0];
  if (!cell0) return;
  const cellW = cell0.offsetWidth;
  if (!cellW) return;
  const lastLane = laneEls[laneEls.length - 1];
  const w = grid.scrollWidth;
  const h = lastLane.offsetTop + lastLane.offsetHeight;
  if (waveCanvas.width !== w) waveCanvas.width = w;
  if (waveCanvas.height !== h) waveCanvas.height = h;
  waveCanvas.style.width = w + "px";
  waveCanvas.style.height = h + "px";
  const c2d = waveCanvas.getContext("2d");
  c2d.clearRect(0, 0, w, h);
  const spr = secPerRow();
  const secPerPix = spr / cellW; // horizontal time scale

  for (let c = 0; c < song.channels.length; c++) {
    const lane = laneEls[c];
    if (!lane) continue;
    const xBase = cellEls[0][c].offsetLeft;
    const cy = lane.offsetTop + lane.offsetHeight / 2;
    const ampMax = lane.offsetHeight / 2 - 4;
    c2d.fillStyle = chTint(c, 0.5);

    /* flatten this channel into fractional-row events (split cells included) */
    const evts = [];
    for (let r = 0; r < pat.rows; r++) {
      for (const ev of cellEvents(pat.data[r][c])) {
        evts.push({ pos: r + ev.frac, note: ev.note, inst: ev.inst, vol: ev.vol });
      }
    }

    for (let k = 0; k < evts.length; k++) {
      const ev = evts[k];
      if (ev.note == null || ev.note === NOTE_OFF) continue;
      const instNum = ev.inst != null ? ev.inst : ui.curInstrument + 1;
      const inst = song.instruments[instNum - 1];
      if (!inst) continue;
      const buf = buffers.get(inst.path);
      if (!buf) continue;

      /* cut where the audio engine cuts: the next event on this channel */
      const cutPos = k + 1 < evts.length ? evts[k + 1].pos : pat.rows;
      const rate = Math.pow(2, (ev.note - BASE_NOTE) / 12);
      const durRows = Math.min(buf.duration / rate / spr, cutPos - ev.pos);
      const pixels = Math.max(1, Math.floor(durRows * cellW));
      const data = buf.getChannelData(0);
      const srcRate = buf.sampleRate;
      const volScale = (ev.vol == null ? 64 : ev.vol) / 64;
      const xStart = xBase + ev.pos * cellW;

      for (let p = 0; p < pixels; p++) {
        const t0 = p * secPerPix * rate;
        const t1 = (p + 1) * secPerPix * rate;
        const i0 = Math.floor(t0 * srcRate);
        if (i0 >= data.length) break;
        const i1 = Math.min(data.length, Math.max(i0 + 1, Math.floor(t1 * srcRate)));
        let mn = 1, mx = -1;
        const step = Math.max(1, Math.floor((i1 - i0) / 24));
        for (let i = i0; i < i1; i += step) {
          const v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const y0 = cy + mn * ampMax * volScale;
        const y1 = cy + mx * ampMax * volScale;
        c2d.fillRect(xStart + p, y0, 1, Math.max(1, y1 - y0));
      }
    }
  }
}

function renderGrid() {
  const pat = curPat();
  grid.innerHTML = "";
  cellEls = [];
  laneEls = [];
  vuCanvases = [];
  fxBtns = [];
  const rpb = song.rowsPerBeat;

  /* time ruler across the top */
  const head = document.createElement("div");
  head.className = "ruler-row";
  const corner = document.createElement("div");
  corner.className = "ruler-corner";
  head.appendChild(corner);
  for (let r = 0; r < pat.rows; r++) {
    const t = document.createElement("div");
    t.className = "rul";
    if (r % (rpb * 4) === 0) t.classList.add("bar");
    else if (r % rpb === 0) t.classList.add("beat");
    t.textContent = String(r).padStart(2, "0");
    head.appendChild(t);
  }
  grid.appendChild(head);

  for (let r = 0; r < pat.rows; r++) cellEls.push([]);

  /* one horizontal lane per channel — video-editor style */
  song.channels.forEach((ch, i) => {
    const lane = document.createElement("div");
    lane.className = "chlane";

    const hdr = document.createElement("div");
    hdr.className = "ch-hdr";
    const name = document.createElement("input");
    name.className = "ch-name";
    name.value = ch.name;
    name.addEventListener("change", () => { ch.name = name.value; autosave(); });
    const mute = document.createElement("button");
    mute.textContent = "M";
    mute.title = "Mute";
    mute.classList.toggle("on-mute", ch.mute);
    mute.addEventListener("click", () => {
      ch.mute = !ch.mute;
      mute.classList.toggle("on-mute", ch.mute);
      refreshChainParams();
      scheduleWaveDraw();
      autosave();
    });
    const solo = document.createElement("button");
    solo.textContent = "S";
    solo.title = "Solo";
    solo.classList.toggle("on-solo", ch.solo);
    solo.addEventListener("click", () => {
      ch.solo = !ch.solo;
      solo.classList.toggle("on-solo", ch.solo);
      refreshChainParams();
      autosave();
    });
    const fxb = document.createElement("button");
    fxb.textContent = "STRIP";
    fxb.title = "Channel Strip & FX";
    fxb.classList.toggle("fx-open", ui.fxChannel === i);
    fxb.addEventListener("click", () => setFxChannel(i));
    fxBtns[i] = fxb;
    const chTop = document.createElement("div");
    chTop.className = "ch-top";
    chTop.append(mute, solo, fxb);
    const vu = document.createElement("canvas");
    vu.className = "vu";
    vu.width = 166; vu.height = 6;
    vu.style.display = ui.showVU ? "" : "none";
    vuCanvases[i] = vu;
    hdr.append(name, chTop, vu);
    lane.appendChild(hdr);

    for (let r = 0; r < pat.rows; r++) {
      const cellEl = document.createElement("div");
      cellEl.className = "pcell";
      if (r % (rpb * 4) === 0) cellEl.classList.add("bar");
      else if (r % rpb === 0) cellEl.classList.add("beat");
      if (r === ui.cursor.row && i === ui.cursor.ch) cellEl.classList.add("curcell");
      if (isSelected(r, i)) cellEl.classList.add("selected");

      paintCell(cellEl, pat.data[r][i], r, i);
      cellEl.addEventListener("mousedown", (e) => {
        const sub = e.target.dataset && e.target.dataset.sub != null
          ? Number(e.target.dataset.sub) : 0;
        const slot = e.target.dataset && e.target.dataset.slot != null
          ? Number(e.target.dataset.slot) : 0;

        /* manual double-click: the first click repaints the cell, which
           destroys the original click target, so native dblclick never
           fires. Two clicks on the same cell within 350ms = split cycle. */
        const now = performance.now();
        if (!e.shiftKey && gridLastClick
            && gridLastClick.r === r && gridLastClick.c === i
            && now - gridLastClick.t < 350) {
          gridLastClick = null;
          cycleSplit(r, i);
          e.preventDefault();
          return;
        }
        gridLastClick = { r, c: i, t: now };

        if (e.shiftKey) {
          if (!ui.selection) {
            ui.selection = { r1: ui.cursor.row, c1: ui.cursor.ch, r2: r, c2: i };
          } else {
            ui.selection.r2 = r;
            ui.selection.c2 = i;
          }
        } else {
          ui.selection = null;
        }

        setCursor(r, i, sub, slot);
        if (ui.fxChannel !== i) setFxChannel(i);
        updateSelectionVisuals();
        grid.focus();
        e.preventDefault();
      });
      cellEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const slot = e.target.dataset && e.target.dataset.slot != null
          ? Number(e.target.dataset.slot) : 0;
        openCellSampleEditor(r, i, slot);
      });
      lane.appendChild(cellEl);
      cellEls[r][i] = cellEl;
    }
    grid.appendChild(lane);
    laneEls.push(lane);
  });

  /* overlays: wave ribbons + playhead line (both click-through) */
  waveCanvas = document.createElement("canvas");
  waveCanvas.id = "wave-overlay";
  waveCanvas.style.display = ui.showWave ? "" : "none";
  grid.appendChild(waveCanvas);
  playline = document.createElement("div");
  playline.id = "playline";
  playline.style.display = "none";
  grid.appendChild(playline);
  scheduleWaveDraw();
  renderCellInspector();
}

function paintCell(el, cell, r, c) {
  el.innerHTML = "";
  el.classList.remove("split-cell");
  const hasNote = cellEvents(cell).some((ev) => ev.note !== NOTE_OFF);
  el.classList.toggle("has-note", hasNote);
  if (hasNote) el.style.setProperty("--tint-bg", chTint(c, 0.13));
  const isCur = r === ui.cursor.row && c === ui.cursor.ch;

  if (cell && cell.split && cell.subs) {
    el.classList.add("split-cell");
    cell.subs.forEach((sub, i) => {
      const slotEl = document.createElement("span");
      slotEl.className = "slot";
      const txt = sub ? shortNote(sub.note) : "\u00b7\u00b7";
      slotEl.textContent = txt;
      if (txt === "\u00b7\u00b7") slotEl.classList.add("empty");
      slotEl.dataset.slot = i;
      slotEl.dataset.sub = 0;
      if (isCur && ui.cursor.slot === i) slotEl.classList.add("cursor-sub");
      el.appendChild(slotEl);
    });
    return;
  }

  const mk = (txt, cls, sub) => {
    const span = document.createElement("span");
    span.textContent = txt;
    span.className = cls + (txt.startsWith(".") || txt === "..." ? " empty" : "");
    span.dataset.sub = sub;
    if (isCur && ui.cursor.sub === sub) span.classList.add("cursor-sub");
    return span;
  };
  const note = cell ? cell.note : null;
  const inst = cell ? cell.inst : null;
  const vol = cell ? cell.vol : null;
  el.appendChild(mk(noteName(note), "s-note", 0));
  el.appendChild(document.createTextNode(" "));
  el.appendChild(mk(fmt2(inst), "s-inst", 1));
  el.appendChild(document.createTextNode(" "));
  el.appendChild(mk(vol == null ? "v.." : "v" + String(vol).padStart(2, "0"), "s-vol", 2));
}

function repaintCell(r, c) {
  const el = cellEls[r] && cellEls[r][c];
  if (el) paintCell(el, curPat().data[r][c], r, c);
}

function setCursor(row, ch, sub, slot) {
  const pat = curPat();
  const old = { ...ui.cursor };
  ui.cursor.row = Math.max(0, Math.min(pat.rows - 1, row));
  ui.cursor.ch = Math.max(0, Math.min(song.channels.length - 1, ch));
  ui.cursor.sub = ((sub % SUBS) + SUBS) % SUBS;
  const cCell = pat.data[ui.cursor.row] && pat.data[ui.cursor.row][ui.cursor.ch];
  const maxSlot = cCell && cCell.split ? cCell.split - 1 : 0;
  ui.cursor.slot = Math.max(0, Math.min(maxSlot, slot == null ? 0 : slot));
  if (cellEls[old.row] && cellEls[old.row][old.ch]) {
    cellEls[old.row][old.ch].classList.remove("curcell");
  }
  repaintCell(old.row, old.ch);
  const cur = cellEls[ui.cursor.row] && cellEls[ui.cursor.row][ui.cursor.ch];
  if (cur) {
    cur.classList.add("curcell");
    cur.scrollIntoView({ inline: "nearest", block: "nearest" });
  }
  repaintCell(ui.cursor.row, ui.cursor.ch);
  renderCellInspector();
}

function getOrMakeCell(r, c) {
  const pat = curPat();
  if (!pat.data[r][c]) pat.data[r][c] = { note: null, inst: null, vol: null };
  return pat.data[r][c];
}

/* ---- cell splitting: one cell can hold 2/3/4 evenly-timed hits ---- */
function cellEvents(cell) {
  // normalize any cell into [{frac, note, inst, vol}] - frac is 0..1 within the row
  if (!cell) return [];
  if (cell.split && cell.subs) {
    const out = [];
    cell.subs.forEach((sub, i) => {
      if (sub && sub.note != null) {
        out.push({ frac: i / cell.split, note: sub.note, inst: sub.inst, vol: sub.vol });
      }
    });
    return out;
  }
  if (cell.note != null) return [{ frac: 0, note: cell.note, inst: cell.inst, vol: cell.vol }];
  return [];
}

function ensureSlot(cell, i) {
  if (!cell.subs[i]) cell.subs[i] = { note: null, inst: null, vol: null };
  return cell.subs[i];
}

function shortNote(n) {
  if (n === NOTE_OFF) return "==";
  if (n == null) return "\u00b7\u00b7";
  return NOTE_NAMES[n % 12].replace("-", "") + Math.floor(n / 12);
}

function setSplit(row, ch, n) {
  const pat = curPat();
  const cell = pat.data[row][ch];
  const cur = cell && cell.split ? cell.split : 1;
  if (n === cur) return;
  if (n === 1) {
    const first = cell && cell.subs
      ? (cell.subs.find((sub) => sub && sub.note != null) || cell.subs[0])
      : null;
    pat.data[row][ch] = first
      ? { note: first.note, inst: first.inst, vol: first.vol }
      : null;
  } else {
    const subs = Array(n).fill(null);
    if (cell) {
      if (cell.split && cell.subs) {
        cell.subs.forEach((sub, i) => { if (i < n) subs[i] = sub; });
      } else if (cell.note != null || cell.inst != null || cell.vol != null) {
        subs[0] = { note: cell.note, inst: cell.inst, vol: cell.vol };
      }
    }
    pat.data[row][ch] = { split: n, subs };
  }
  ui.cursor.slot = 0;
  repaintCell(row, ch);
  scheduleWaveDraw();
  renderCellInspector();
  autosave();
}

function cycleSplit(row, ch) {
  const cell = curPat().data[row][ch];
  const cur = cell && cell.split ? cell.split : 1;
  const next = cur >= 4 ? 1 : cur + 1;
  setSplit(row, ch, next);
  toast(next === 1 ? "Cell merged back to one hit" : "Cell split into " + next + " hits");
}

/* ================= keyboard entry ================= */
grid.addEventListener("keydown", (e) => {
  const k = e.key;
  const cur = ui.cursor;
  const pat = curPat();

  // Copy / Paste Handling
  if (e.ctrlKey || e.metaKey) {
    if (k.toLowerCase() === 'a') {
      ui.selection = { r1: 0, c1: 0, r2: pat.rows - 1, c2: song.channels.length - 1 };
      updateSelectionVisuals();
      e.preventDefault(); return;
    }
    if (k.toLowerCase() === 'c' && ui.selection) {
      const rMin = Math.min(ui.selection.r1, ui.selection.r2);
      const rMax = Math.max(ui.selection.r1, ui.selection.r2);
      const cMin = Math.min(ui.selection.c1, ui.selection.c2);
      const cMax = Math.max(ui.selection.c1, ui.selection.c2);
      ui.clipboard = [];
      for(let r = rMin; r <= rMax; r++) {
        let rowData = [];
        for(let c = cMin; c <= cMax; c++) {
          const cell = pat.data[r][c];
          rowData.push(cell ? JSON.parse(JSON.stringify(cell)) : null);
        }
        ui.clipboard.push(rowData);
      }
      toast("Copied " + ui.clipboard.length + " rows");
      e.preventDefault(); return;
    }
    if (k.toLowerCase() === 'v' && ui.clipboard) {
      for(let r = 0; r < ui.clipboard.length; r++) {
        const tgtR = cur.row + r;
        if (tgtR >= pat.rows) break;
        for(let c = 0; c < ui.clipboard[r].length; c++) {
          const tgtC = cur.ch + c;
          if (tgtC >= song.channels.length) break;
          pat.data[tgtR][tgtC] = ui.clipboard[r][c] ? JSON.parse(JSON.stringify(ui.clipboard[r][c])) : null;
        }
      }
      renderGrid();
      autosave();
      toast("Pasted");
      e.preventDefault(); return;
    }
    return;
  }

  // Navigation Logic
  let nextRow = cur.row, nextCh = cur.ch, nextSub = cur.sub;
  let nextSlot = cur.slot || 0;
  const navCell = pat.data[cur.row] && pat.data[cur.row][cur.ch];
  const navSplit = navCell && navCell.split ? navCell.split : 1;
  let nav = false;

  if (k === "ArrowUp")    { nextCh--; nav = true; }
  else if (k === "ArrowDown")  { nextCh++; nav = true; }
  else if (k === "ArrowLeft")  {
    if (e.shiftKey) { nextRow--; nextSlot = 0; nav = true; }
    else if (navSplit > 1) {
      if (nextSlot > 0) nextSlot--;
      else if (nextRow > 0) { nextRow--; nextSub = SUBS - 1; nextSlot = 0; }
      nav = true;
    }
    else { if (nextSub > 0) nextSub--; else if (nextRow > 0) { nextRow--; nextSub = SUBS - 1; nextSlot = 0; } nav = true; }
  }
  else if (k === "ArrowRight") {
    if (e.shiftKey) { nextRow++; nextSlot = 0; nav = true; }
    else if (navSplit > 1) {
      if (nextSlot < navSplit - 1) nextSlot++;
      else if (nextRow < pat.rows - 1) { nextRow++; nextSub = 0; nextSlot = 0; }
      nav = true;
    }
    else { if (nextSub < SUBS - 1) nextSub++; else if (nextRow < pat.rows - 1) { nextRow++; nextSub = 0; nextSlot = 0; } nav = true; }
  }
  else if (k === "Tab") {
    nextRow += e.shiftKey ? -1 : 1; nextSub = 0; nextSlot = 0; nav = true;
  }
  else if (k === "PageDown") { nextRow += 16; nav = true; }
  else if (k === "PageUp")   { nextRow -= 16; nav = true; }
  else if (k === "Home")     { nextRow = 0; nav = true; }
  else if (k === "End")      { nextRow = pat.rows - 1; nav = true; }

  if (nav) {
    nextRow = Math.max(0, Math.min(pat.rows - 1, nextRow));
    nextCh = Math.max(0, Math.min(song.channels.length - 1, nextCh));
    
    // Shift selection
    if (e.shiftKey && (k.startsWith("Arrow") || k.startsWith("Page") || k === "Home" || k === "End")) {
      if (!ui.selection) {
        ui.selection = { r1: cur.row, c1: cur.ch, r2: nextRow, c2: nextCh };
      } else {
        ui.selection.r2 = nextRow;
        ui.selection.c2 = nextCh;
      }
    } else if (!e.shiftKey) {
      ui.selection = null;
    }
    setCursor(nextRow, nextCh, nextSub, nextSlot);
    updateSelectionVisuals();
    e.preventDefault(); return;
  }

  // Deletions
  if (k === "Delete" || k === "Backspace") {
    if (ui.selection) { 
      const rMin = Math.min(ui.selection.r1, ui.selection.r2);
      const rMax = Math.max(ui.selection.r1, ui.selection.r2);
      const cMin = Math.min(ui.selection.c1, ui.selection.c2);
      const cMax = Math.max(ui.selection.c1, ui.selection.c2);
      for(let r = rMin; r <= rMax; r++) {
        for(let c = cMin; c <= cMax; c++) pat.data[r][c] = null;
      }
      ui.selection = null;
      renderGrid();
    } else {
      const cell = pat.data[cur.row][cur.ch];
      if (cell && cell.split) {
        cell.subs[cur.slot] = null;
        if (cell.subs.every((sub) => !sub)) pat.data[cur.row][cur.ch] = null;
      } else if (cell) {
        if (cur.sub === 0) pat.data[cur.row][cur.ch] = null;
        else if (cur.sub === 1) cell.inst = null;
        else cell.vol = null;
      }
      repaintCell(cur.row, cur.ch);
    }
    scheduleWaveDraw();
    renderCellInspector();
    autosave();
    e.preventDefault(); return;
  }
  
  if (k === ".") {
    const cell = pat.data[cur.row][cur.ch];
    if (cell) {
      if (cur.sub === 0) cell.note = null;
      else if (cur.sub === 1) cell.inst = null;
      else cell.vol = null;
    }
    repaintCell(cur.row, cur.ch);
    scheduleWaveDraw();
    renderCellInspector();
    autosave();
    e.preventDefault(); return;
  }

  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;

  /* note-off */
  if (k === "`" && cur.sub === 0) {
    if (ui.editMode) {
      const cell = getOrMakeCell(cur.row, cur.ch);
      if (cell.split) {
        cell.subs[cur.slot] = { note: NOTE_OFF, inst: null, vol: null };
        repaintCell(cur.row, cur.ch);
        if (cur.slot < cell.split - 1) setCursor(cur.row, cur.ch, 0, cur.slot + 1);
        else setCursor(cur.row + 1, cur.ch, 0, 0);
      } else {
        cell.note = NOTE_OFF; cell.inst = null; cell.vol = null;
        repaintCell(cur.row, cur.ch);
        setCursor(cur.row + 1, cur.ch, 0);
      }
      scheduleWaveDraw();
      autosave();
    }
    e.preventDefault(); return;
  }

  /* note keys */
  if (cur.sub === 0 && KEYMAP[k.toLowerCase()] != null) {
    const midi = ui.octave * 12 + KEYMAP[k.toLowerCase()];
    if (midi <= 119) {
      keyjazz(midi, cur.ch);
      if (ui.editMode) {
        const cell = getOrMakeCell(cur.row, cur.ch);
        if (cell.split) {
          cell.subs[cur.slot] = {
            note: midi,
            inst: song.instruments.length ? ui.curInstrument + 1 : null,
            vol: null,
          };
          repaintCell(cur.row, cur.ch);
          if (cur.slot < cell.split - 1) setCursor(cur.row, cur.ch, 0, cur.slot + 1);
          else setCursor(cur.row + 1, cur.ch, 0, 0);
        } else {
          cell.note = midi;
          cell.inst = song.instruments.length ? ui.curInstrument + 1 : null;
          repaintCell(cur.row, cur.ch);
          setCursor(cur.row + 1, cur.ch, 0);
        }
        scheduleWaveDraw();
        autosave();
      }
    }
    e.preventDefault(); return;
  }

  /* digit entry on inst / vol subcolumns */
  if (cur.sub > 0 && /^[0-9]$/.test(k)) {
    const cell = getOrMakeCell(cur.row, cur.ch);
    const d = Number(k);
    if (cur.sub === 1) {
      cell.inst = ((cell.inst || 0) % 10) * 10 + d;
      if (cell.inst > 99) cell.inst = d;
    } else {
      cell.vol = Math.min(64, ((cell.vol || 0) % 10) * 10 + d);
    }
    repaintCell(cur.row, cur.ch);
    scheduleWaveDraw();
    renderCellInspector();
    autosave();
    e.preventDefault(); return;
  }
});

function keyjazz(midi, chIdx) {
  const inst = song.instruments[ui.curInstrument];
  if (!inst) return;
  const buf = buffers.get(inst.path);
  if (!buf) return;
  AC.resume();
  ensureChains();
  const src = AC.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.pow(2, (midi - BASE_NOTE) / 12);
  src.connect(chains[chIdx].input);
  src.start();
}

/* ================= playback scheduler ================= */
let playState = null; 
const channelActive = {}; 

function scheduleRow(patIdx, row, time, ctx, chainSet, activeMap) {
  const pat = song.patterns[patIdx];
  const spr = secPerRow();
  for (let c = 0; c < song.channels.length; c++) {
    for (const ev of cellEvents(pat.data[row][c])) {
      const t = time + ev.frac * spr;
      if (ev.note === NOTE_OFF) {
        const prev = activeMap[c];
        if (prev) { try { prev.stop(t); } catch (_) {} activeMap[c] = null; }
        continue;
      }
      const instNum = ev.inst != null ? ev.inst : ui.curInstrument + 1;
      const inst = song.instruments[instNum - 1];
      if (!inst) continue;
      const buf = buffers.get(inst.path);
      if (!buf) continue;
      const prev = activeMap[c];
      if (prev) { try { prev.stop(t); } catch (_) {} }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.pow(2, (ev.note - BASE_NOTE) / 12);
      const vg = ctx.createGain();
      vg.gain.value = (ev.vol == null ? 64 : ev.vol) / 64;
      src.connect(vg);
      vg.connect(chainSet[c].input);
      src.start(t);
      activeMap[c] = src;
    }
  }
}

function schedulerTick() {
  if (!playState) return;
  const spr = secPerRow();
  while (playState && playState.nextTime < AC.currentTime + 0.15) {
    scheduleRow(playState.patIdx, playState.row, playState.nextTime, AC, chains, channelActive);
    playState.queue.push({ time: playState.nextTime, row: playState.row,
                           patIdx: playState.patIdx, orderPos: playState.orderPos });
    playState.nextTime += spr;
    playState.row++;
    const pat = song.patterns[playState.patIdx];
    if (playState.row >= pat.rows) {
      playState.row = 0;
      if (playState.songMode && playState.seq.length) {
        playState.orderPos = (playState.orderPos + 1) % playState.seq.length;
        playState.patIdx = playState.seq[playState.orderPos] ?? playState.patIdx;
      }
    }
  }
}

let rafId = null;
function rafHighlight() {
  if (!playState) return;
  const now = AC.currentTime;
  let last = null;
  while (playState.queue.length && playState.queue[0].time <= now) {
    last = playState.queue.shift();
  }
  if (last) {
    if (last.patIdx !== ui.curPattern) {
      ui.curPattern = last.patIdx;
      $("#pattern-select").value = String(last.patIdx);
      $("#pattern-rows").value = curPat().rows;
      renderGrid();
    }
    const refCell = cellEls[last.row] && cellEls[last.row][0];
    if (playline && refCell) {
      playline.style.display = "";
      playline.style.left = refCell.offsetLeft + "px";
      playline.style.height = (laneEls.length
        ? laneEls[laneEls.length - 1].offsetTop + laneEls[laneEls.length - 1].offsetHeight
        : grid.scrollHeight) + "px";
      refCell.scrollIntoView({ inline: "center", block: "nearest" });
    }
    // Musicians count from 1, not 0 -- a raw "row 47" readout has no
    // relationship to how a 4/4 bar actually feels. Convert to the
    // standard Bar.Beat.Tick a tracker/DAW position display shows:
    // bar and beat always start at 1, wrapping every 4 beats (one bar)
    // and every rowsPerBeat rows (one beat) respectively.
    const rpb = song.rowsPerBeat;
    const rowsPerBar = rpb * 4;
    const bar = Math.floor(last.row / rowsPerBar) + 1;
    const beat = Math.floor((last.row % rowsPerBar) / rpb) + 1;
    const tick = (last.row % rpb) + 1;
    $("#pos-display").textContent =
      "P" + (last.patIdx + 1) + " " + bar + "." + beat + "." + tick;
    renderOrderChips(song.order.length ? last.orderPos : null);
  }
  rafId = requestAnimationFrame(rafHighlight);
}

async function startPlayback(songMode) {
  stopPlayback();
  await AC.resume();
  ensureChains();
  /* song mode: follow the order list; if the order is empty,
     fall back to every pattern in sequence so Play Song always
     plays the whole song. */
  const seq = song.order.length
    ? song.order.slice()
    : song.patterns.map((_, i) => i);
  playState = {
    songMode,
    seq: songMode ? seq : [],
    orderPos: songMode ? 0 : null,
    patIdx: songMode ? seq[0] : ui.curPattern,
    row: 0,
    nextTime: AC.currentTime + 0.08,
    queue: [],
    timer: setInterval(schedulerTick, 25),
  };
  rafHighlight();
}

function stopPlayback() {
  if (playState) {
    clearInterval(playState.timer);
    playState = null;
  }
  cancelAnimationFrame(rafId);
  for (const k of Object.keys(channelActive)) {
    const s = channelActive[k];
    if (s) { try { s.stop(); } catch (_) {} }
    channelActive[k] = null;
  }
  if (playline) playline.style.display = "none";
  renderOrderChips(null);
}

$("#btn-play-pat").addEventListener("click", () => startPlayback(false));
$("#btn-play-song").addEventListener("click", () => startPlayback(true));
$("#btn-play-song-top").addEventListener("click", () => startPlayback(true));
$("#btn-play-song-order").addEventListener("click", () => startPlayback(true));
$("#btn-stop").addEventListener("click", stopPlayback);

document.addEventListener("keydown", (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.code === "Space") {
    e.preventDefault();
    if (playState) stopPlayback();
    else startPlayback(e.shiftKey);
  }
  if (e.key === "Escape") stopPlayback();
});

/* ================= toolbar ================= */
$("#bpm").addEventListener("change", () => {
  const v = parseFloat($("#bpm").value);
  if (v >= 30 && v <= 300) { song.bpm = v; scheduleWaveDraw(); autosave(); }
});
$("#rpb").addEventListener("change", () => {
  const v = parseInt($("#rpb").value, 10);
  if (v >= 1 && v <= 16) { song.rowsPerBeat = v; renderGrid(); autosave(); }
});
$("#octave").addEventListener("change", () => {
  const v = parseInt($("#octave").value, 10);
  if (v >= 1 && v <= 8) { ui.octave = v; autosave(); }
});
$("#btn-edit").addEventListener("click", () => {
  ui.editMode = !ui.editMode;
  $("#btn-edit").classList.toggle("toggled", ui.editMode);
});

function syncViewToggles() {
  $("#btn-wave").classList.toggle("toggled", ui.showWave);
  $("#btn-vu").classList.toggle("toggled", ui.showVU);
}
$("#btn-wave").addEventListener("click", () => {
  ui.showWave = !ui.showWave;
  syncViewToggles();
  if (waveCanvas) waveCanvas.style.display = ui.showWave ? "" : "none";
  if (ui.showWave) scheduleWaveDraw();
  autosave();
});
$("#btn-vu").addEventListener("click", () => {
  ui.showVU = !ui.showVU;
  syncViewToggles();
  vuCanvases.forEach((c) => { if (c) c.style.display = ui.showVU ? "" : "none"; });
  if (ui.showVU) startVuLoop();
  autosave();
});

function applyZoom() {
  document.documentElement.style.setProperty("--cell-w", ui.zoom + "px");
  scheduleWaveDraw();
  const cur = cellEls[ui.cursor.row] && cellEls[ui.cursor.row][ui.cursor.ch];
  if (cur) cur.scrollIntoView({ inline: "nearest", block: "nearest" });
}
$("#zoom-in").addEventListener("click", () => {
  ui.zoom = Math.min(240, Math.round(ui.zoom * 1.25));
  applyZoom();
  autosave();
});
$("#zoom-out").addEventListener("click", () => {
  ui.zoom = Math.max(40, Math.round(ui.zoom / 1.25));
  applyZoom();
  autosave();
});
$("#master-vol").addEventListener("input", (e) => {
  master.gain.value = parseFloat(e.target.value);
  autosave();
});
$("#btn-help").addEventListener("click", () => { $("#help-overlay").hidden = false; });
$("#help-close").addEventListener("click", () => { $("#help-overlay").hidden = true; });
$("#help-overlay").addEventListener("mousedown", (e) => {
  if (e.target === $("#help-overlay")) $("#help-overlay").hidden = true;
});
$("#help-nav").addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a) return;
  e.preventDefault();
  const id = a.getAttribute("href").slice(1);
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ block: "start" });
});
window.addEventListener("keydown", (e) => {
  if (e.key === "F1") {
    e.preventDefault();
    $("#help-overlay").hidden = !$("#help-overlay").hidden;
  } else if (e.key === "Escape" && !$("#help-overlay").hidden) {
    $("#help-overlay").hidden = true;
  }
});

$("#btn-add-channel").addEventListener("click", () => {
  song.channels.push(makeChannel(song.channels.length + 1));
  for (const p of song.patterns) {
    for (const row of p.data) row.push(null);
  }
  ensureChains();
  renderGrid();
  autosave();
});
$("#btn-rm-channel").addEventListener("click", () => {
  if (song.channels.length <= 1) return;
  song.channels.pop();
  for (const p of song.patterns) {
    for (const row of p.data) row.pop();
  }
  chains.pop();
  ui.fxChannel = Math.min(ui.fxChannel, song.channels.length - 1);
  ui.cursor.ch = Math.min(ui.cursor.ch, song.channels.length - 1);
  if (ui.selection) ui.selection = null;
  renderGrid();
  renderFxPanel();
  autosave();
});

/* patterns */
function refreshPatternSelect() {
  const sel = $("#pattern-select");
  sel.innerHTML = "";
  song.patterns.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = "Pat " + String(i).padStart(2, "0");
    sel.appendChild(opt);
  });
  sel.value = String(ui.curPattern);
  $("#pattern-rows").value = curPat().rows;
}
$("#pattern-select").addEventListener("change", (e) => {
  ui.curPattern = Number(e.target.value);
  ui.cursor.row = 0;
  ui.selection = null;
  $("#pattern-rows").value = curPat().rows;
  renderGrid();
  autosave();
});
$("#btn-add-pattern").addEventListener("click", () => {
  song.patterns.push(makePattern(64, song.channels.length));
  ui.curPattern = song.patterns.length - 1;
  refreshPatternSelect();
  renderGrid();
  autosave();
});
$("#btn-dup-pattern").addEventListener("click", () => {
  // Deep copy so editing the duplicate never mutates the original --
  // lands in the next free slot automatically since patterns are just
  // an array and "Pat NN" labels are derived from index, not stored.
  const copy = JSON.parse(JSON.stringify(curPat()));
  song.patterns.push(copy);
  ui.curPattern = song.patterns.length - 1;
  refreshPatternSelect();
  renderGrid();
  autosave();
  toast("Duplicated into Pat " + String(ui.curPattern).padStart(2, "0"));
});
$("#btn-rm-pattern").addEventListener("click", () => {
  if (song.patterns.length <= 1) { toast("A song needs at least one pattern"); return; }
  const removed = ui.curPattern;
  if (!confirm("Delete Pat " + String(removed).padStart(2, "0") + "? This can't be undone.")) return;
  song.patterns.splice(removed, 1);
  // The arrangement order stores raw pattern indices -- removing a
  // pattern shifts every later index down by one, and any order entry
  // that pointed at the deleted pattern has to go too, or playback
  // would silently point at the wrong pattern (or one that no longer
  // exists) after this.
  song.order = song.order
    .filter((idx) => idx !== removed)
    .map((idx) => (idx > removed ? idx - 1 : idx));
  ui.curPattern = Math.min(removed, song.patterns.length - 1);
  ui.selection = null;
  refreshPatternSelect();
  renderOrderChips(null);
  renderGrid();
  autosave();
  toast("Deleted Pat " + String(removed).padStart(2, "0"));
});
$("#pattern-rows").addEventListener("change", () => {
  const v = parseInt($("#pattern-rows").value, 10);
  if (!(v >= 8 && v <= 256)) return;
  const pat = curPat();
  while (pat.data.length < v) pat.data.push(Array(song.channels.length).fill(null));
  pat.data.length = v;
  pat.rows = v;
  ui.cursor.row = Math.min(ui.cursor.row, v - 1);
  renderGrid();
  autosave();
});

/* order list */
function renderOrderChips(playingPos) {
  const wrap = $("#order-chips");
  wrap.innerHTML = "";
  song.order.forEach((patIdx, i) => {
    const chip = document.createElement("div");
    chip.className = "order-chip";
    if (playingPos != null && i === playingPos) chip.classList.add("playing-chip");
    const label = document.createElement("span");
    label.textContent = String(patIdx).padStart(2, "0");
    chip.appendChild(label);
    const x = document.createElement("button");
    x.className = "chip-x";
    x.textContent = "\u00d7";
    x.title = "Remove from order";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      song.order.splice(i, 1);
      renderOrderChips(null);
      autosave();
    });
    chip.appendChild(x);
    chip.addEventListener("click", () => {
      ui.curPattern = patIdx;
      refreshPatternSelect();
      renderGrid();
    });
    wrap.appendChild(chip);
  });
}
$("#btn-order-add").addEventListener("click", () => {
  song.order.push(ui.curPattern);
  renderOrderChips(null);
  autosave();
});

/* ================= fx panel ================= */
function fxParamRow(labelTxt, min, max, step, value, fmt, onInput) {
  const row = document.createElement("div");
  row.className = "fx-param";
  const label = document.createElement("label");
  label.textContent = labelTxt;
  const range = document.createElement("input");
  range.type = "range";
  range.min = min; range.max = max; range.step = step; range.value = value;
  const pv = document.createElement("span");
  pv.className = "pv";
  pv.textContent = fmt(value);
  range.addEventListener("input", () => {
    const v = parseFloat(range.value);
    pv.textContent = fmt(v);
    onInput(v);
    refreshChainParams();
    autosave();
  });
  row.append(label, range, pv);
  return row;
}

function fxUnit(title, fxObj, buildParams) {
  const unit = document.createElement("div");
  unit.className = "fx-unit";
  const head = document.createElement("div");
  head.className = "fx-unit-head";
  const t = document.createElement("span");
  t.textContent = title;
  const btn = document.createElement("button");
  btn.textContent = fxObj.on ? "ON" : "OFF";
  btn.classList.toggle("fx-on", fxObj.on);
  btn.addEventListener("click", () => {
    fxObj.on = !fxObj.on;
    btn.textContent = fxObj.on ? "ON" : "OFF";
    btn.classList.toggle("fx-on", fxObj.on);
    refreshChainParams();
    autosave();
  });
  head.append(t, btn);
  const params = document.createElement("div");
  params.className = "fx-params";
  buildParams(params);
  unit.append(head, params);
  return unit;
}

function renderFxPanel() {
  const ch = song.channels[ui.fxChannel];
  $("#fx-title").textContent = "MIX \u2014 " + ch.name.toUpperCase();
  const body = $("#fx-body");
  body.innerHTML = "";
  const fx = ch.fx;

  // Ensure new properties exist for older saves
  if (fx.pan === undefined) fx.pan = 0;
  if (!fx.eq) fx.eq = { low: 0, mid: 0, high: 0 };
  if (!fx.crush) fx.crush = { on: false, bits: 8 };
  if (!fx.chorus) fx.chorus = { on: false, rate: 1.5, depth: 0.01, mix: 0.5 };

  // --- CELL INSPECTOR ---
  const cellTitle = document.createElement("div");
  cellTitle.className = "panel-section-title";
  cellTitle.textContent = "CELL";
  body.appendChild(cellTitle);
  const cellBox = document.createElement("div");
  cellBox.id = "cell-inspector";
  body.appendChild(cellBox);

  // --- CHANNEL STRIP ---
  const stripHeader = document.createElement("div");
  stripHeader.className = "panel-section-title";
  stripHeader.textContent = "CHANNEL STRIP";
  body.appendChild(stripHeader);

  const volUnit = document.createElement("div");
  volUnit.className = "fx-unit";
  const volParams = document.createElement("div");
  volParams.className = "fx-params";
  volParams.appendChild(fxParamRow("Volume", 0, 1.5, 0.01, fx.vol,
    (v) => Math.round(v * 100) + "%", (v) => { fx.vol = v; }));
  volParams.appendChild(fxParamRow("Pan", -1, 1, 0.01, fx.pan,
    (v) => v === 0 ? "C" : (v < 0 ? "L" + Math.round(-v*100) : "R" + Math.round(v*100)), 
    (v) => { fx.pan = v; }));
  volUnit.appendChild(volParams);
  body.appendChild(volUnit);

  const eqUnit = document.createElement("div");
  eqUnit.className = "fx-unit";
  const eqHead = document.createElement("div");
  eqHead.className = "fx-unit-head";
  const eqT = document.createElement("span"); eqT.textContent = "3-BAND EQ";
  eqHead.appendChild(eqT);
  const eqParams = document.createElement("div");
  eqParams.className = "fx-params";
  eqParams.appendChild(fxParamRow("High", -15, 15, 0.5, fx.eq.high, (v) => (v>0?"+":"") + v.toFixed(1) + "dB", (v) => { fx.eq.high = v; }));
  eqParams.appendChild(fxParamRow("Mid", -15, 15, 0.5, fx.eq.mid, (v) => (v>0?"+":"") + v.toFixed(1) + "dB", (v) => { fx.eq.mid = v; }));
  eqParams.appendChild(fxParamRow("Low", -15, 15, 0.5, fx.eq.low, (v) => (v>0?"+":"") + v.toFixed(1) + "dB", (v) => { fx.eq.low = v; }));
  eqUnit.append(eqHead, eqParams);
  body.appendChild(eqUnit);

  // --- INSERT EFFECTS ---
  const fxHeader = document.createElement("div");
  fxHeader.className = "panel-section-title";
  fxHeader.textContent = "INSERT EFFECTS";
  body.appendChild(fxHeader);

  body.appendChild(fxUnit("BITCRUSHER", fx.crush, (p) => {
    p.appendChild(fxParamRow("Resolution", 2, 16, 1, fx.crush.bits,
      (v) => v + " bit", (v) => { fx.crush.bits = v; }));
  }));

  body.appendChild(fxUnit("DISTORTION", fx.dist, (p) => {
    p.appendChild(fxParamRow("Drive", 0.02, 1, 0.01, fx.dist.drive,
      (v) => Math.round(v * 100) + "%", (v) => { fx.dist.drive = v; }));
  }));

  body.appendChild(fxUnit("CHORUS", fx.chorus, (p) => {
    p.appendChild(fxParamRow("Rate", 0.1, 5.0, 0.1, fx.chorus.rate,
      (v) => v.toFixed(1) + "Hz", (v) => { fx.chorus.rate = v; }));
    p.appendChild(fxParamRow("Depth", 0.001, 0.03, 0.001, fx.chorus.depth,
      (v) => (v * 1000).toFixed(1) + "ms", (v) => { fx.chorus.depth = v; }));
    p.appendChild(fxParamRow("Mix", 0, 1, 0.01, fx.chorus.mix,
      (v) => Math.round(v * 100) + "%", (v) => { fx.chorus.mix = v; }));
  }));

  body.appendChild(fxUnit("DELAY SEND", fx.delay, (p) => {
    p.appendChild(fxParamRow("Send", 0, 1, 0.01, fx.delay.send,
      (v) => Math.round(v * 100) + "%", (v) => { fx.delay.send = v; }));
    const hint = document.createElement("div");
    hint.className = "fx-hint";
    hint.textContent = "Time/feedback are shared \u2014 set once in SEND BUSES below.";
    p.appendChild(hint);
  }));

  body.appendChild(fxUnit("REVERB SEND", fx.reverb, (p) => {
    p.appendChild(fxParamRow("Send", 0, 1, 0.01, fx.reverb.send,
      (v) => Math.round(v * 100) + "%", (v) => { fx.reverb.send = v; }));
    const hint = document.createElement("div");
    hint.className = "fx-hint";
    hint.textContent = "Decay is shared \u2014 set once in SEND BUSES below.";
    p.appendChild(hint);
  }));

  // --- SEND BUSES (global - one reverb, one delay, shared by every channel;
  //     this is standard console behavior and the reason it's cheap on CPU) ---
  const busHeader = document.createElement("div");
  busHeader.className = "panel-section-title";
  busHeader.textContent = "SEND BUSES (GLOBAL)";
  body.appendChild(busHeader);

  const busUnit = document.createElement("div");
  busUnit.className = "fx-unit";
  const busParams = document.createElement("div");
  busParams.className = "fx-params";
  busParams.appendChild(fxParamRow("Rev Decay", 0.2, 6, 0.05, song.fxBus.reverbDecay,
    (v) => v.toFixed(1) + "s", (v) => {
      song.fxBus.reverbDecay = v;
      sendBuses.setReverb(v);
    }));
  busParams.appendChild(fxParamRow("Dly Time", 0.02, 1.5, 0.01, song.fxBus.delayTime,
    (v) => Math.round(v * 1000) + "ms", (v) => {
      song.fxBus.delayTime = v;
      sendBuses.setDelay(v, song.fxBus.delayFb);
    }));
  busParams.appendChild(fxParamRow("Dly Feedback", 0, 0.9, 0.01, song.fxBus.delayFb,
    (v) => Math.round(v * 100) + "%", (v) => {
      song.fxBus.delayFb = v;
      sendBuses.setDelay(song.fxBus.delayTime, v);
    }));
  busUnit.appendChild(busParams);
  body.appendChild(busUnit);

  renderCellInspector();
}

/* ================= cell inspector ================= */
function afterCellEdit(row, ch) {
  repaintCell(row, ch);
  scheduleWaveDraw();
  autosave();
  renderCellInspector();
}

function previewCell(cell, ch) {
  const instNum = cell.inst != null ? cell.inst : ui.curInstrument + 1;
  const inst = song.instruments[instNum - 1];
  if (!inst || cell.note == null || cell.note === NOTE_OFF) return;
  const buf = buffers.get(inst.path);
  if (!buf) return;
  AC.resume();
  ensureChains();
  const src = AC.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.pow(2, (cell.note - BASE_NOTE) / 12);
  const vg = AC.createGain();
  vg.gain.value = (cell.vol == null ? 64 : cell.vol) / 64;
  src.connect(vg);
  vg.connect(chains[ch].input);
  src.start();
}

function renderCellInspector() {
  const box = $("#cell-inspector");
  if (!box) return;
  box.innerHTML = "";
  const row = ui.cursor.row, ch = ui.cursor.ch;
  const pat = curPat();
  const cell = pat.data[row] && pat.data[row][ch];
  const split = cell && cell.split ? cell.split : 1;

  const pos = document.createElement("div");
  pos.className = "ci-pos";
  pos.textContent = "Row " + String(row).padStart(2, "0") + " \u00b7 "
    + (song.channels[ch] ? song.channels[ch].name : "")
    + (split > 1 ? " \u00b7 hit " + (ui.cursor.slot + 1) + "/" + split : "");
  box.appendChild(pos);

  /* split control - double-clicking the cell cycles this too */
  const spRow = document.createElement("div");
  spRow.className = "ci-row";
  const spLab = document.createElement("label");
  spLab.textContent = "Split";
  spRow.appendChild(spLab);
  [1, 2, 3, 4].forEach((n) => {
    const b = document.createElement("button");
    b.className = "ci-btn" + (n === split ? " ci-on" : "");
    b.textContent = String(n);
    b.title = n === 1 ? "Single hit" : n + " evenly-timed hits in this cell";
    b.addEventListener("click", () => setSplit(row, ch, n));
    spRow.appendChild(b);
  });
  box.appendChild(spRow);

  const target = cell ? (split > 1 ? cell.subs[ui.cursor.slot] : cell) : null;

  if (!target || (target.note == null && target.inst == null && target.vol == null)) {
    const hint = document.createElement("div");
    hint.className = "fx-hint";
    hint.textContent = split > 1 ? "Empty hit." : "Empty cell.";
    const add = document.createElement("button");
    add.textContent = "+ Add note";
    add.addEventListener("click", () => {
      const c2 = getOrMakeCell(row, ch);
      const t2 = c2.split ? ensureSlot(c2, ui.cursor.slot) : c2;
      t2.note = ui.octave * 12;
      t2.inst = song.instruments.length ? ui.curInstrument + 1 : null;
      afterCellEdit(row, ch);
      previewCell(t2, ch);
    });
    box.append(hint, add);
    return;
  }

  const clearTarget = () => {
    if (split > 1) {
      cell.subs[ui.cursor.slot] = null;
      if (cell.subs.every((sub) => !sub)) pat.data[row][ch] = null;
    } else {
      pat.data[row][ch] = null;
    }
    afterCellEdit(row, ch);
  };

  if (target.note === NOTE_OFF) {
    const hint = document.createElement("div");
    hint.className = "fx-hint";
    hint.textContent = "Note off (===) \u2014 cuts the channel here.";
    const clr = document.createElement("button");
    clr.textContent = "\u00d7 Clear";
    clr.addEventListener("click", clearTarget);
    box.append(hint, clr);
    return;
  }

  /* note */
  const noteRow = document.createElement("div");
  noteRow.className = "ci-row";
  const nl = document.createElement("label");
  nl.textContent = "Note";
  const noteVal = document.createElement("span");
  noteVal.className = "ci-note";
  noteVal.textContent = noteName(target.note);
  const bump = (d) => {
    const base = target.note == null ? ui.octave * 12 : target.note;
    target.note = Math.max(0, Math.min(119, base + d));
    afterCellEdit(row, ch);
    previewCell(target, ch);
  };
  const mkB = (txt, d, title) => {
    const b = document.createElement("button");
    b.className = "ci-btn";
    b.textContent = txt;
    b.title = title;
    b.addEventListener("click", () => bump(d));
    return b;
  };
  noteRow.append(nl,
    mkB("\u00ab", -12, "Octave down"), mkB("\u2212", -1, "Semitone down"),
    noteVal,
    mkB("+", 1, "Semitone up"), mkB("\u00bb", 12, "Octave up"));
  box.appendChild(noteRow);

  /* instrument */
  const instRow = document.createElement("div");
  instRow.className = "ci-row";
  const il = document.createElement("label");
  il.textContent = "Inst";
  const sel = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "(default " + fmt2(ui.curInstrument + 1) + ")";
  sel.appendChild(noneOpt);
  song.instruments.forEach((inst, i) => {
    const o = document.createElement("option");
    o.value = String(i + 1);
    o.textContent = fmt2(i + 1) + " " + inst.name;
    sel.appendChild(o);
  });
  if (target.inst != null && target.inst > song.instruments.length) {
    const o = document.createElement("option");
    o.value = String(target.inst);
    o.textContent = fmt2(target.inst) + " (missing)";
    sel.appendChild(o);
  }
  sel.value = target.inst != null ? String(target.inst) : "";
  sel.addEventListener("change", () => {
    target.inst = sel.value === "" ? null : Number(sel.value);
    afterCellEdit(row, ch);
    previewCell(target, ch);
  });
  instRow.append(il, sel);
  box.appendChild(instRow);

  /* volume - no inspector rebuild on input so the drag isn't interrupted */
  const volRow = document.createElement("div");
  volRow.className = "ci-row";
  const vl = document.createElement("label");
  vl.textContent = "Vol";
  const vr = document.createElement("input");
  vr.type = "range"; vr.min = 0; vr.max = 64; vr.step = 1;
  vr.value = target.vol == null ? 64 : target.vol;
  const vv = document.createElement("span");
  vv.className = "pv";
  vv.textContent = target.vol == null ? "df" : String(target.vol);
  vr.addEventListener("input", () => {
    target.vol = Number(vr.value);
    vv.textContent = String(target.vol);
    repaintCell(row, ch);
    scheduleWaveDraw();
  });
  vr.addEventListener("change", () => autosave());
  volRow.append(vl, vr, vv);
  box.appendChild(volRow);

  /* actions */
  const act = document.createElement("div");
  act.className = "ci-row";
  const play = document.createElement("button");
  play.textContent = "\u25b6 Play";
  play.addEventListener("click", () => previewCell(target, ch));
  const edit = document.createElement("button");
  edit.textContent = "\u270e Edit sample";
  edit.title = "Open this cell's sample in the editor (same as right-clicking the cell)";
  edit.addEventListener("click", () => openCellSampleEditor(row, ch, ui.cursor.slot));
  const clr = document.createElement("button");
  clr.textContent = "\u00d7 Clear";
  clr.addEventListener("click", clearTarget);
  act.append(play, edit, clr);
  box.appendChild(act);
}

/* ================= palette / instruments ================= */
let knownSamplePaths = new Set();

async function refreshPalette() {
  const res = await fetch("/api/samples");
  const data = await res.json();
  knownSamplePaths = new Set(data.samples.map((s) => s.path));
  const list = $("#palette-list");
  list.innerHTML = "";
  const groups = {};
  for (const s of data.samples) {
    (groups[s.folder || "samples"] ||= []).push(s);
  }
  const folders = Object.keys(groups).sort();
  if (!folders.length) {
    const empty = document.createElement("div");
    empty.className = "palette-folder";
    empty.textContent = "No samples yet — click + Import to add audio files.";
    list.appendChild(empty);
    return;
  }
  for (const f of folders) {
    const head = document.createElement("div");
    head.className = "palette-folder";
    head.textContent = f;
    list.appendChild(head);
    for (const s of groups[f]) {
      const item = document.createElement("div");
      item.className = "sample-item";
      item.title = s.path;

      const label = document.createElement("span");
      label.textContent = s.name;
      const prev = document.createElement("button");
      prev.className = "mini-btn";
      prev.textContent = "\u25b6";
      prev.title = "Preview";
      prev.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await AC.resume();
          const buf = await getBuffer(s.path);
          const src = AC.createBufferSource();
          src.buffer = buf;
          src.connect(master);
          src.start();
        } catch (err) { toast(err.message); }
      });
      const editB = document.createElement("button");
      editB.className = "mini-btn";
      editB.textContent = "\u270e";
      editB.title = "Edit sample";
      editB.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditor(s.path, s.name);
      });
      const delB = document.createElement("button");
      delB.className = "mini-btn";
      delB.textContent = "\u2715";
      delB.title = "Remove from library";
      delB.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSample(s.path, s.name);
      });
      item.append(label, editB, prev, delB);
      item.addEventListener("dblclick", () => openEditor(s.path, s.name));
      item.addEventListener("click", () => addInstrument(s.path, s.name));
      list.appendChild(item);
    }
  }
  renderInstruments(); // library changed -> re-check which instruments are missing
}

async function addInstrument(path, name) {
  const existing = song.instruments.findIndex((i) => i.path === path);
  if (existing >= 0) {
    ui.curInstrument = existing;
    renderInstruments();
    return;
  }
  if (song.instruments.length >= 99) { toast("Instrument slots are full (99)"); return; }
  song.instruments.push({ path, name });
  ui.curInstrument = song.instruments.length - 1;
  try { await getBuffer(path); } catch (err) { toast(err.message); }
  scheduleWaveDraw();
  renderInstruments();
  autosave();
  toast("Instrument " + fmt2(ui.curInstrument + 1) + ": " + name);
}

function renderInstruments() {
  const list = $("#instrument-list");
  list.innerHTML = "";
  if (!song.instruments.length) {
    const hint = document.createElement("div");
    hint.className = "palette-folder";
    hint.textContent = "Click a library sample to fill slot 01.";
    list.appendChild(hint);
    return;
  }
  song.instruments.forEach((inst, i) => {
    // only trust "missing" once we've actually fetched the library at least
    // once; before that, knownSamplePaths is empty and everything looks
    // missing, which would be a false alarm.
    const missing = knownSamplePaths.size > 0 && !knownSamplePaths.has(inst.path);

    const item = document.createElement("div");
    item.className = "inst-item" + (i === ui.curInstrument ? " current" : "")
      + (missing ? " missing" : "");
    item.title = missing
      ? inst.path + " \u2014 file no longer in the library"
      : inst.path;

    const num = document.createElement("span");
    num.className = "inst-num";
    num.textContent = fmt2(i + 1);
    const label = document.createElement("span");
    label.textContent = inst.name + (missing ? " (missing)" : "");

    const prev = document.createElement("button");
    prev.className = "mini-btn";
    prev.textContent = "\u25b6";
    prev.title = missing ? "File missing \u2014 cannot preview" : "Preview";
    prev.disabled = missing;
    prev.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await AC.resume();
        const buf = await getBuffer(inst.path);
        const src = AC.createBufferSource();
        src.buffer = buf;
        src.connect(master);
        src.start();
      } catch (err) { toast(err.message); }
    });

    const editB = document.createElement("button");
    editB.className = "mini-btn";
    editB.textContent = "\u270e";
    editB.title = missing ? "File missing \u2014 cannot edit" : "Edit sample";
    editB.disabled = missing;
    editB.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!missing) openEditor(inst.path, inst.name);
    });

    const x = document.createElement("button");
    x.className = "mini-btn";
    x.textContent = "\u00d7";
    x.title = "Remove instrument slot";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      song.instruments.splice(i, 1);
      ui.curInstrument = Math.max(0, Math.min(ui.curInstrument, song.instruments.length - 1));
      renderInstruments();
      autosave();
    });

    item.append(num, label, editB, prev, x);
    item.addEventListener("click", () => {
      ui.curInstrument = i;
      renderInstruments();
    });
    if (!missing) item.addEventListener("dblclick", () => openEditor(inst.path, inst.name));
    list.appendChild(item);
  });
}

/* melody conditioning: hum/whistle -> instrument */
let genMelody = null;
let humRec = null;

async function setGenMelody(buf) {
  const blob = encodeWav(buf);
  const b64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("Could not encode melody"));
    r.readAsDataURL(blob);
  });
  genMelody = { b64, dur: buf.length / buf.sampleRate };
  $("#gen-melody-status").textContent =
    "melody " + genMelody.dur.toFixed(1) + "s \u00b7 will use musicgen-melody";
  $("#gen-melody-clear").hidden = false;
}

$("#gen-melody-clear").addEventListener("click", () => {
  genMelody = null;
  $("#gen-melody-status").textContent = "no melody";
  $("#gen-melody-clear").hidden = true;
});

$("#gen-hum").addEventListener("click", async () => {
  const btn = $("#gen-hum");
  if (humRec) { humRec.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Recording needs mic access \u2014 open via http://localhost:8200");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove("recording");
      btn.innerHTML = "&#9679; Hum";
      humRec = null;
      try {
        const ab = await new Blob(chunks).arrayBuffer();
        const buf = await AC.decodeAudioData(ab);
        await setGenMelody(buf);
        toast("Melody captured \u2014 type a style prompt and hit Generate");
      } catch (err) {
        $("#gen-melody-status").textContent = "no melody";
        toast("Could not decode hum: " + err.message);
      }
    };
    rec.start();
    humRec = rec;
    btn.classList.add("recording");
    btn.innerHTML = "&#9632; Stop";
    $("#gen-melody-status").textContent = "listening\u2026 hum or whistle, then Stop";
  } catch (err) {
    toast("Mic access denied: " + err.message);
  }
});

/* ai generation */
const STYLE_ADDONS = {
  single: ", played by one solo instrument completely alone, unaccompanied, no other instruments, no backing",
  ensemble: ", performed by a full ensemble, multiple instruments playing together, rich layered arrangement",
  onenote: ", one single sustained note held steady, a single pitch only, no melody, no rhythm, no accompaniment",
};

function wireStyleButtons(scopeSel) {
  const btns = document.querySelectorAll(scopeSel + " .gen-style-btn");
  let current = null;
  btns.forEach((b) => b.addEventListener("click", () => {
    current = current === b.dataset.style ? null : b.dataset.style;
    btns.forEach((x) => x.classList.toggle("toggled", x.dataset.style === current));
  }));
  return () => current;
}
const getGenStyle = wireStyleButtons("#gen-panel");
const getEmGenStyle = wireStyleButtons("#em-box");

/* shared generation call - used by both the palette GENERATE panel and
   the sample editor's GENERATE panel, so they can never drift apart */
async function runGenerate({ prompt, duration, model, melody, style, statusEl }) {
  if (!prompt) { toast("Type a prompt first"); return null; }
  if (style && STYLE_ADDONS[style]) prompt += STYLE_ADDONS[style];
  if (statusEl) {
    statusEl.textContent = melody
      ? "Generating from your melody\u2026 first run downloads musicgen-melody (~6GB)."
      : "Generating\u2026 first run downloads the model.";
  }
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        duration: duration || 4,
        model,
        melody_b64: melody ? melody.b64 : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Generation failed");
    return data;
  } catch (err) {
    toast(err.message);
    return null;
  } finally {
    if (statusEl) statusEl.textContent = "";
  }
}

$("#btn-generate").addEventListener("click", async () => {
  const btn = $("#btn-generate");
  btn.disabled = true;
  const data = await runGenerate({
    prompt: $("#gen-prompt").value.trim(),
    duration: parseFloat($("#gen-dur").value),
    model: $("#gen-model").value,
    melody: genMelody,
    style: getGenStyle(),
    statusEl: $("#gen-status"),
  });
  if (data) {
    await refreshPalette();
    await addInstrument(data.path, data.name);
    toast("Generated: " + data.name);
  }
  btn.disabled = false;
});

/* editor-side generation: result loads straight into the waveform */
let emGenMelody = null;
$("#em-gen-tomelody").addEventListener("click", async () => {
  if (!em.buf) { toast("No audio loaded in the editor"); return; }
  const blob = encodeWav(em.buf);
  const b64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("Could not encode melody"));
    r.readAsDataURL(blob);
  });
  emGenMelody = { b64 };
  $("#em-gen-melody-status").textContent =
    "using current audio as melody (" + (em.buf.length / em.buf.sampleRate).toFixed(1) + "s)";
});

$("#em-generate").addEventListener("click", async () => {
  const btn = $("#em-generate");
  btn.disabled = true;
  const data = await runGenerate({
    prompt: $("#em-gen-prompt").value.trim(),
    duration: parseFloat($("#em-gen-dur").value),
    model: $("#em-gen-model").value,
    melody: emGenMelody,
    style: getEmGenStyle(),
    statusEl: $("#em-gen-status"),
  });
  if (data) {
    try {
      const buf = await getBuffer(data.path);
      em.buf = copyBuffer(buf);
      em.path = data.path;
      em.name = data.name;
      em.folder = data.path.includes("/") ? data.path.slice(0, data.path.lastIndexOf("/")) : "";
      em.sel = null;
      em.undo = [];
      $("#em-title").textContent = "SAMPLE EDITOR \u2014 " + em.name.toUpperCase();
      $("#em-name").value = em.name + "-edit";
      $("#em-replace").disabled = false;
      emDraw();
      await refreshPalette();
      toast("Generated into editor: " + data.name);
    } catch (err) {
      toast(err.message);
    }
  }
  btn.disabled = false;
});

/* count where a sample is actually used, so deletion warns honestly */
function sampleUsage(path) {
  const instSlots = [];
  song.instruments.forEach((inst, i) => {
    if (inst.path === path) instSlots.push(i + 1);
  });
  let cellCount = 0;
  for (const pat of song.patterns) {
    for (const row of pat.data) {
      for (const cell of row) {
        for (const ev of cellEvents(cell)) {
          if (ev.note === NOTE_OFF) continue;
          if (ev.inst != null && instSlots.includes(ev.inst)) cellCount++;
        }
      }
    }
  }
  return { instSlots, cellCount };
}

async function deleteSample(path, name) {
  const usage = sampleUsage(path);
  let msg = 'Remove "' + name + '" from the library? This deletes the file on disk.';
  if (usage.instSlots.length) {
    msg += "\n\nIn use: instrument slot " + usage.instSlots.map(fmt2).join(", ")
      + (usage.cellCount ? " (" + usage.cellCount + " pattern cell"
         + (usage.cellCount === 1 ? "" : "s") + ")" : "")
      + ".\nThose cells will play silently until you assign a different instrument.";
  }
  if (!confirm(msg)) return;
  try {
    const res = await fetch("/api/samples/" + encodeURI(path), { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Delete failed");
    buffers.delete(path);
    await refreshPalette();
    scheduleWaveDraw();
    toast("Removed: " + name);
  } catch (err) {
    toast(err.message);
  }
}

/* upload */
$("#btn-upload").addEventListener("click", () => $("#file-input").click());
$("#btn-refresh").addEventListener("click", refreshPalette);
$("#file-input").addEventListener("change", async (e) => {
  for (const file of e.target.files) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/upload?folder=imported", { method: "POST", body: fd });
    if (!res.ok) toast("Import failed: " + file.name);
  }
  e.target.value = "";
  await refreshPalette();
  toast("Samples imported");
});

/* ================= save / load ================= */
function serialize() {
  return {
    version: 2,
    kind: "tracker",
    bpm: song.bpm,
    rowsPerBeat: song.rowsPerBeat,
    instruments: song.instruments,
    channels: song.channels,
    patterns: song.patterns,
    order: song.order,
    fxBus: song.fxBus,
    ui: {
      curPattern: ui.curPattern,
      curInstrument: ui.curInstrument,
      cursor: ui.cursor,
      octave: ui.octave,
      masterVol: master.gain.value,
      showWave: ui.showWave,
      showVU: ui.showVU,
      zoom: ui.zoom
    }
  };
}

/** Base64-encodes one sample's audio, re-rendering it as WAV through the
 * same encodeWav() used everywhere else in the editor -- consistent
 * output regardless of the sample's original file format. */
async function sampleToBase64(path) {
  const buf = await getBuffer(path);
  const blob = encodeWav(buf);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("Could not encode " + path));
    r.readAsDataURL(blob);
  });
}

/** serialize() alone only stores sample *paths* -- if the shared library
 * changes later (a sample gets deleted, overwritten, or this project is
 * moved elsewhere), a project saved that way can silently break. Only
 * used by an explicit named Save, NOT by autosave: autosave fires on
 * nearly every keystroke, and re-encoding every referenced sample to
 * base64 that often would be slow and would blow past localStorage's
 * size limit fast. A deliberate Save is rare enough to afford it. */
async function serializeWithSamples() {
  const base = serialize();
  const paths = [...new Set(song.instruments.map((i) => i.path))];
  const sampleData = {};
  for (const path of paths) {
    try {
      sampleData[path] = await sampleToBase64(path);
    } catch (err) {
      toast("Could not include sample in save: " + path);
    }
  }
  return { ...base, sampleData };
}

/** Writes back any samples embedded in a loaded project that aren't
 * already in the library -- restores them as real files, not just an
 * in-memory patch, so they show up in the Library panel and are usable
 * like any other sample from here on. Skips anything already present,
 * so reloading the same project repeatedly doesn't keep re-writing
 * identical files. */
async function restoreSamplesFromProject(data) {
  if (!data.sampleData) return;
  for (const [path, b64] of Object.entries(data.sampleData)) {
    if (knownSamplePaths.has(path)) continue;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await fetch("/api/sample/save?path=" + encodeURIComponent(path) + "&overwrite=0", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: bytes,
      });
    } catch (err) {
      toast("Could not restore sample: " + path);
    }
  }
  await refreshPalette();
}

async function saveProject() {
  const name = $("#project-name").value.trim() || "untitled";
  const btn = $("#btn-save");
  btn.disabled = true;
  toast("Saving…");
  try {
    const payload = await serializeWithSamples();
    const res = await fetch("/api/projects/" + encodeURIComponent(name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      toast("Saved: " + name);
      refreshProjectList();
      autosave();
      dirty = false;
    } else {
      toast("Save failed");
    }
  } finally {
    btn.disabled = false;
  }
}

function applyProjectData(data, name) {
  song.bpm = data.bpm || 125;
  song.rowsPerBeat = data.rowsPerBeat || 4;
  song.instruments = data.instruments || [];
  song.channels = (data.channels || []).map((c) => {
    const fx = { ...defaultFx(), ...(c.fx || {}) };
    // pre-0.0.8 saves stored a full reverb/delay unit per channel;
    // migrate its mix level into the new send amount.
    if (c.fx && c.fx.reverb && c.fx.reverb.mix != null && c.fx.reverb.send == null) {
      fx.reverb = { on: c.fx.reverb.on, send: c.fx.reverb.mix };
    }
    if (c.fx && c.fx.delay && c.fx.delay.mix != null && c.fx.delay.send == null) {
      fx.delay = { on: c.fx.delay.on, send: c.fx.delay.mix };
    }
    return { ...makeChannel(1), ...c, fx };
  });
  song.fxBus = { reverbDecay: 2.0, delayTime: 0.3, delayFb: 0.35, ...(data.fxBus || {}) };
  if (!song.channels.length) song.channels = [makeChannel(1)];
  song.patterns = data.patterns && data.patterns.length ? data.patterns : [makePattern(64, song.channels.length)];
  song.order = data.order || [0];
  
  if (data.ui) {
    ui.curPattern = Math.min(data.ui.curPattern || 0, song.patterns.length - 1);
    ui.curInstrument = data.ui.curInstrument || 0;
    ui.cursor = data.ui.cursor || { row: 0, ch: 0, sub: 0 };
    ui.octave = data.ui.octave || 5;
    if (data.ui.masterVol != null) {
      master.gain.value = data.ui.masterVol;
      $("#master-vol").value = data.ui.masterVol;
    }
    ui.showWave = data.ui.showWave !== false;
    ui.showVU = data.ui.showVU !== false;
    ui.zoom = data.ui.zoom || 112;
  } else {
    ui.curPattern = 0;
    ui.curInstrument = 0;
    ui.cursor = { row: 0, ch: 0, sub: 0, slot: 0 };
  }
  
  ui.selection = null;
  ui.fxChannel = 0;
  
  $("#bpm").value = song.bpm;
  $("#rpb").value = song.rowsPerBeat;
  $("#octave").value = ui.octave;
  syncViewToggles();
  applyZoom();
  $("#project-name").value = name;
  
  chains = [];
  ensureChains();
  for (const inst of song.instruments) {
    getBuffer(inst.path).then(scheduleWaveDraw).catch(() => toast("Missing sample: " + inst.path));
  }
  
  refreshPatternSelect();
  renderOrderChips(null);
  renderInstruments();
  renderFxPanel();
  renderGrid();
  
  setTimeout(() => {
    setCursor(ui.cursor.row, ui.cursor.ch, ui.cursor.sub);
  }, 50);
}

async function loadProject(name) {
  const res = await fetch("/api/projects/" + encodeURIComponent(name));
  if (!res.ok) { toast("Load failed"); return; }
  const data = await res.json();
  if (data.kind !== "tracker") { toast("Not a tracker project: " + name); return; }
  stopPlayback();
  // Restore any embedded samples BEFORE applying the project data --
  // applyProjectData preloads each instrument's buffer immediately and
  // reports "Missing sample" if that fails, so the files need to exist
  // on disk first.
  await restoreSamplesFromProject(data);
  applyProjectData(data, name);
  autosave();
  dirty = false;
  toast("Loaded: " + name);
}

/** Shared by New and Load: asks to save only if there's something
 * unsaved to lose, and only proceeds with the actual save if the user
 * says yes -- a plain confirm() to match every other "are you sure"
 * in this app (delete pattern, delete instrument, remove sample). */
async function offerSaveIfDirty(actionLabel) {
  if (!dirty) return;
  if (confirm("Save changes before " + actionLabel + "?")) {
    await saveProject();
  }
}

async function refreshProjectList() {
  const res = await fetch("/api/projects");
  const data = await res.json();
  const sel = $("#project-list");
  sel.innerHTML = '<option value="">Load...</option>';
  for (const p of data.projects) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    sel.appendChild(opt);
  }
}

$("#btn-save").addEventListener("click", saveProject);
$("#btn-new").addEventListener("click", async () => {
  await offerSaveIfDirty("starting a new project");
  stopPlayback();
  applyProjectData(newSongData(), "untitled");
  autosave();
  dirty = false;
  toast("New project");
});
$("#project-list").addEventListener("change", async (e) => {
  const name = e.target.value;
  e.target.value = "";
  if (!name) return;
  await offerSaveIfDirty('loading "' + name + '"');
  loadProject(name);
});
$("#project-name").addEventListener("change", autosave);

/* ================= export WAV ================= */
function encodeWav(rendered) {
  const numCh = rendered.numberOfChannels;
  const len = rendered.length;
  const rate = rendered.sampleRate;
  const blockAlign = numCh * 2;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); ws(8, "WAVE");
  ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * blockAlign, true); v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, dataSize, true);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(rendered.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function exportWav() {
  const sequence = song.order.length
    ? song.order
    : song.patterns.map((_, i) => i); // no order set: export the whole song
  const spr = secPerRow();
  let totalRows = 0;
  for (const p of sequence) totalRows += song.patterns[p].rows;
  if (totalRows === 0) { toast("Nothing to export"); return; }
  toast("Rendering...");

  // Hardcode offline export to pristine 48000 Hz target format
  const rate = 48000;
  const tail = 3; 
  const oc = new OfflineAudioContext(2, Math.ceil((totalRows * spr + tail) * rate), rate);
  const om = oc.createGain();
  om.gain.value = master.gain.value; 
  
  const olim = oc.createDynamicsCompressor();
  olim.threshold.value = -3.0; 
  olim.knee.value = 12.0;
  olim.ratio.value = 4.0;
  olim.attack.value = 0.01;
  olim.release.value = 0.1;
  
  om.connect(olim);
  olim.connect(oc.destination);

  const offSendBuses = buildSendBuses(oc, om);
  offSendBuses.setReverb(song.fxBus.reverbDecay);
  offSendBuses.setDelay(song.fxBus.delayTime, song.fxBus.delayFb);
  const offChains = song.channels.map((ch, i) => {
    const chain = buildChain(oc, om, offSendBuses);
    chain.update(ch.fx, channelAudible(i));
    return chain;
  });
  const offActive = {};

  let t = 0.02;
  for (const p of sequence) {
    const pat = song.patterns[p];
    for (let r = 0; r < pat.rows; r++) {
      scheduleRow(p, r, t, oc, offChains, offActive);
      t += spr;
    }
  }

  const rendered = await oc.startRendering();
  const blob = encodeWav(rendered);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = ($("#project-name").value.trim() || "hackbeat") + ".wav";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Exported WAV (" + Math.round(totalRows * spr) + "s + tail)");
}
$("#btn-export").addEventListener("click", () => exportWav().catch((e) => toast(e.message)));

/* ================= sample editor ================= */
const em = {
  buf: null, path: null, name: "", folder: "",
  sel: null,        // {a, b} in samples
  undo: [],
  playSrc: null,
  rec: null,
};
let emCellTarget = null; // {row, ch, slot, instNum} when opened via right-click

const FX_DEFS = {
  dist:     { p1: "Drive",  p2: "\u2014" },
  crush:    { p1: "Depth",  p2: "\u2014" },
  lowpass:  { p1: "Cutoff", p2: "Res" },
  highpass: { p1: "Cutoff", p2: "Res" },
  delay:    { p1: "Time",   p2: "Mix" },
  reverb:   { p1: "Decay",  p2: "Mix" },
};

function copyBuffer(src) {
  const b = AC.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) {
    b.copyToChannel(src.getChannelData(c).slice(0), c);
  }
  return b;
}

async function openEditor(path, name) {
  em.path = path || null;
  em.name = name || "recording";
  em.folder = path
    ? (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
    : "recorded";
  em.sel = null;
  em.undo = [];
  em.buf = null;
  em.playSrc = null;
  emCellTarget = null;
  $("#em-applycell").hidden = true;
  $("#em-cellhint").hidden = true;
  if (path) {
    try { em.buf = copyBuffer(await getBuffer(path)); }
    catch (err) { toast(err.message); return; }
  }
  $("#em-title").textContent = "SAMPLE EDITOR \u2014 " + em.name.toUpperCase();
  $("#em-name").value = em.name + (em.path ? "-edit" : "");
  $("#em-replace").disabled = !em.path;
  $("#em-recstatus").textContent = "";
  $("#em-overlay").hidden = false;
  emUpdateFxLabels();
  emDraw();
}

function closeEditor() {
  emStop();
  if (em.rec) { try { em.rec.stop(); } catch (_) {} }
  $("#em-overlay").hidden = true;
}

function emDraw() {
  const cv = $("#em-wave");
  const g = cv.getContext("2d");
  g.fillStyle = "#0b0d10";
  g.fillRect(0, 0, cv.width, cv.height);
  if (!em.buf) {
    g.fillStyle = "#8b92a0";
    g.font = "13px system-ui";
    g.fillText("No audio \u2014 hit \u25cf Record below, or double-click a sample to open it here.",
               20, cv.height / 2);
    $("#em-info").textContent = "empty";
    return;
  }
  const data = em.buf.getChannelData(0);
  const w = cv.width, h = cv.height, mid = h / 2;
  if (em.sel) {
    g.fillStyle = "rgba(242,163,60,0.18)";
    const x0 = em.sel.a / em.buf.length * w;
    const x1 = em.sel.b / em.buf.length * w;
    g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }
  g.fillStyle = "#9fd0ff";
  const step = Math.max(1, Math.floor(data.length / w));
  for (let x = 0; x < w; x++) {
    let mn = 1, mx = -1;
    const base = Math.floor(x / w * data.length);
    for (let i = 0; i < step; i += Math.max(1, Math.floor(step / 32))) {
      const v = data[base + i] || 0;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    g.fillRect(x, mid + mn * mid, 1, Math.max(1, (mx - mn) * mid));
  }
  g.strokeStyle = "#2c313a";
  g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
  const selTxt = em.sel
    ? " \u00b7 sel " + ((em.sel.b - em.sel.a) / em.buf.sampleRate).toFixed(2) + "s"
    : " \u00b7 drag to select";
  $("#em-info").textContent =
    (em.buf.length / em.buf.sampleRate).toFixed(2) + "s \u00b7 " +
    em.buf.sampleRate + "Hz \u00b7 " + em.buf.numberOfChannels + "ch" + selTxt;
}

/* drag to select */
(function () {
  const cv = $("#em-wave");
  let dragA = null;
  const toSample = (e) => {
    const r = cv.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return Math.round(frac * (em.buf ? em.buf.length : 0));
  };
  cv.addEventListener("pointerdown", (e) => {
    if (!em.buf) return;
    cv.setPointerCapture(e.pointerId);
    dragA = toSample(e);
    em.sel = null;
    emDraw();
  });
  cv.addEventListener("pointermove", (e) => {
    if (dragA == null || !em.buf) return;
    const b = toSample(e);
    if (Math.abs(b - dragA) > 32) {
      em.sel = { a: Math.min(dragA, b), b: Math.max(dragA, b) };
      emDraw();
    }
  });
  cv.addEventListener("pointerup", () => { dragA = null; emDraw(); });
})();

function emRegion() { return em.sel ? [em.sel.a, em.sel.b] : [0, em.buf.length]; }

function emPushUndo() {
  em.undo.push(copyBuffer(em.buf));
  if (em.undo.length > 8) em.undo.shift();
}
function emUndo() {
  if (!em.undo.length) { toast("Nothing to undo"); return; }
  em.buf = em.undo.pop();
  em.sel = null;
  emDraw();
}

function emEdit(fn) {
  if (!em.buf) { toast("No audio loaded"); return; }
  emPushUndo();
  fn();
  emDraw();
}

function emFade(inward) {
  emEdit(() => {
    const [a, b] = emRegion();
    const n = Math.max(1, b - a);
    for (let c = 0; c < em.buf.numberOfChannels; c++) {
      const d = em.buf.getChannelData(c);
      for (let i = a; i < b; i++) {
        const t = (i - a) / n;
        d[i] *= inward ? t : 1 - t;
      }
    }
  });
}

function emNormalize() {
  emEdit(() => {
    const [a, b] = emRegion();
    let peak = 0;
    for (let c = 0; c < em.buf.numberOfChannels; c++) {
      const d = em.buf.getChannelData(c);
      for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    if (peak < 1e-6) return;
    const k = 0.98 / peak;
    for (let c = 0; c < em.buf.numberOfChannels; c++) {
      const d = em.buf.getChannelData(c);
      for (let i = a; i < b; i++) d[i] *= k;
    }
  });
}

function emGain(db) {
  emEdit(() => {
    const k = Math.pow(10, db / 20);
    const [a, b] = emRegion();
    for (let c = 0; c < em.buf.numberOfChannels; c++) {
      const d = em.buf.getChannelData(c);
      for (let i = a; i < b; i++) d[i] = Math.max(-1, Math.min(1, d[i] * k));
    }
  });
}

function emReverse() {
  emEdit(() => {
    const [a, b] = emRegion();
    for (let c = 0; c < em.buf.numberOfChannels; c++) {
      const d = em.buf.getChannelData(c);
      const seg = d.slice(a, b);
      seg.reverse();
      d.set(seg, a);
    }
  });
}

function emSilence() {
  emEdit(() => {
    const [a, b] = emRegion();
    for (let c = 0; c < em.buf.numberOfChannels; c++) {
      em.buf.getChannelData(c).fill(0, a, b);
    }
  });
}

function emKeep(trim) {
  if (!em.buf) { toast("No audio loaded"); return; }
  if (!em.sel) { toast("Select a region first (drag on the waveform)"); return; }
  const { a, b } = em.sel;
  const newLen = trim ? (b - a) : (em.buf.length - (b - a));
  if (newLen < 8) { toast("Result would be too short"); return; }
  emPushUndo();
  const nb = AC.createBuffer(em.buf.numberOfChannels, newLen, em.buf.sampleRate);
  for (let c = 0; c < em.buf.numberOfChannels; c++) {
    const src = em.buf.getChannelData(c);
    const dst = nb.getChannelData(c);
    if (trim) {
      dst.set(src.subarray(a, b));
    } else {
      dst.set(src.subarray(0, a));
      dst.set(src.subarray(b), a);
    }
  }
  em.buf = nb;
  em.sel = null;
  emDraw();
}

/* destructive fx via offline render (reuses the engine's curves/impulses) */
async function emApplyFx() {
  if (!em.buf) { toast("No audio loaded"); return; }
  const kind = $("#em-fx").value;
  const p1 = parseFloat($("#em-p1").value);
  const p2 = parseFloat($("#em-p2").value);
  const tail = (kind === "delay" || kind === "reverb") ? 2.0 : 0;
  const oc = new OfflineAudioContext(
    em.buf.numberOfChannels,
    em.buf.length + Math.ceil(tail * em.buf.sampleRate),
    em.buf.sampleRate
  );
  const src = oc.createBufferSource();
  src.buffer = em.buf;
  let node = src;
  const chainTo = (n) => { node.connect(n); node = n; };

  if (kind === "dist") {
    const sh = oc.createWaveShaper();
    sh.oversample = "2x";
    sh.curve = distCurve(0.02 + p1 * 0.98);
    chainTo(sh);
  } else if (kind === "crush") {
    const sh = oc.createWaveShaper();
    sh.curve = bitcrushCurve(Math.round(12 - p1 * 10)); // depth 0..1 -> 12..2 bits
    chainTo(sh);
  } else if (kind === "lowpass" || kind === "highpass") {
    const bq = oc.createBiquadFilter();
    bq.type = kind;
    bq.frequency.value = 40 * Math.pow(400, p1); // 40 Hz .. 16 kHz, log
    bq.Q.value = 0.5 + p2 * 12;
    chainTo(bq);
  } else if (kind === "delay") {
    const sum = oc.createGain();
    const dry = oc.createGain();
    const wet = oc.createGain();
    const dl = oc.createDelay(2);
    const fb = oc.createGain();
    node.connect(dry); dry.connect(sum);
    node.connect(dl); dl.connect(fb); fb.connect(dl);
    dl.connect(wet); wet.connect(sum);
    dl.delayTime.value = 0.02 + p1 * 0.98;
    fb.gain.value = 0.4;
    wet.gain.value = p2;
    node = sum;
  } else if (kind === "reverb") {
    const sum = oc.createGain();
    const dry = oc.createGain();
    const wet = oc.createGain();
    const conv = oc.createConvolver();
    conv.buffer = makeImpulse(oc, 0.2 + p1 * 5.8);
    node.connect(dry); dry.connect(sum);
    node.connect(conv); conv.connect(wet); wet.connect(sum);
    wet.gain.value = p2;
    node = sum;
  }
  node.connect(oc.destination);
  src.start();
  emPushUndo();
  em.buf = await oc.startRendering();
  em.sel = null;
  emDraw();
  toast("Applied " + kind);
}

function emPlay() {
  if (!em.buf) return;
  emStop();
  AC.resume();
  const [a, b] = emRegion();
  const src = AC.createBufferSource();
  src.buffer = em.buf;
  src.connect(master);
  src.start(0, a / em.buf.sampleRate, (b - a) / em.buf.sampleRate);
  em.playSrc = src;
}
function emStop() {
  if (em.playSrc) { try { em.playSrc.stop(); } catch (_) {} em.playSrc = null; }
}

/* mic recording */
async function emToggleRecord() {
  const btn = $("#em-record");
  if (em.rec) { em.rec.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Recording needs mic access \u2014 open via http://localhost:8200");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove("recording");
      btn.innerHTML = "&#9679; Record";
      $("#em-recstatus").textContent = "decoding\u2026";
      try {
        const ab = await new Blob(chunks).arrayBuffer();
        const buf = await AC.decodeAudioData(ab);
        if (em.buf) emPushUndo();
        em.buf = buf;
        em.sel = null;
        emDraw();
        $("#em-recstatus").textContent =
          "recorded " + (buf.length / buf.sampleRate).toFixed(1) + "s \u2014 edit, then save";
      } catch (err) {
        $("#em-recstatus").textContent = "";
        toast("Could not decode recording: " + err.message);
      }
      em.rec = null;
    };
    rec.start();
    em.rec = rec;
    btn.classList.add("recording");
    btn.innerHTML = "&#9632; Stop";
    $("#em-recstatus").textContent = "recording\u2026 click Stop when done";
  } catch (err) {
    toast("Mic access denied: " + err.message);
  }
}

/* save back to the library */
function emSanitizeName() {
  let nm = ($("#em-name").value || "sample").trim().replace(/[^A-Za-z0-9._ -]/g, "_");
  if (!nm.toLowerCase().endsWith(".wav")) nm += ".wav";
  return nm;
}

async function emSave(overwrite) {
  if (!em.buf) { toast("No audio to save"); return; }
  const blob = encodeWav(em.buf);
  let rel;
  if (overwrite && em.path) {
    rel = em.path.toLowerCase().endsWith(".wav")
      ? em.path
      : em.path.replace(/\.[^.]+$/, "") + ".wav"; // non-wav originals resave as .wav
  } else {
    rel = (em.folder ? em.folder + "/" : "edited/") + emSanitizeName();
  }
  const res = await fetch("/api/sample/save?path=" + encodeURIComponent(rel)
    + "&overwrite=" + (overwrite ? 1 : 0), {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok) { toast(data.detail || "Save failed"); return; }
  const saved = data.path;
  buffers.delete(saved);           // invalidate cache so the song hears the edit
  try { await getBuffer(saved); } catch (_) {}
  em.path = saved;
  $("#em-replace").disabled = false;
  await refreshPalette();
  renderInstruments();
  scheduleWaveDraw();
  toast((overwrite ? "Replaced: " : "Saved: ") + saved);
}

$("#em-fx").addEventListener("change", emUpdateFxLabels);
function emUpdateFxLabels() {
  const def = FX_DEFS[$("#em-fx").value];
  $("#em-p1-label").textContent = def.p1;
  $("#em-p2-label").textContent = def.p2;
  const hideP2 = def.p2 === "\u2014";
  $("#em-p2").style.visibility = hideP2 ? "hidden" : "visible";
  $("#em-p2-label").style.visibility = hideP2 ? "hidden" : "visible";
}

$("#em-close").addEventListener("click", closeEditor);
$("#em-overlay").addEventListener("mousedown", (e) => {
  if (e.target === $("#em-overlay")) closeEditor();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#em-overlay").hidden) closeEditor();
});
$("#em-play").addEventListener("click", emPlay);
$("#em-stop").addEventListener("click", emStop);
$("#em-undo").addEventListener("click", emUndo);
$("#em-fadein").addEventListener("click", () => emFade(true));
$("#em-fadeout").addEventListener("click", () => emFade(false));
$("#em-normalize").addEventListener("click", emNormalize);
$("#em-trim").addEventListener("click", () => emKeep(true));
$("#em-cut").addEventListener("click", () => emKeep(false));
$("#em-silence").addEventListener("click", emSilence);
$("#em-reverse").addEventListener("click", emReverse);
$("#em-gdown").addEventListener("click", () => emGain(-3));
$("#em-gup").addEventListener("click", () => emGain(3));
$("#em-fxapply").addEventListener("click", () => emApplyFx().catch((e) => toast(e.message)));

/* speed/pitch: real time-stretch and pitch-shift (independent of each other),
   not a naive resample — that always couples the two. Web Audio has no
   built-in for this, so it round-trips to the server (librosa). */
$("#em-speed").addEventListener("input", () => {
  $("#em-speed-val").textContent = parseFloat($("#em-speed").value).toFixed(2) + "x";
});
$("#em-pitch").addEventListener("input", () => {
  const v = parseFloat($("#em-pitch").value);
  $("#em-pitch-val").textContent = (v > 0 ? "+" : "") + v + " st";
});

async function emApplyStretch() {
  if (!em.buf) { toast("No audio loaded"); return; }
  const rate = parseFloat($("#em-speed").value);
  const semitones = parseFloat($("#em-pitch").value);
  if (rate === 1 && semitones === 0) {
    toast("Speed and pitch are both at default — nothing to apply");
    return;
  }
  const blob = encodeWav(em.buf);
  toast("Processing...");
  let res;
  try {
    res = await fetch("/api/sample/stretch?rate=" + rate + "&semitones=" + semitones, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: blob,
    });
  } catch (e) {
    toast("Could not reach the server: " + e.message);
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    toast(data.detail || "Speed/pitch processing failed");
    return;
  }
  const arr = await res.arrayBuffer();
  const newBuf = await AC.decodeAudioData(arr);
  emPushUndo();
  em.buf = newBuf;
  em.sel = null;
  emDraw();
  toast("Applied — speed " + rate.toFixed(2) + "x, pitch " +
        (semitones > 0 ? "+" : "") + semitones + " semitones");
}
$("#em-stretchapply").addEventListener("click", () => emApplyStretch().catch((e) => toast(e.message)));
$("#em-record").addEventListener("click", emToggleRecord);
$("#em-tomelody").addEventListener("click", async () => {
  if (!em.buf) { toast("No audio loaded"); return; }
  await setGenMelody(em.buf);
  toast("Melody set — type a style prompt in GENERATE and go");
});
$("#em-savenew").addEventListener("click", () => emSave(false));
$("#em-replace").addEventListener("click", () => emSave(true));

/* right-click a cell -> edit THAT cell's sample, with a per-cell fork option */
async function openCellSampleEditor(row, ch, slot) {
  const cell = curPat().data[row] && curPat().data[row][ch];
  const target = cell ? (cell.split ? cell.subs[slot] : cell) : null;
  if (!target || target.note == null || target.note === NOTE_OFF) {
    toast("No sample on this cell");
    return;
  }
  const instNum = target.inst != null ? target.inst : ui.curInstrument + 1;
  const inst = song.instruments[instNum - 1];
  if (!inst) {
    toast("This cell uses instrument " + fmt2(instNum) + ", which is empty");
    return;
  }
  await openEditor(inst.path, inst.name);
  if (!em.buf) return; // openEditor failed (missing file etc.)
  emCellTarget = { row, ch, slot, instNum };
  $("#em-title").textContent += "  \u00b7 CELL " + String(row).padStart(2, "0")
    + " / " + (song.channels[ch] ? song.channels[ch].name : "");
  $("#em-applycell").hidden = false;
  $("#em-cellhint").hidden = false;
}

$("#em-applycell").addEventListener("click", async () => {
  if (!emCellTarget) { toast("No cell target"); return; }
  if (!em.buf) { toast("No audio to save"); return; }
  const blob = encodeWav(em.buf);
  const rel = (em.folder ? em.folder + "/" : "edited/") + emSanitizeName();
  const res = await fetch("/api/sample/save?path=" + encodeURIComponent(rel)
    + "&overwrite=0", {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok) { toast(data.detail || "Save failed"); return; }
  await refreshPalette();
  await addInstrument(data.path, data.name); // becomes the current instrument
  const newNum = ui.curInstrument + 1;
  const { row, ch, slot } = emCellTarget;
  const cell = curPat().data[row] && curPat().data[row][ch];
  const target = cell ? (cell.split ? cell.subs[slot] : cell) : null;
  if (target) {
    target.inst = newNum;
    repaintCell(row, ch);
    scheduleWaveDraw();
    renderCellInspector();
    autosave();
    toast("This cell now plays " + fmt2(newNum) + " " + data.name
      + " \u2014 all other cells are untouched");
  } else {
    toast("Saved as " + data.name + ", but the cell no longer exists");
  }
});
$("#btn-rec").addEventListener("click", () => openEditor(null, "recording"));

/* ================= init ================= */
(async function init() {
  ensureChains();
  
  $("#master-vol").value = master.gain.value;
  syncViewToggles();
  startVuLoop();
  applyZoom();
  
  const saved = localStorage.getItem("hackbeat_autosave");
  if (saved) {
    try {
      const data = JSON.parse(saved);
      applyProjectData(data, $("#project-name").value.trim() || "untitled");
      toast("Restored autosave session");
    } catch(e) {
      console.warn("Autosave restore failed, starting fresh", e);
      refreshPatternSelect();
      renderOrderChips(null);
      renderInstruments();
      renderFxPanel();
      renderGrid();
    }
  } else {
    refreshPatternSelect();
    renderOrderChips(null);
    renderInstruments();
    renderFxPanel();
    renderGrid();
  }
  
  await refreshPalette();
  await refreshProjectList();
  grid.focus();
})();
