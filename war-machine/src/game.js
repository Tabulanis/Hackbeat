// War Machine — the whole game in one module.
//
// Three.js scene, beat-synced spawning, swipe slicing, scoring and the
// menu/pause/game-over flow. Deliberately kept in one file so the flow is
// easy to read top to bottom.

import * as THREE from 'three';
import { BeatClock } from './beat.js';
import { Input } from './input.js';

// --------------------------------------------------------------- tuning

const Z_SPAWN = -55;         // where targets appear (deep in the fog)
const Z_SLICE = 0;           // the beat line: targets cross it exactly on a tick
const Z_MISS = 9;            // past the camera = missed
const APPROACH_BEATS = 4;    // how many beats a target is in flight
const CAMERA_POS = new THREE.Vector3(0, 1.9, 7);
const CAMERA_LOOK = new THREE.Vector3(0, 1.6, -30);
const LANE_Y = [0.9, 3.0];   // vertical band targets fly through
const PERFECT_WINDOW = 0.09; // seconds either side of the beat
const GREAT_WINDOW = 0.2;
const DIR_TOLERANCE = Math.PI / 4 + 0.15; // how exact a missile swipe must be
const GRAVITY = 14;
const TARGET_SCALE = 1.35;   // targets are built at unit-ish size, then scaled up

const TYPES = {
  drone:   { points: 10, color: 0x45d0ff, css: '#45d0ff', r: 0.75 },
  missile: { points: 25, color: 0xffa033, css: '#ffa033', r: 0.85, directional: true },
  mine:    { points: 0,  color: 0xff3a5e, css: '#ff3a5e', r: 0.7,  mine: true },
};

// Eight swipe directions a missile can demand. Angles in the screen plane,
// 0 = right, counter-clockwise, y up.
const DIRS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i * Math.PI) / 4);

// Difficulty ramps one level every 4 bars. Each entry is a set of spawn
// probabilities per 16th-note tick.
const LEVELS = [
  { every: 8, beat: 1.0, eighth: 0.0,  sixteenth: 0.0,  missile: 0.0,  mine: 0.0,  double: 0.0 },
  { every: 4, beat: 0.9, eighth: 0.0,  sixteenth: 0.0,  missile: 0.2,  mine: 0.15, double: 0.0 },
  { every: 4, beat: 0.9, eighth: 0.3,  sixteenth: 0.0,  missile: 0.3,  mine: 0.2,  double: 0.1 },
  { every: 4, beat: 1.0, eighth: 0.5,  sixteenth: 0.05, missile: 0.35, mine: 0.25, double: 0.2 },
  { every: 4, beat: 1.0, eighth: 0.65, sixteenth: 0.1,  missile: 0.4,  mine: 0.3,  double: 0.3 },
  { every: 4, beat: 1.0, eighth: 0.8,  sixteenth: 0.2,  missile: 0.45, mine: 0.35, double: 0.4 },
];

const STATE = { MENU: 'menu', PLAY: 'play', PAUSE: 'pause', OVER: 'over' };

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

// ---------------------------------------------------------- 3D builders

const GEO = {
  drone: new THREE.OctahedronGeometry(0.72, 0),
  missile: new THREE.BoxGeometry(1.15, 1.15, 1.15),
  arrowHead: new THREE.ConeGeometry(0.32, 0.5, 3),
  arrowShaft: new THREE.BoxGeometry(0.16, 0.45, 0.12),
  mine: new THREE.IcosahedronGeometry(0.5, 0),
  spike: new THREE.ConeGeometry(0.13, 0.45, 5),
};

function neon(color, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.55,
    flatShading: true, roughness: 0.4, metalness: 0.2, ...extra,
  });
}

const MAT = {
  drone: neon(TYPES.drone.color),
  missile: neon(TYPES.missile.color),
  arrow: neon(0xffffff, { emissiveIntensity: 0.9 }),
  mine: neon(TYPES.mine.color, { emissiveIntensity: 0.7 }),
  spike: neon(0x7a1e30, { emissiveIntensity: 0.3 }),
};

/** Build the visual for a target as a Group so halves can clone it. */
function buildTarget(type, dir) {
  const g = new THREE.Group();
  if (type === 'drone') {
    g.add(new THREE.Mesh(GEO.drone, MAT.drone));
  } else if (type === 'missile') {
    g.add(new THREE.Mesh(GEO.missile, MAT.missile));
    // Arrow on the face that looks at the camera, pointing along `dir`.
    const arrow = new THREE.Group();
    const head = new THREE.Mesh(GEO.arrowHead, MAT.arrow);
    head.position.y = 0.32;
    const shaft = new THREE.Mesh(GEO.arrowShaft, MAT.arrow);
    shaft.position.y = -0.12;
    arrow.add(head, shaft);
    arrow.position.z = 0.62;
    arrow.rotation.z = dir - Math.PI / 2;   // cone points +y by default
    g.add(arrow);
  } else {
    g.add(new THREE.Mesh(GEO.mine, MAT.mine));
    const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [x, y, z] of axes) {
      const s = new THREE.Mesh(GEO.spike, MAT.spike);
      s.position.set(x * 0.6, y * 0.6, z * 0.6);
      s.lookAt(x * 2, y * 2, z * 2);
      s.rotateX(Math.PI / 2);
      g.add(s);
    }
  }
  return g;
}

// ------------------------------------------------------------ particles

class Sparks {
  constructor(scene, n = 500) {
    this.n = n;
    this.next = 0;
    this.pos = new Float32Array(n * 3).fill(1000);
    this.col = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(this.geo, new THREE.PointsMaterial({
      size: 0.2, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.tmp = new THREE.Color();
  }

  burst(p, color, count, power) {
    this.tmp.set(color);
    for (let k = 0; k < count; k++) {
      const i = this.next++ % this.n;
      this.pos.set([p.x, p.y, p.z], i * 3);
      const dir = new THREE.Vector3().randomDirection().multiplyScalar(rand(0.3, 1) * power);
      this.vel.set([dir.x, dir.y, dir.z], i * 3);
      const bright = rand(0.6, 1.4);
      this.col.set([this.tmp.r * bright, this.tmp.g * bright, this.tmp.b * bright], i * 3);
      this.life[i] = rand(0.4, 0.9);
    }
  }

  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) { this.pos[j + 2] = 1000; continue; }
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.vel[j + 1] -= 9 * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

// ----------------------------------------------------------------- game

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.beat = new BeatClock();
    this.input = new Input(canvas);
    this.state = STATE.MENU;
    this.best = Number(localStorage.getItem('warmachine.best') || 0);
    this.targets = [];
    this.halves = [];
    this.shake = 0;
    this.lastFrame = 0;

    this.setupScene();
    this.setupDOM();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === STATE.PLAY) this.pause();
    });
  }

  // ------------------------------------------------------------- setup

  setupScene() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;   // needed for the sliced halves

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06070c);
    this.scene.fog = new THREE.Fog(0x06070c, 14, 58);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    this.camera.position.copy(CAMERA_POS);
    this.camera.lookAt(CAMERA_LOOK);

    this.scene.add(new THREE.AmbientLight(0x6070a0, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 8, 6);
    this.scene.add(sun);
    this.pulseLight = new THREE.PointLight(0x9a7cff, 60, 60, 1.5);
    this.pulseLight.position.set(0, 5, -6);
    this.scene.add(this.pulseLight);

    // Neon tunnel: a floor grid and two wall grids that scroll on the beat.
    const mkGrid = () => {
      const g = new THREE.GridHelper(240, 60, 0x8c7cff, 0x3a3f8a);
      g.material.transparent = true;
      g.material.opacity = 0.6;
      g.material.depthWrite = false;
      return g;
    };
    this.floor = mkGrid();
    this.wallL = mkGrid();
    this.wallL.rotation.z = Math.PI / 2;
    this.wallL.position.set(-9, 0, 0);
    this.wallR = mkGrid();
    this.wallR.rotation.z = Math.PI / 2;
    this.wallR.position.set(9, 0, 0);
    this.scene.add(this.floor, this.wallL, this.wallR);

    // The beat line: a glowing bar across the floor where z = Z_SLICE.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 0.12),
      new THREE.MeshBasicMaterial({
        color: 0xb9a8ff, transparent: true, opacity: 0.6,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.02, Z_SLICE);
    this.beatLine = line;
    this.scene.add(line);

    this.sparks = new Sparks(this.scene);
    this.resize();
  }

  setupDOM() {
    const $ = (id) => document.getElementById(id);
    this.dom = {
      hud: $('hud'), score: $('score'), lives: $('lives'), combo: $('combo'),
      beatFill: $('beat-fill'), menu: $('menu'), pause: $('pause'), over: $('over'),
      final: $('final'), finalBest: $('final-best'), best: $('best'), again: $('again'),
    };
    this.dom.menu.querySelectorAll('button[data-bpm]').forEach((b) => {
      b.addEventListener('click', () => this.startRun(Number(b.dataset.bpm), b.dataset.name));
    });
    this.dom.again.addEventListener('click', () => this.toMenu());
    this.dom.pause.addEventListener('click', () => this.resume());
    this.dom.best.textContent = this.best ? `BEST ${String(this.best).padStart(6, '0')}` : '';
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Keep spawns inside the visible lane whatever the aspect ratio.
    const halfW = Math.tan(THREE.MathUtils.degToRad(30)) * (CAMERA_POS.z - Z_SLICE) * this.camera.aspect;
    this.laneX = Math.min(3.8, halfW * 0.7);
  }

  // -------------------------------------------------------------- flow

  run() {
    const loop = (ts) => {
      const dt = Math.min(0.05, (ts - this.lastFrame) / 1000 || 0);
      this.lastFrame = ts;
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  startRun(bpm, name) {
    this.clearField();
    this.score = 0;
    this.combo = 0;
    this.lives = 3;
    this.chartTick = 0;
    this.bpm = bpm;
    this.difficultyName = name;
    this.beat.start(bpm);
    this.state = STATE.PLAY;
    this.dom.menu.classList.add('hidden');
    this.dom.over.classList.add('hidden');
    this.dom.hud.classList.remove('hidden');
    this.updateHUD();
    this.floater('READY', window.innerWidth / 2, window.innerHeight * 0.4, '#fff');
  }

  pause() {
    if (this.state !== STATE.PLAY) return;
    this.state = STATE.PAUSE;
    this.beat.pause();
    this.dom.pause.classList.remove('hidden');
  }

  resume() {
    if (this.state !== STATE.PAUSE) return;
    this.state = STATE.PLAY;
    this.beat.resume();
    this.dom.pause.classList.add('hidden');
    this.input.consumeSegments(); // drop any swipe made while paused
  }

  gameOver() {
    this.state = STATE.OVER;
    this.beat.stop();
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem('warmachine.best', String(this.best));
    }
    this.dom.final.textContent = String(this.score).padStart(6, '0');
    this.dom.finalBest.textContent = `BEST ${String(this.best).padStart(6, '0')}`;
    setTimeout(() => this.dom.over.classList.remove('hidden'), 900);
  }

  toMenu() {
    this.clearField();
    this.state = STATE.MENU;
    this.dom.over.classList.add('hidden');
    this.dom.hud.classList.add('hidden');
    this.dom.menu.classList.remove('hidden');
    this.dom.best.textContent = this.best ? `BEST ${String(this.best).padStart(6, '0')}` : '';
  }

  clearField() {
    for (const t of this.targets) this.scene.remove(t.obj);
    for (const h of this.halves) this.disposeHalf(h);
    this.targets = [];
    this.halves = [];
    document.querySelectorAll('.floater').forEach((el) => el.remove());
  }

  // ------------------------------------------------------------ update

  update(dt) {
    const keys = this.input.consumeKeys();
    for (const k of keys) {
      if (k === 'p' || k === 'P' || k === 'Escape') {
        if (this.state === STATE.PLAY) this.pause();
        else if (this.state === STATE.PAUSE) this.resume();
      }
      if (this.state === STATE.MENU && ['1', '2', '3'].includes(k)) {
        const btn = this.dom.menu.querySelectorAll('button[data-bpm]')[Number(k) - 1];
        btn.click();
      }
    }

    const phase = this.state === STATE.PLAY ? this.beat.beatPhase() : (performance.now() / 500) % 1;
    this.animateWorld(dt, phase);

    if (this.state === STATE.PLAY) {
      this.updatePlay(dt);
    } else {
      this.input.consumeSegments();
    }
    this.input.pruneTrail();
    this.updateHalves(dt);
    this.sparks.update(dt);
  }

  animateWorld(dt, phase) {
    const pulse = Math.pow(1 - phase, 3);
    const cell = 240 / 60;
    this.floor.position.z = phase * cell;
    this.wallL.position.z = phase * cell;
    this.wallR.position.z = phase * cell;
    this.floor.material.opacity = 0.35 + pulse * 0.4;
    this.wallL.material.opacity = this.wallR.material.opacity = 0.2 + pulse * 0.3;
    this.pulseLight.intensity = 40 + pulse * 120;
    this.beatLine.material.opacity = 0.25 + pulse * 0.6;
    this.beatLine.scale.y = 1 + pulse * 2;

    // Camera shake after a mine.
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const s = this.shake * this.shake * 0.6;
    this.camera.position.set(
      CAMERA_POS.x + (Math.random() - 0.5) * s,
      CAMERA_POS.y + (Math.random() - 0.5) * s,
      CAMERA_POS.z,
    );
    this.camera.lookAt(CAMERA_LOOK);
    if (this.dom.beatFill) this.dom.beatFill.style.transform = `scaleX(${1 - phase})`;
  }

  updatePlay(dt) {
    const now = this.beat.now();
    const approach = APPROACH_BEATS * this.beat.beatLen;
    const speed = (Z_SLICE - Z_SPAWN) / approach;

    // Plan the chart far enough ahead that targets exist before they are visible.
    while (this.beat.tickTime(this.chartTick) < now + approach + 0.2) {
      this.planTick(this.chartTick);
      this.chartTick++;
    }

    // Move targets. Position comes straight from the audio clock, so they
    // stay glued to the beat even if frames hitch.
    for (const t of this.targets) {
      const z = Z_SLICE + (now - t.arrive) * speed;
      t.obj.position.set(t.x, t.y + Math.sin(now * 2 + t.bob) * 0.12, z);
      if (!t.def.directional) t.obj.rotation.y += dt * t.spin;
      if (!t.def.directional) t.obj.rotation.x += dt * t.spin * 0.4;
      t.punch = Math.max(0, t.punch - dt * 4);
      t.obj.scale.setScalar(TARGET_SCALE * (1 + t.punch * 0.3));
      if (z > Z_MISS) {
        t.dead = true;
        if (!t.def.mine) this.miss(t);
      }
    }
    this.targets = this.targets.filter((t) => {
      if (t.dead) this.scene.remove(t.obj);
      return !t.dead;
    });

    // Slicing.
    const segs = this.input.consumeSegments();
    if (segs.length && this.targets.length) this.slice(segs, now);
  }

  planTick(tick) {
    const bar = Math.floor(tick / BeatClock.TICKS_PER_BAR);
    const inBar = tick % BeatClock.TICKS_PER_BAR;
    if (bar < 1) return; // one bar of count-in
    const L = LEVELS[Math.min(LEVELS.length - 1, Math.floor((bar - 1) / 4))];
    const arrive = this.beat.tickTime(tick);
    const spawns = [];
    const roll = (p) => Math.random() < p;
    const main = () => (roll(L.missile) ? 'missile' : 'drone');

    if (inBar % L.every === 0) {
      if (roll(L.beat)) spawns.push(main());
      if (roll(L.double)) spawns.push('drone');
    } else if (inBar % 2 === 0) {
      if (roll(L.eighth)) spawns.push(main());
      if (inBar % 4 === 2 && roll(L.mine)) spawns.push('mine');
    } else if (roll(L.sixteenth)) {
      spawns.push('drone');
    }

    const usedX = [];
    for (const type of spawns) {
      let x = rand(-this.laneX, this.laneX);
      for (let tries = 0; tries < 6 && usedX.some((u) => Math.abs(u - x) < 1.8); tries++) {
        x = rand(-this.laneX, this.laneX);
      }
      usedX.push(x);
      this.spawn(type, x, rand(LANE_Y[0], LANE_Y[1]), arrive);
    }
  }

  spawn(type, x, y, arrive) {
    const def = TYPES[type];
    const dir = def.directional ? pick(DIRS) : 0;
    const obj = buildTarget(type, dir);
    obj.position.set(x, y, Z_SPAWN);
    obj.scale.setScalar(TARGET_SCALE);
    this.scene.add(obj);
    this.targets.push({
      type, def, obj, x, y, arrive, dir,
      spin: rand(1.5, 3.5) * (Math.random() < 0.5 ? -1 : 1),
      bob: Math.random() * Math.PI * 2,
      punch: 0, flashUntil: 0, dead: false,
    });
  }

  // ------------------------------------------------------------ slicing

  /** Screen-space position and radius (in CSS px) of a target. */
  projectTarget(t) {
    const W = window.innerWidth, H = window.innerHeight;
    const c = t.obj.position.clone().project(this.camera);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const e = t.obj.position.clone().addScaledVector(up, t.def.r * TARGET_SCALE).project(this.camera);
    const sx = (c.x + 1) / 2 * W, sy = (1 - c.y) / 2 * H;
    const ex = (e.x + 1) / 2 * W, ey = (1 - e.y) / 2 * H;
    return { x: sx, y: sy, r: Math.hypot(ex - sx, ey - sy), behind: c.z > 1 };
  }

  slice(segs, now) {
    const projected = this.targets.map((t) => this.projectTarget(t));
    for (const s of segs) {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy);
      if (len < 3) continue;
      for (let i = 0; i < this.targets.length; i++) {
        const t = this.targets[i];
        const p = projected[i];
        if (t.dead || p.behind || now < t.flashUntil) continue;
        if (pointSegmentDistance(p.x, p.y, s.x1, s.y1, s.x2, s.y2) > p.r) continue;

        const swipeAngle = Math.atan2(-dy, dx); // y up
        if (t.def.directional && angleDiff(swipeAngle, t.dir) > DIR_TOLERANCE) {
          this.wrongWay(t, now, p);
          continue;
        }
        this.cut(t, now, dx / len, dy / len, p);
      }
    }
  }

  cut(t, now, ndx, ndy, p) {
    t.dead = true;
    this.scene.remove(t.obj);
    const pos = t.obj.position.clone();

    if (t.def.mine) {
      this.lives--;
      this.combo = 0;
      this.shake = 1;
      this.beat.explode();
      this.sparks.burst(pos, 0xff3a5e, 90, 9);
      this.sparks.burst(pos, 0xffaa55, 40, 5);
      this.floater('BOOM', p.x, p.y, TYPES.mine.css);
      this.updateHUD();
      if (this.lives <= 0) this.gameOver();
      return;
    }

    // Cut plane: contains the swipe direction (lifted into camera space) and
    // the view direction, passing through the target's centre.
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const swipe = right.multiplyScalar(ndx).addScaledVector(up, -ndy).normalize();
    const view = this.camera.getWorldDirection(new THREE.Vector3());
    const normal = new THREE.Vector3().crossVectors(swipe, view).normalize();
    this.spawnHalves(t, normal);

    // Scoring.
    const off = Math.abs(now - t.arrive);
    let label, mult, color;
    if (off <= PERFECT_WINDOW) { label = 'PERFECT'; mult = 2; color = '#ffd166'; this.beat.perfect(); }
    else if (off <= GREAT_WINDOW) { label = 'GREAT'; mult = 1.5; color = '#45d0ff'; }
    else { label = 'HIT'; mult = 1; color = '#ffffff'; }
    this.combo++;
    const pts = Math.round(t.def.points * mult * this.multiplier);
    this.score += pts;
    this.beat.slice();
    this.sparks.burst(pos, t.def.color, 36, 6);
    this.floater(`${label} +${pts}`, p.x, p.y, color);
    this.updateHUD();
  }

  wrongWay(t, now, p) {
    t.flashUntil = now + 0.4;
    t.punch = 1;
    this.combo = 0;
    this.beat.miss();
    this.floater('WRONG WAY', p.x, p.y, TYPES.missile.css);
    this.updateHUD();
  }

  miss(t) {
    this.lives--;
    this.combo = 0;
    this.beat.miss();
    this.floater('MISS', window.innerWidth / 2, window.innerHeight * 0.8, TYPES.mine.css);
    this.updateHUD();
    if (this.lives <= 0) this.gameOver();
  }

  get multiplier() { return Math.min(4, 1 + Math.floor(this.combo / 8)); }

  // ------------------------------------------------------------- halves

  spawnHalves(t, normal) {
    const speed = (Z_SLICE - Z_SPAWN) / (APPROACH_BEATS * this.beat.beatLen);
    for (const side of [1, -1]) {
      const obj = t.obj.clone(true);
      const plane = new THREE.Plane();
      const mats = [];
      obj.traverse((m) => {
        if (!m.isMesh) return;
        m.material = m.material.clone();
        m.material.clippingPlanes = [plane];
        m.material.side = THREE.DoubleSide;
        mats.push(m.material);
      });
      obj.scale.setScalar(TARGET_SCALE);
      this.scene.add(obj);
      this.halves.push({
        obj, plane, mats, normal, side,
        vel: new THREE.Vector3(0, rand(1, 3), speed * 0.6).addScaledVector(normal, side * rand(3, 5)),
        spin: side * rand(2, 5),
        life: 1.1,
      });
    }
  }

  updateHalves(dt) {
    for (const h of this.halves) {
      h.life -= dt;
      if (h.life <= 0) { this.disposeHalf(h); continue; }
      h.obj.position.addScaledVector(h.vel, dt);
      h.vel.y -= GRAVITY * dt;
      h.obj.rotateOnWorldAxis(h.normal, h.spin * dt);
      // Keep the clip plane through the piece's centre so the cut face
      // stays put as it tumbles (rotation is about the plane normal).
      h.plane.setFromNormalAndCoplanarPoint(
        h.normal.clone().multiplyScalar(h.side), h.obj.position,
      );
      const a = Math.min(1, h.life * 2.5);
      for (const m of h.mats) { m.transparent = true; m.opacity = a; }
    }
    this.halves = this.halves.filter((h) => h.life > 0);
  }

  disposeHalf(h) {
    this.scene.remove(h.obj);
    for (const m of h.mats) m.dispose();
  }

  // ---------------------------------------------------------------- HUD

  updateHUD() {
    this.dom.score.textContent = String(this.score).padStart(6, '0');
    this.dom.lives.querySelectorAll('span').forEach((s, i) => s.classList.toggle('off', i >= this.lives));
    this.dom.combo.innerHTML = this.combo >= 3
      ? `${this.combo}x COMBO${this.multiplier > 1 ? `<small>SCORE x${this.multiplier}</small>` : ''}`
      : '';
  }

  floater(text, x, y, color) {
    const el = document.createElement('div');
    el.className = 'floater';
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.color = color;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }
}

function pointSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let u = 0;
  if (len2 > 0) u = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
}
