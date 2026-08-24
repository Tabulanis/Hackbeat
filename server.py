#!/usr/bin/env python3
"""Hackbeat — tracker/timeline sample editor. FastAPI backend.

Serves the static frontend, the sample library, and project save/load.
Phase 2 (AI sample generation) plugs into /api/generate.
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
    for p in sorted(SAMPLES.rglob("*")):
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


@app.post("/api/projects/{name}")
async def save_project(name: str, request: Request):
    data = await request.json()
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip() or "untitled"
    (PROJECTS / (name + ".json")).write_text(json.dumps(data, indent=2))
    return {"ok": True, "name": name}


# ---------------------------------------------------------------- AI generation
MELODY_MODEL = "facebook/musicgen-melody"
ALLOWED_MODELS = {"facebook/musicgen-small", "facebook/musicgen-medium", MELODY_MODEL}
GEN_LOCK = threading.Lock()
_gen = {"name": None, "model": None, "processor": None, "device": None}


class GenRequest(BaseModel):
    prompt: str
    duration: float = 4.0
    model: str = "facebook/musicgen-small"
    melody_b64: Optional[str] = None  # WAV bytes, base64 -> melody conditioning


def _load_gen_model(name):
    import torch
    from transformers import AutoProcessor
    if name == MELODY_MODEL:
        from transformers import MusicgenMelodyForConditionalGeneration as ModelCls
    else:
        from transformers import MusicgenForConditionalGeneration as ModelCls

    if _gen["name"] == name and _gen["model"] is not None:
        return
    # release the previous model before loading a new one
    _gen["model"] = None
    _gen["processor"] = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    processor = AutoProcessor.from_pretrained(name)
    model = ModelCls.from_pretrained(name, torch_dtype=dtype)
    model.to(device)
    model.eval()
    _gen.update(name=name, model=model, processor=processor, device=device)


@app.post("/api/generate")
def generate(req: GenRequest):
    try:
        import torch
        import soundfile as sf
    except ImportError as e:
        raise HTTPException(
            status_code=501,
            detail=f"AI dependencies not installed ({e}). Re-run the installer without --no-ai.",
        )
    prompt = req.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Empty prompt")
    if not GEN_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A generation is already running")
    try:
        name = req.model if req.model in ALLOWED_MODELS else "facebook/musicgen-small"
        dur = min(20.0, max(1.0, float(req.duration or 4.0)))

        melody = None
        if req.melody_b64:
            import base64
            import io
            import numpy as np
            try:
                raw = base64.b64decode(req.melody_b64)
                wav, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
            except Exception:
                raise HTTPException(status_code=400, detail="Could not decode melody audio")
            mono = wav.mean(axis=1)
            target = 32000  # musicgen sampling rate
            if sr != target and len(mono) > 1:
                n = max(1, int(len(mono) * target / sr))
                mono = np.interp(
                    np.linspace(0, len(mono) - 1, n),
                    np.arange(len(mono)), mono,
                ).astype("float32")
            melody = mono[: target * 20]  # cap conditioning at 20s
            name = MELODY_MODEL  # melody conditioning requires the melody model

        _load_gen_model(name)
        model, processor, device = _gen["model"], _gen["processor"], _gen["device"]

        if melody is not None:
            feats = processor(audio=melody, sampling_rate=32000,
                              text=[prompt], padding=True, return_tensors="pt")
        else:
            feats = processor(text=[prompt], padding=True, return_tensors="pt")
        inputs = {}
        for k, v in feats.items():
            v = v.to(device)
            if device == "cuda" and v.dtype == torch.float32:
                v = v.half()  # match the fp16 model
            inputs[k] = v
        max_new_tokens = min(1024, int(dur * 50) + 4)  # MusicGen: ~50 tokens/sec
        with torch.inference_mode():
            audio = model.generate(
                **inputs,
                do_sample=True,
                guidance_scale=3.0,
                max_new_tokens=max_new_tokens,
            )
        rate = model.config.audio_encoder.sampling_rate
        data = audio[0].cpu().float().numpy().T  # (frames, channels)

        out_dir = SAMPLES / "generated"
        out_dir.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")[:40] or "sample"
        fname = f"{slug}-{int(time.time())}.wav"
        sf.write(out_dir / fname, data, rate)
        return {"ok": True, "path": f"generated/{fname}", "name": Path(fname).stem}
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e)
        if "out of memory" in msg.lower():
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                pass
            raise HTTPException(
                status_code=507,
                detail="CUDA out of memory - free VRAM (e.g. docker stop wm-llama) "
                       "and retry, or switch to musicgen-small.",
            )
        raise HTTPException(status_code=500, detail=f"Generation failed: {msg[:300]}")
    finally:
        GEN_LOCK.release()


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

if __name__ == "__main__":
    print(f"Hackbeat running at http://localhost:{PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
