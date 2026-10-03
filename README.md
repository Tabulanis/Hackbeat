# Hackbeat

A browser-based music tracker with a twist: instead of the classic up-and-down
pattern grid, time flows left to right — like a video editor's timeline. Each
horizontal lane is a channel, notes live in cells along it, and you can
find real recorded instrument samples just by describing them.

Runs entirely in your browser against a small local Python server. No
account, no cloud dependency for the actual music-making.

## Features

- **Timeline-style tracker grid** — OpenMPT-inspired pattern editing, but
  horizontal instead of vertical. Each channel gets its own instrument,
  volume, mute/solo, and effects.
- **Per-channel effects chain** — EQ → panner → distortion → bitcrush →
  chorus → delay → reverb, all in-browser via the Web Audio API.
- **Sample library** — comes with a small set of synthesized starter sounds
  (kick, snare, hats, clap, bass notes, pad chords), and you can drop in your
  own audio (wav/mp3/ogg/flac/aiff/m4a/webm) or record straight into it.
- **Find a Sound** — describe a sound ("dry tight snare", "warm cello note")
  and get the closest real recordings from thousands of free samples (VCSL,
  VSCO-2 CE, NSynth), matched by CLAP (Apache-2.0). Or find sounds *like* the
  one in the editor. Known pitches are set so a found note plays in tune.
- **Sample editor** — 40 effects (filters, drive, modulation, space, dynamics,
  octaves/unison, recording styles from studio to vinyl to telephone), each
  blended along a drawable envelope; one-hit trim; pitch and speed.
- **Project save/load** and pattern chaining into a full song, with export.
- **Built-in help panel** covering getting started, entering notes, the
  grid, the sample editor, mixing/effects, finding sounds, and keyboard
  shortcuts — open it from the app itself, no need to leave the page.

## Quickstart

```bash
git clone https://github.com/Tabulanis/Hackbeat.git
cd Hackbeat
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python server.py
```

Then open **http://localhost:8200**.

That gets you the full tracker — grid, samples, effects, save/load. Find a
Sound needs a heavier, optional set of dependencies, the sample libraries
(~6 GB download) and a one-time index build:

```bash
venv/bin/pip install -r requirements-ai.txt
samples/library/_dl/fetch.sh            # VCSL, VSCO-2 CE, NSynth test+valid
nice venv/bin/python library.py build   # listens to every sample once (CPU, resumable)
```

The search model (~800 MB) downloads on first use. It runs on the CPU and
unloads itself after 10 idle minutes. The libraries' licences are in
LIBRARY-CREDITS.md — NSynth needs a credit if you ship its sounds.

## Requirements

- Python 3.13 (developed and tested against it; nearby versions likely fine)
- No GPU needed for anything

## Status

Actively being worked on. 

## License

Not yet chosen. Treat as all-rights-reserved until this section says
otherwise — open an issue if you want to use this and I haven't picked one yet.
