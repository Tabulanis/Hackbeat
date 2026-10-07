# War Machine

Fruit Ninja meets Beat Saber. Drones, missiles and mines fly down a neon
tunnel toward you in time with the beat. Swipe to slice them in half.

Built with [Three.js](https://threejs.org/) and plain JavaScript. No build
step, no npm install, no accounts. One HTML file, three small modules, and a
vendored copy of Three.js.

## Play it

Browsers won't load ES modules from `file://`, so serve the folder over HTTP.
Any static server works. From this folder:

```bash
python3 -m http.server 8300
```

Then open **http://localhost:8300**. Works with a mouse, a trackpad, or a
finger on a phone.

## How it plays

- **Drones** (cyan) — swipe through them in any direction.
- **Missiles** (orange) — swipe *along the arrow* they show, Beat Saber
  style. The wrong direction bounces off, costs your combo, and the missile
  keeps coming.
- **Mines** (red) — never touch. Slicing one costs a life.
- Every target crosses the glowing **beat line** exactly on a beat. Slice it
  within a few frames of that moment for **PERFECT** (2x points) or
  **GREAT** (1.5x).
- Letting a drone or missile fly past you costs a life. Three lives.
- Consecutive hits build a **combo**; every 8 hits raises the score
  multiplier, up to 4x.
- Difficulty ramps every four bars: more targets, more off-beat spawns,
  more missiles and mines.
- Pick a tempo on the menu: **RECRUIT** 100 BPM, **SOLDIER** 125 BPM,
  **WARLORD** 150 BPM. Faster beat, faster targets.
- Press **P** or **Esc** to pause. Best score is saved in the browser.

## Layout

```
war-machine/
  index.html        page, HUD and menus (plain DOM)
  styles.css
  src/
    main.js         boots the game
    game.js         Three.js scene, spawning, slicing, scoring, menus
    beat.js         Web Audio metronome + synth drums + sound effects
    input.js        pointer tracking → swipe segments
  vendor/
    three.module.js Three.js (MIT), pinned copy so it works offline
    three.core.js
```

## How it works

- `beat.js` schedules synthesised kick/snare/hat hits a little ahead of time
  on the audio clock. That same clock is the game's notion of "now": each
  target gets an *arrive* time on a 16th-note tick and its position each
  frame is computed straight from the clock, so targets stay glued to the
  music even when frames hitch.
- `input.js` turns pointer movement into line segments. `game.js` projects
  every target to screen space and tests the segments against its projected
  circle, so a fast flick that crosses a target between two frames still
  counts.
- A slice builds a world-space cut plane from the swipe direction and the
  view direction. The two halves are clones of the target with a Three.js
  clipping plane each, pushed apart along the plane normal and spun about
  it, so the cut face stays clean while they tumble.

## Ideas for later

- Real songs: beat-detect an audio file and drive spawns from it.
- Charted levels instead of the procedural ramp.
- Bloom post-processing for proper neon.
- Two-colour targets for left/right hand on touch screens.
