// Input — one pointer (mouse, touch or pen) is the blade.
//
// While the pointer is held down every movement becomes a line segment.
// The game tests those segments against targets each frame, so a fast
// swipe that crosses a target between two frames still counts.

const TRAIL_LIFE = 140; // ms a trail point stays visible

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = false;
    this.pos = { x: 0, y: 0 };
    this.trail = [];      // [{x, y, t}] recent blade positions, for drawing
    this.segments = [];   // [{x1, y1, x2, y2}] not yet consumed by the game
    this.taps = [];       // [{x, y}] pointer-down positions, for menus
    this.keyPresses = []; // key names pressed since last consume

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keyPresses.push(e.key);
    });
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  }

  onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.down = true;
    const p = this.point(e);
    this.pos = p;
    this.trail = [p];
    this.taps.push({ x: p.x, y: p.y });
  }

  onMove(e) {
    if (!this.down) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const p = this.point(ev);
      const last = this.trail[this.trail.length - 1] || this.pos;
      const dx = p.x - last.x, dy = p.y - last.y;
      if (dx * dx + dy * dy < 1) continue;
      this.segments.push({ x1: last.x, y1: last.y, x2: p.x, y2: p.y });
      this.trail.push(p);
      this.pos = p;
    }
  }

  onUp(e) {
    this.down = false;
  }

  consumeSegments() {
    const s = this.segments;
    this.segments = [];
    return s;
  }

  consumeTaps() {
    const t = this.taps;
    this.taps = [];
    return t;
  }

  consumeKeys() {
    const k = this.keyPresses;
    this.keyPresses = [];
    return k;
  }

  /** Drop stale trail points so the blade fades behind the pointer. */
  pruneTrail(now = performance.now()) {
    while (this.trail.length && now - this.trail[0].t > TRAIL_LIFE) this.trail.shift();
    if (!this.down && this.trail.length === 1) this.trail.length = 0;
  }
}
