#!/usr/bin/env python3
"""Hackbeat — tracker/timeline sample editor. FastAPI backend.

Serves the static frontend, the sample library, and project save/load.
The sound finder (library.py) finds real recordings by description: /api/library/*.
"""
import json
import re
import threading
import time
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
SAMPLES = ROOT / "samples"
PROJECTS = ROOT / "projects"
STATIC = ROOT / "static"
PORT = 8200
AUDIO_EXT = {".wav", ".mp3", ".ogg", ".flac", ".aiff", ".aif", ".m4a", ".webm"}

SAMPLES.mkdir(exist_ok=True)
PROJECTS.mkdir(exist_ok=True)

app = FastAPI(title="Hackbeat")


def safe_child(base: Path, rel: str) -> Path:
    """Resolve rel inside base, refusing path escapes."""
    p = (base / rel).resolve()
    base = base.resolve()
    if p != base and base not in p.parents:
        raise HTTPException(status_code=400, detail="Bad path")
    return p


@app.get("/api/samples")
def list_samples():
    items = []
    # the big sound-finder library (samples/library) stays out of the palette;
    # a found sound is copied into samples/found/ when you take it
    for p in sorted(q for q in SAMPLES.rglob("*") if "library" not in q.relative_to(SAMPLES).parts[:1]):
        if p.is_file() and p.suffix.lower() in AUDIO_EXT:
            rel = p.relative_to(SAMPLES).as_posix()
            folder = str(Path(rel).parent)
            items.append({
                "name": p.stem,
                "path": rel,
                "folder": "" if folder == "." else folder,
            })
    return {"samples": items}


@app.delete("/api/samples/{rel:path}")
def delete_sample(rel: str):
    p = safe_child(SAMPLES, rel)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Sample not found")
    p.unlink()
    return {"ok": True, "path": rel}


@app.get("/api/audio/{rel:path}")
def get_audio(rel: str):
    p = safe_child(SAMPLES, rel)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Sample not found")
    return FileResponse(p)


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), folder: str = "imported"):
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", file.filename or "sample.wav")
    if Path(name).suffix.lower() not in AUDIO_EXT:
        raise HTTPException(status_code=400, detail="Unsupported file type")
    dest_dir = safe_child(SAMPLES, folder) if folder else SAMPLES
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    dest.write_bytes(await file.read())
    return {"ok": True, "path": dest.relative_to(SAMPLES).as_posix()}


@app.post("/api/sample/save")
async def save_sample(request: Request, path: str, overwrite: int = 0):
    if not path.lower().endswith(".wav"):
        raise HTTPException(status_code=400, detail="Path must end in .wav")
    p = safe_child(SAMPLES, path)
    if p.exists() and not overwrite:
        raise HTTPException(status_code=409,
                            detail="File exists - pick another name or use Replace")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(body)
    return {"ok": True, "path": p.relative_to(SAMPLES).as_posix()}


@app.post("/api/sample/stretch")
async def stretch_sample(request: Request, rate: float = 1.0, semitones: float = 0.0):
    """Change speed and pitch independently: rate re-times without touching
    pitch, semitones re-pitches without touching duration/speed — the two
    are applied as separate phase-vocoder passes (librosa), not a naive
    resample (which would always change both together). Operates on
    whatever WAV bytes are posted and returns processed WAV bytes directly
    -- mirrors how Apply FX works client-side: edits the in-memory buffer,
    doesn't touch disk until the user explicitly Saves/Replaces.
    """
    if rate <= 0:
        raise HTTPException(status_code=400, detail="Rate must be positive")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    try:
        import io
        import soundfile as sf
        import librosa
        data, sr = sf.read(io.BytesIO(body), dtype="float32", always_2d=True)
        y = data.T  # soundfile gives (samples, channels); librosa wants (channels, samples)
        if rate != 1.0:
            y = librosa.effects.time_stretch(y, rate=rate)
        if semitones != 0.0:
            y = librosa.effects.pitch_shift(y, sr=sr, n_steps=semitones)
        out_buf = io.BytesIO()
        sf.write(out_buf, y.T, sr, format="WAV", subtype="FLOAT")
        return Response(content=out_buf.getvalue(), media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Speed/pitch processing failed: {str(e)[:300]}")


@app.get("/api/projects")
def list_projects():
    return {"projects": sorted(p.stem for p in PROJECTS.glob("*.json"))}


@app.get("/api/projects/{name}")
def load_project(name: str):
    p = safe_child(PROJECTS, name + ".json")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Project not found")
    return JSONResponse(json.loads(p.read_text()))


BACKUPS = PROJECTS / ".backups"
KEEP_BACKUPS = 4


def _backup_path(name: str, n: int) -> Path:
    return BACKUPS / f"{name}.{n}.json"


def _rotate_backups(name: str, current: Path) -> None:
    """Keep the last KEEP_BACKUPS versions: .1 = newest. The file about to be
    overwritten becomes .1; the oldest falls off the end."""
    if not current.is_file():
        return
    BACKUPS.mkdir(exist_ok=True)
    oldest = _backup_path(name, KEEP_BACKUPS)
    if oldest.exists():
        oldest.unlink()
    for n in range(KEEP_BACKUPS - 1, 0, -1):
        src = _backup_path(name, n)
        if src.exists():
            src.rename(_backup_path(name, n + 1))
    _backup_path(name, 1).write_bytes(current.read_bytes())


@app.post("/api/projects/{name}")
async def save_project(name: str, request: Request, autosave: int = 0):
    data = await request.json()
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip() or "untitled"
    path = PROJECTS / (name + ".json")
    # an autosave sends the song without its embedded samples (too heavy to
    # repeat on every edit): keep the ones already in the file
    if autosave and "sampleData" not in data and path.is_file():
        try:
            old = json.loads(path.read_text())
            if "sampleData" in old:
                data["sampleData"] = old["sampleData"]
        except (OSError, ValueError):
            pass
    _rotate_backups(name, path)
    path.write_text(json.dumps(data, indent=2))
    return {"ok": True, "name": name}


@app.get("/api/projects/{name}/backups")
def list_backups(name: str):
    out = []
    for n in range(1, KEEP_BACKUPS + 1):
        p = safe_child(BACKUPS, f"{name}.{n}.json") if BACKUPS.exists() else None
        if p and p.is_file():
            out.append({"n": n, "saved": p.stat().st_mtime})
    return {"backups": out}


@app.get("/api/projects/{name}/backups/{n}")
def load_backup(name: str, n: int):
    if not 1 <= n <= KEEP_BACKUPS:
        raise HTTPException(status_code=404, detail="No such backup")
    p = safe_child(BACKUPS, f"{name}.{n}.json")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="No such backup")
    return JSONResponse(json.loads(p.read_text()))


# ---------------------------------------------------------------- sound finder
# Real recorded samples found by describing them (see library.py). The model
# loads on the first search and unloads after 10 idle minutes.
import library

FOUND = SAMPLES / "found"


class FindRequest(BaseModel):
    q: str = ""
    n: int = 8
    audio_b64: Optional[str] = None   # "find sounds like this": a WAV


@app.get("/api/library/status")
def library_status():
    return library.status()


@app.post("/api/library/search")
def library_search(req: FindRequest):
    st = library.status()
    if not st["ready"]:
        raise HTTPException(status_code=503, detail="The sound library isn't indexed yet"
                            + (" (indexing now)" if st["building"] else ""))
    n = max(1, min(30, req.n))
    try:
        if req.audio_b64:
            import base64
            import io
            import librosa
            import soundfile as sf
            wav, sr = sf.read(io.BytesIO(base64.b64decode(req.audio_b64)), dtype="float32", always_2d=True)
            mono = wav.mean(axis=1)[: sr * int(library.CLIP_SECONDS)]
            if sr != library.SR:
                mono = librosa.resample(mono, orig_sr=sr, target_sr=library.SR)
            return {"results": library.similar(mono, n)}
        if not req.q.strip():
            raise HTTPException(status_code=400, detail="Describe the sound you want")
        return {"results": library.search(req.q.strip(), n)}
    except HTTPException:
        raise
    except ImportError as e:
        raise HTTPException(status_code=501, detail=f"Sound finder needs torch + transformers ({e})")


class TakeRequest(BaseModel):
    path: str


@app.post("/api/library/take")
def library_take(req: TakeRequest):
    """Copy a found library sound into samples/found/ so projects own it."""
    src = safe_child(SAMPLES, req.path)
    if not src.is_file() or "library" != Path(req.path).parts[0]:
        raise HTTPException(status_code=400, detail="Not a library sound")
    FOUND.mkdir(parents=True, exist_ok=True)
    parts = Path(req.path).parts
    # library-instrument-articulation-file, e.g. VSCO-2-CE-Cello-Section-spic-spic_A2_v2_RR1
    stem = re.sub(r"[^A-Za-z0-9#._-]+", "-", "-".join(parts[1:2] + parts[2:-1][-2:]) + "-" + src.stem).strip("-")[:110]
    dst = FOUND / (stem + src.suffix.lower())
    if not dst.exists():
        dst.write_bytes(src.read_bytes())
    return {"ok": True, "path": dst.relative_to(SAMPLES).as_posix(), "name": src.stem}


def _unload_idle_model():
    while True:
        time.sleep(60)
        library.unload_if_idle(600)


threading.Thread(target=_unload_idle_model, daemon=True).start()


@app.middleware("http")
async def _always_fresh(request: Request, call_next):
    # the app's own files: the browser must re-check every time (cheap, it's
    # local) so a reload always runs the current code, never a stale copy
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

if __name__ == "__main__":
    print(f"Hackbeat running at http://localhost:{PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
