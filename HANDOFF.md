# Hackbeat — handoff (2026-10-09)

Read this first when a session starts here to write music for Fortissimo (the rhythm game in `../GardenRhythm`).

## What this is
A browser tracker: time runs left → right, one lane per channel, real recorded samples found by description
(CLAP search over VCSL / VSCO-2 CE / NSynth). README.md has the full feature list and shortcuts; the in-app Help panel too.

## Run it
```
cd ~/aidojo/current/Hackbeat && ./start.sh        # venv/bin/python server.py → http://localhost:8200
```
`venv/` is the working environment (`venv.broken-2026-08/` is dead, ignore it). Projects save to `projects/*.json`.
The sound finder also runs without the server: `venv/bin/python -c "import library; library.search('warm cello note', 5)"`.

## The projects in here
- `garden-round1/2/3.json` — the three original Fortissimo rounds (drums / guns / boss), the ones the game shipped with.
- `Dope.json` — round 1's NSynth version.
- `Carmina-demo.json`, `Carmina-forge.json` — the two Carmina-style demo loops (D-minor chant, found orchestral sounds),
  written by `../GardenRhythm/tools/compose-carmina.py`.

## HOW A TUNE GETS INTO THE GAME — read before writing
Fortissimo plays ONLY its own files: `public/songs/*.json`, format `fortissimo-song` v1 (`src/game/roundfiles.js`), listed in
`public/songs/songs.json`. **The Hackbeat → Fortissimo importer was removed on 2026-10-07** ("off Hackbeat step 3", commit
c324dc7 in GardenRhythm; it exists in git history before that commit). So today there are two routes:
1. **The game's own song-maker** (title menu → Create): picks sounds from the game's banks (`public/banks/rome.json`) and saves
   straight into the game's format. No bridge needed. Fewer instruments than Hackbeat.
2. **Write here in Hackbeat, then bring the importer back as a tool** (`tools/import-hackbeat.py` or similar: Hackbeat project
   JSON → fortissimo-song, copying the samples it uses into `public/rounds/samples/`). Roughly a half-day's work; the old
   importer's shape is in history: `git -C ../GardenRhythm show c324dc7^:` and look for the importer/sync files.
   **Decide this at the start of the music session** — if he writes in Hackbeat, build the bridge first and run one
   round through it before he writes three.

## What a Fortissimo round is (so the tune fits the game)
- One round = ONE 4-bar loop (~150 notes); the game loops it and layers the build-up itself — write mood per round, not within.
- Three rounds per level: drums → guns (bass) → boss (treble), then round 4 (the Hydra) reuses the three songs as movements.
- Drums: ~70 notes across the six kit lanes (hat, snare, crash, kick, tom low, tom high).
  Guns: 30–60 notes per section; the gun keys map "the k-th letter of a row = the k-th gun built this round" (sparse lines pack
  onto the first keys). BPM is free; the three shipped rounds are in `garden-round*.json` for reference.
- Pitched samples: the game carries each sound's true recorded pitch and shifts from it. **Versilian file names are an octave
  low (a file named D2 sounds D3 — measured).**
- Samples ship as Opus (`tools/compress-samples.sh` in GardenRhythm): a WAV goes in, a 1/25-size .ogg comes out, the WAV kept as fallback.

## Bugs / features he may want on the fly (likely)
- The importer (above). - A "send to Fortissimo" button in Hackbeat that writes straight into `../GardenRhythm/public/songs/`.
- Any sound found here must be added to the game's credits (`../GardenRhythm/public/legal/credits.md`) with its licence.

## House rules that bite here
- Hackbeat is PUBLIC on GitHub (Tabulanis/Hackbeat): no house details, no private paths beyond this folder in commits.
- One heavy thing at a time on Void (CLAP search loads a model; don't run it alongside a render or a build).
- Saving a file the game has open reloads his page — warn first.
