# Hackbeat

A browser-based music tracker with a twist: instead of the classic up-and-down
pattern grid, time flows left to right — like a video editor's timeline. Each
horizontal lane is a channel, notes live in cells along it, and you can
generate new instrument samples with AI right from a text prompt or by
humming a melody into your mic.

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
- **AI sample generation** — type a style or instrument description and get
  a new sample back via MusicGen. Style buttons steer it toward a single
  instrument, a full layered ensemble, or one sustained note (handy since
  Hackbeat repitches everything from C-5). You can also hum or whistle a
  melody and have it generate new audio that follows your melodic contour.
- **Project save/load** and pattern chaining into a full song, with export.
- **Built-in help panel** covering getting started, entering notes, the
  grid, the sample editor, mixing/effects, AI generation, and keyboard
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

That gets you the full tracker — grid, samples, effects, save/load. AI
generation needs a heavier, optional set of dependencies:

```bash
venv/bin/pip install -r requirements-ai.txt
```

The AI model downloads automatically the first time you hit Generate (~1.5–2GB),
so that first run is slow — every run after is fast. A GPU is strongly
recommended for generation; the core tracker doesn't need one at all.

## Requirements

- Python 3.13 (developed and tested against it; nearby versions likely fine)
- A GPU with free VRAM if you want AI sample generation — the tracker
  itself runs fine without one

## Status

Actively being worked on. Screenshots and a proper demo are coming in a
follow-up post — for now, the fastest way to see what it does is to run it.

## License

Not yet chosen. Treat as all-rights-reserved until this section says
otherwise — open an issue if you want to use this and I haven't picked one yet.
