"""The sound finder: real recorded samples, found by describing them.

Instead of an AI *making* a sound (which wanders off into loops), an AI
*finds* one: every sample in the library is listened to once by CLAP
(laion/larger_clap_music_and_speech, Apache-2.0), which places sounds and
words in the same space. A search is then words -> the nearest recordings.
"Find sounds like this" does the same from a recording instead of words.

Libraries (samples/library/, not in git — fetched by samples/library/_dl/fetch.sh):
  VCSL        Versilian Community Sample Library   CC0
  VSCO-2-CE   Versilian Studios Chamber Orchestra   CC0
  nsynth      Google Magenta NSynth (test + valid)  CC BY 4.0 — needs credit,
                                                    see LIBRARY-CREDITS.md

Index: samples/library/_index/{emb.npy, meta.json}, built by
  venv/bin/python library.py build      (resumable; run it niced, it's CPU-heavy)
"""
import json
import re
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SAMPLES = ROOT / "samples"
LIB = SAMPLES / "library"
INDEX = LIB / "_index"
MODEL = "laion/larger_clap_music_and_speech"
SR = 48000          # CLAP listens at 48 kHz
CLIP_SECONDS = 7.0  # enough of any one-shot / note
AUDIO_EXT = {".wav", ".flac", ".ogg", ".aif", ".aiff", ".mp3"}
SOURCES = {
    "VCSL": "VCSL (CC0)",
    "VSCO-2-CE": "VSCO-2 CE (CC0)",
    "nsynth": "NSynth (CC BY 4.0 - credit Google Magenta)",
}
NOTE_RE = re.compile(r"(?<![A-Za-z])([A-G])(#|b|s|sharp)?(-?\d)(?![\d])")
PCS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_from_name(stem, middle_c_octave=4):
    """MIDI note from a file name like 'Cello_A#3_mf', else None.
    middle_c_octave: the octave number the library calls middle C (MIDI 60).
    Versilian (VCSL, VSCO-2) names it C3 — measured 2026-10-02: files named
    C4 / E4 / D4 / D#2 sound at C5 / E5 / D5 / D#3 (pyin, 4 instruments)."""
    m = None
    for m in NOTE_RE.finditer(stem.replace("_", " ").replace("-", " - ")):
        pass   # the LAST note-looking token is usually the pitch
    if not m:
        return None
    pc = PCS[m.group(1)] + (1 if m.group(2) in ("#", "s", "sharp") else -1 if m.group(2) == "b" else 0)
    midi = 12 * (int(m.group(3)) + 5 - middle_c_octave) + pc
    return midi if 12 <= midi <= 120 else None


def words(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).split()


# ------------------------------------------------------------------ catalog
def catalog():
    """Every library sample: {path (under samples/), name, source, pitch, group, text}."""
    items = []
    for src in ("VCSL", "VSCO-2-CE"):
        base = LIB / src
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if p.suffix.lower() not in AUDIO_EXT or p.name.startswith("."):
                continue
            rel = p.relative_to(base)
            folders = " ".join(rel.parts[:-1])
            items.append({
                "path": str(p.relative_to(SAMPLES)),
                "name": (rel.parts[-2] + " - " if len(rel.parts) > 1 else "") + p.stem,
                "source": src,
                "pitch": note_from_name(p.stem, middle_c_octave=3),   # Versilian: C3 = middle C
                "group": src + "/" + str(rel.parent),
                "text": " ".join(words(folders + " " + p.stem)),
            })
    for split in ("nsynth-test", "nsynth-valid"):
        meta = LIB / "nsynth" / split / "examples.json"
        if not meta.is_file():
            continue
        for key, e in sorted(json.loads(meta.read_text()).items()):
            if e.get("velocity") != 100:      # one velocity per note is plenty
                continue
            fam, srcs = e["instrument_family_str"], e["instrument_source_str"]
            qual = " ".join(q.replace("_", " ") for q in e.get("qualities_str", []))
            p = e["pitch"]
            items.append({
                "path": f"library/nsynth/{split}/audio/{key}.wav",
                "name": f"{fam} ({srcs}) {e['instrument_str'].split('_')[-1]} {NAMES[p % 12]}{p // 12 - 1}",
                "source": "nsynth",
                "pitch": p,
                "group": "nsynth/" + e["instrument_str"],
                "text": f"{fam} {srcs} {qual}",
            })
    return items


# ------------------------------------------------------------------ model
_model = {"m": None, "proc": None, "last": 0.0}
_lock = threading.Lock()


def _load():
    if _model["m"] is None:
        import torch
        from transformers import ClapModel, ClapProcessor
        torch.set_num_threads(8)
        _model["proc"] = ClapProcessor.from_pretrained(MODEL)
        _model["m"] = ClapModel.from_pretrained(MODEL).eval()
    _model["last"] = time.time()
    return _model["m"], _model["proc"]


def unload_if_idle(seconds=600):
    """The house runs out of RAM first: drop the model when nobody's searching."""
    with _lock:
        if _model["m"] is not None and time.time() - _model["last"] > seconds:
            _model["m"] = _model["proc"] = None
            import gc
            gc.collect()


def _norm(x):
    import numpy as np
    x = np.asarray(x, dtype="float32")
    return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-9)


def _tensor(out):
    # transformers returns a tensor, or (newer) an output object holding it
    return getattr(out, "pooler_output", out)


def embed_text(texts):
    import torch
    m, proc = _load()
    with torch.inference_mode():
        inp = proc(text=texts, return_tensors="pt", padding=True)
        return _norm(_tensor(m.get_text_features(**inp)).numpy())


def embed_audio(waves):
    """waves: list of mono float32 arrays at 48 kHz."""
    import torch
    m, proc = _load()
    with torch.inference_mode():
        inp = proc(audio=waves, sampling_rate=SR, return_tensors="pt")
        return _norm(_tensor(m.get_audio_features(**inp)).numpy())


def load_wave(path):
    import librosa
    y, _ = librosa.load(str(path), sr=SR, mono=True, duration=CLIP_SECONDS)
    return y.astype("float32")


# ------------------------------------------------------------------ search
_index = {"emb": None, "meta": None, "mtime": 0}


def _get_index():
    import numpy as np
    f = INDEX / "emb.npy"
    if not f.is_file():
        return None, None
    mt = f.stat().st_mtime
    if _index["emb"] is None or mt != _index["mtime"]:
        _index["emb"] = np.load(f).astype("float32")
        _index["meta"] = json.loads((INDEX / "meta.json").read_text())
        _index["mtime"] = mt
        _index["hay"] = None
    return _index["emb"], _index["meta"]


def status():
    emb, meta = _get_index()
    have = {s: (LIB / s).is_dir() for s in SOURCES}
    building = (INDEX / "building").exists()
    counts = {}
    for m in meta or []:
        counts[m["source"]] = counts.get(m["source"], 0) + 1
    return {"ready": emb is not None, "count": len(meta or []), "by_source": counts,
            "libraries": have, "building": building}


# a query word naming an instrument counts for a lot: CLAP alone is fuzzy on
# names (2026-10-02: "warm cello" -> harps, "deep kick" -> synth basses), while
# the files' own names say exactly what they are. Words here are what the
# libraries call things.
SYNONYMS = {
    "kick": ["kick", "bdrum", "bass drum"], "bassdrum": ["bdrum", "bass drum"],
    "hihat": ["hihat", "hi hat"], "hat": ["hihat", "hi hat"], "hats": ["hihat", "hi hat"],
    "snare": ["snare"], "cymbal": ["cymbal", "crash", "ride"], "crash": ["crash", "cymbal"],
    "tom": ["tom"], "toms": ["tom"], "clap": ["clap"],
    "bell": ["bell", "glock", "chime", "tubular"], "bells": ["bell", "glock", "chime", "tubular"],
    "horn": ["horn", "brass"], "horns": ["horn", "brass"], "brass": ["brass", "trumpet", "trombone", "horn", "tuba"],
    "strings": ["violin", "viola", "cello", "string"], "string": ["violin", "viola", "cello", "string"],
    "xylophone": ["xylo"], "xylo": ["xylo"], "vibraphone": ["vibes", "vibraphone"], "vibes": ["vibes"],
    "piano": ["piano"], "organ": ["organ"], "guitar": ["guitar"], "flute": ["flute"], "harp": ["harp"],
    "marimba": ["marimba"], "glockenspiel": ["glock"], "sax": ["sax"], "saxophone": ["sax"],
}
STOP = {"note", "notes", "sound", "sounds", "sample", "one", "shot", "the", "and", "with", "like", "very",
        "warm", "deep", "dry", "tight", "soft", "hard", "bright", "dark", "big", "small", "short", "long"}
NAME_BONUS, NAME_CAP = 0.15, 0.3


def _name_bonus(meta, query_words):
    import numpy as np
    terms = [SYNONYMS.get(w, [w]) for w in query_words if w not in STOP]
    if not terms:
        return 0
    if _index.get("hay") is None:
        _index["hay"] = [" " + " ".join(words(m["text"] + " " + m["name"])) + " " for m in meta]
    hay = _index["hay"]
    bonus = np.zeros(len(meta), dtype="float32")
    for alts in terms:
        hit = np.array([any((" " + a) in h for a in alts) for h in hay], dtype="float32")   # starts a word: "tom" not in "bottom"
        bonus += NAME_BONUS * hit
    return np.minimum(bonus, NAME_CAP)


def _rank(q, query_words, n):
    """q: query embedding. Best match per instrument group; within a group the
    one nearest middle C (so it needs the least re-pitching) among near-ties."""
    import numpy as np
    emb, meta = _get_index()
    if emb is None:
        return []
    score = emb @ q
    if query_words:
        score = score + _name_bonus(meta, query_words)
    order = np.argsort(-score)[: max(400, n * 40)]
    best = {}
    for i in order:
        m = meta[i]
        g = best.get(m["group"])
        s = float(score[i])
        if g is None:
            best[m["group"]] = [s, i, s]
        elif s >= g[2] - 0.02:   # a near-tie: prefer the pitch nearest C4
            pi = m["pitch"] if m["pitch"] is not None else 60
            pg = meta[g[1]]["pitch"] if meta[g[1]]["pitch"] is not None else 60
            if abs(pi - 60) < abs(pg - 60):
                g[0], g[1] = s, i
    out, kept = [], []
    for top, i, _ in sorted(best.values(), key=lambda g: -g[2]):
        # the same recording ships in both Versilian libraries: skip near-identical sounds
        if any(float(emb[i] @ emb[k]) > 0.995 for k in kept):
            continue
        kept.append(i)
        m = meta[i]
        out.append({"path": m["path"], "name": display_name(m), "source": SOURCES[m["source"]],
                    "pitch": m["pitch"], "score": round(top, 3)})
        if len(out) >= n:
            break
    return out


def display_name(m):
    """'Cello Section · spic · spic_A2_v2_RR1' — the instrument folder says what it is."""
    if m["source"] == "nsynth":
        return m["name"]
    parts = Path(m["path"]).parts[2:]           # under library/<source>/
    return " · ".join(list(parts[:-1])[-3:] + [Path(parts[-1]).stem])


def search(text, n=8):
    with _lock:
        q = embed_text([text])[0]
        return _rank(q, [w for w in words(text) if len(w) > 2 or w in SYNONYMS], n)


def similar(wave, n=8):
    with _lock:
        q = embed_audio([wave])[0]
        return _rank(q, [], n)


# ------------------------------------------------------------------ build
def build(batch=16):
    """Listen to every library sample once. Resumable: keeps what's done."""
    import numpy as np
    INDEX.mkdir(parents=True, exist_ok=True)
    flag = INDEX / "building"
    flag.write_text(str(time.time()))
    try:
        items = catalog()
        done_meta, done_emb = [], None
        part_m, part_e = INDEX / "part-meta.json", INDEX / "part-emb.npy"
        if part_m.is_file() and part_e.is_file():
            done_meta = json.loads(part_m.read_text())
            done_emb = np.load(part_e)
        have = {m["path"] for m in done_meta}
        todo = [it for it in items if it["path"] not in have]
        print(f"{len(items)} samples, {len(have)} already done, {len(todo)} to listen to", flush=True)
        embs = [done_emb] if done_emb is not None and len(done_emb) else []
        metas = list(done_meta)
        t0 = time.time()
        for k in range(0, len(todo), batch):
            chunk, waves, keep = todo[k:k + batch], [], []
            for it in chunk:
                try:
                    w = load_wave(SAMPLES / it["path"])
                    if len(w) < SR * 0.02 or not np.isfinite(w).all():
                        continue
                    waves.append(w)
                    keep.append(it)
                except Exception as e:
                    print("  skip", it["path"], e, flush=True)
            if waves:
                embs.append(embed_audio(waves).astype("float16"))
                metas.extend(keep)
            if (k // batch) % 30 == 0 or k + batch >= len(todo):
                np.save(part_e, np.concatenate(embs) if embs else np.zeros((0, 512), "float16"))
                part_m.write_text(json.dumps(metas))
                rate = (k + len(chunk)) / max(1e-6, time.time() - t0)
                print(f"  {len(metas)}/{len(items)}  ({rate:.1f}/s)", flush=True)
        np.save(INDEX / "emb.npy", np.concatenate(embs))
        (INDEX / "meta.json").write_text(json.dumps(metas))
        print("INDEX DONE", len(metas), flush=True)
    finally:
        flag.unlink(missing_ok=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["build"]:
        build()
    elif sys.argv[1:2] == ["search"]:
        for r in search(" ".join(sys.argv[2:])):
            print(r)
    elif sys.argv[1:] == ["catalog"]:
        c = catalog()
        print(len(c), "samples;", sum(1 for i in c if i["pitch"] is not None), "with a known pitch")
        for i in c[:: max(1, len(c) // 12)]:
            print(" ", i)
    else:
        print(__doc__)
