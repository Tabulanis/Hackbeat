# Sound library credits

Find a Sound searches these free libraries (downloaded into `samples/library/`
by `samples/library/_dl/fetch.sh`; not part of this repo). Sounds you take are
copied into `samples/found/`, named after their library.

| Library | By | Licence | What it asks |
|---|---|---|---|
| VCSL — Versilian Community Sample Library | Versilian Studios | CC0 1.0 | nothing — public domain |
| VSCO-2 Community Edition | Versilian Studios | CC0 1.0 | nothing — public domain |
| NSynth (test + valid sets) | Google Magenta | CC BY 4.0 | **credit**, e.g. "Contains sounds from the NSynth dataset by Google Magenta, CC BY 4.0" |

If you ship anything containing a `samples/found/nsynth-*` sound, include the
NSynth credit line above.

The search model is CLAP, `laion/larger_clap_music_and_speech` (Apache-2.0).

## The demo song

The first-open demo (`static/demo/dope.json`, sounds in `samples/demo/`) uses
one NSynth sound (`nsynth-nsynth-valid-audio-brass_acoustic_015-054-100.wav`):
contains sounds from the NSynth dataset by Google Magenta, CC BY 4.0. Its
strumstick (VCSL) and cello (VSCO-2 CE) sounds are CC0; the drums and bars
are Garden Rhythm's own.
