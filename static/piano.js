/* =====================================================================
   piano.js — a keyboard you can actually play with your fingers.

   Hackbeat's only instrument was the computer keyboard (z = C, s = C#, and
   so on). That's fast once it's in your hands and completely useless on a
   phone, which has no such keys.

   This is a real keyboard: white keys full height, black keys on top,
   sized to fill whatever width it's given so a phone in portrait still
   gets a playable octave.

   Three things make it feel like an instrument rather than buttons:
     * notes fire on finger-DOWN, not on click, so there's no lag
     * several fingers at once make chords
     * where you hit a key sets velocity — near the tip is soft, down at
       the base is hard, the way a real keybed responds
   And sliding a held finger across the keys glissandos, because that's
   the first thing anyone tries.
   ===================================================================== */

const WHITE = [
  { n: "C",  s: 0,  col: 0 }, { n: "D", s: 2,  col: 1 }, { n: "E", s: 4,  col: 2 },
  { n: "F",  s: 5,  col: 3 }, { n: "G", s: 7,  col: 4 }, { n: "A", s: 9,  col: 5 },
  { n: "B",  s: 11, col: 6 },
];
const BLACK = [
  { n: "C#", s: 1,  after: 0 }, { n: "D#", s: 3,  after: 1 },
  { n: "F#", s: 6,  after: 3 }, { n: "G#", s: 8,  after: 4 },
  { n: "A#", s: 10, after: 5 },
];

class Piano {
  /**
   * @param {HTMLElement} host
   * @param {object} opts {octaves, getOctave, onNoteOn(midi, vel), onNoteOff(midi)}
   */
  constructor(host, opts) {
    this.host = host;
    this.opts = Object.assign({ octaves: 2 }, opts);
    this.down = new Map();      // pointerId -> midi, for glide and key-up
    this.el = document.createElement("div");
    this.el.className = "piano";
    host.appendChild(this.el);
    this.build();
    this.wire();
  }

  build() {
    // octaves may be a function so turning a phone sideways widens the
    // keyboard instead of leaving one lonely octave stretched across it
    const oct = typeof this.opts.octaves === "function"
      ? this.opts.octaves() : this.opts.octaves;
    this.el.innerHTML = "";
    this.el.style.setProperty("--whites", String(7 * oct));
    const base = (this.opts.getOctave ? this.opts.getOctave() : 4) * 12;

    for (let o = 0; o < oct; o++) {
      for (const w of WHITE) {
        const k = document.createElement("div");
        k.className = "pk white";
        k.dataset.midi = String(base + o * 12 + w.s);
        k.style.gridColumn = String(o * 7 + w.col + 1);
        // only label C, so the octave is findable without a wall of text
        if (w.n === "C") {
          const lab = document.createElement("span");
          lab.textContent = "C" + Math.floor((base + o * 12) / 12);
          k.appendChild(lab);
        }
        this.el.appendChild(k);
      }
      for (const b of BLACK) {
        const k = document.createElement("div");
        k.className = "pk black";
        k.dataset.midi = String(base + o * 12 + b.s);
        // sits over the gap between two whites
        k.style.gridColumn = String(o * 7 + b.after + 1);
        this.el.appendChild(k);
      }
    }
  }

  /** Rebuild for a new octave without losing the wiring. */
  refresh() { this.build(); }

  keyAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.classList.contains("pk") ? el : null;
  }

  /** Hit near the top of a key = soft, near the bottom = hard. */
  velocityFor(keyEl, y) {
    const r = keyEl.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (y - r.top) / Math.max(1, r.height)));
    return 0.35 + t * 0.65;
  }

  press(keyEl, pointerId, y) {
    const midi = parseInt(keyEl.dataset.midi, 10);
    const prev = this.down.get(pointerId);
    if (prev === midi) return;
    if (prev != null) this.lift(pointerId);
    this.down.set(pointerId, midi);
    keyEl.classList.add("on");
    if (this.opts.onNoteOn) this.opts.onNoteOn(midi, this.velocityFor(keyEl, y));
  }

  lift(pointerId) {
    const midi = this.down.get(pointerId);
    if (midi == null) return;
    this.down.delete(pointerId);
    // only un-light the key if no other finger is still on it
    if (![...this.down.values()].includes(midi)) {
      const k = this.el.querySelector('.pk[data-midi="' + midi + '"].on');
      if (k) k.classList.remove("on");
      if (this.opts.onNoteOff) this.opts.onNoteOff(midi);
    }
  }

  wire() {
    this.el.addEventListener("pointerdown", (e) => {
      const k = this.keyAt(e.clientX, e.clientY);
      if (!k) return;
      // Sound the note FIRST. Capture only exists so a finger that slides off
      // the keyboard still reports its release, and it throws on some pointer
      // ids — never let that stand between a key press and a note.
      this.press(k, e.pointerId, e.clientY);
      try { this.el.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!this.down.has(e.pointerId)) return;
      const k = this.keyAt(e.clientX, e.clientY);
      if (k) this.press(k, e.pointerId, e.clientY);
      e.preventDefault();
    });
    const up = (e) => this.lift(e.pointerId);
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
    this.el.addEventListener("pointerleave", up);
    // a finger dragged off the whole keyboard should still let go
    window.addEventListener("pointerup", up);
  }

  /** Light a key from outside — used so computer-keyboard playing shows here too. */
  highlight(midi, on) {
    const k = this.el.querySelector('.pk[data-midi="' + midi + '"]');
    if (k) k.classList.toggle("on", !!on);
  }

  allOff() {
    for (const k of this.el.querySelectorAll(".pk.on")) k.classList.remove("on");
    this.down.clear();
  }
}

window.HB_PIANO = { Piano };
