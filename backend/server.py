#!/usr/bin/env python3
"""
server.py - keeps the face models loaded in memory so each attendance run starts immediately.

Before: every "Run attendance" click started a fresh Python process that re-imported the libraries,
re-loaded both models (a few hundred MB) and re-read the gallery. Now this service does all of
that ONCE at startup, keeps each room's gallery embeddings in memory, and just scans video when a
request arrives. cctv.routes.js starts it together with the Node server and talks to it over HTTP.

Setup:    pip install fastapi uvicorn      (plus everything recognize.py needs)
Run:      python server.py                 (normally you don't - the Node server starts it)

Settings (environment variables, all optional):
    CCTV_SERVICE_PORT      port to listen on, default 8765 (always bound to 127.0.0.1 - this service
                           opens any video path it is given, so it must not be reachable from outside)
    CCTV_REC_MODEL         recognizer file inside models/, default adaface_ir101_webface4m.onnx;
                           set it to the int8 file made by quantize_model.py to use that one
    CCTV_DET_SIZE          detector input size, default 1920x1080
    CCTV_DET_THRESH        detector confidence, default 0.3
    CCTV_MODELS_DIR / CCTV_GALLERY_DIR   override the models/ and gallery/ folders
    CCTV_EXIT_WITH_PARENT  set to 1 by Node: this service quits when the Node server stops

Endpoints:
    GET  /health   -> {"ok": true, ...} once the models are loaded
    POST /run      -> body {"video", "roster": [{student_id, name, gallery_folder}], "class_id",
                            "annotated_out"?, "options"?}; returns the same result as recognize.py
                      plus "log" (the progress lines) and "queue_wait_ms".
                      "options" can override any of recognize.DEFAULT_SETTINGS (threshold, ...).

Keep it to ONE worker process (don't use uvicorn --workers): the models and the gallery cache live
in this process's memory. Requests are handled one at a time - the CPU is already fully used by a
single scan, so two at once would just both run slower - later requests wait their turn.
"""
import os
import sys
import threading
import time
import traceback
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import recognize

MODELS_DIR = os.environ.get("CCTV_MODELS_DIR", str(recognize.HERE / "models"))
GALLERY_DIR = os.environ.get("CCTV_GALLERY_DIR", str(recognize.HERE / "gallery"))
REC_MODEL = os.environ.get("CCTV_REC_MODEL", recognize.DEFAULT_REC_FILENAME)
DET_SIZE = recognize.parse_det_size(os.environ.get("CCTV_DET_SIZE", "1920x1080"))
DET_THRESH = float(os.environ.get("CCTV_DET_THRESH", "0.3"))
PORT = int(os.environ.get("CCTV_SERVICE_PORT", "8765"))

state = {"model": None}      # filled in at startup
gallery_memory_cache = {}    # cache_key -> gallery embeddings kept in memory between requests
run_lock = threading.Lock()  # only one scan at a time


@asynccontextmanager
async def lifespan(app):
    """Runs once when the service starts: load the models and warm them up."""
    print("Loading models ...", flush=True)
    started = time.perf_counter()
    model = recognize.FaceModel(MODELS_DIR, DET_SIZE, DET_THRESH, REC_MODEL)
    print(f"  loaded in {time.perf_counter() - started:.1f}s: {model.describe()}", flush=True)

    started = time.perf_counter()
    try:
        model.warm_up()
        print(f"  warm-up run finished in {time.perf_counter() - started:.1f}s", flush=True)
    except Exception as error:  # a failed warm-up only means the first request is a bit slower
        print(f"  warm-up skipped: {error}", flush=True)

    state["model"] = model
    print(f"Recognition service ready on http://127.0.0.1:{PORT}", flush=True)
    yield


app = FastAPI(title="CCTV recognition service", lifespan=lifespan)


class RunRequest(BaseModel):
    video: str                                    # file path or RTSP/HTTP URL
    roster: List[Dict[str, Any]]                  # [{student_id, name, gallery_folder}, ...]
    class_id: str                                 # keys the gallery cache (we use "<block>_<room>")
    annotated_out: Optional[str] = None           # where to save the annotated image
    options: Dict[str, Any] = Field(default_factory=dict)  # overrides for recognize.DEFAULT_SETTINGS


@app.get("/health")
def health():
    model = state["model"]
    return {"ok": model is not None,
            "recognizer": model.rec_name if model else None,
            "batching": model.recognizer.supports_batch if model else None,
            "galleries_in_memory": len(gallery_memory_cache)}


# A plain `def` (not `async def`): FastAPI runs it in a worker thread, so a long scan does not
# freeze the service's ability to answer /health while it works.
@app.post("/run")
def run(request: RunRequest):
    try:
        settings = recognize.make_settings(**request.options)
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=400, detail=str(error))

    identity_map = recognize.build_identity_map(request.roster)
    if not identity_map:
        raise HTTPException(status_code=400, detail="roster has no student with a gallery_folder")

    log_lines = []

    def log(message):
        print(message, flush=True)   # shows up in the Node console
        log_lines.append(message)    # and is sent back to Node in the response

    queued_at = time.perf_counter()
    with run_lock:
        queue_wait_ms = (time.perf_counter() - queued_at) * 1000
        log(f"[run] class {request.class_id}: {len(identity_map)} student(s) with photos; "
            f"waited {queue_wait_ms:.0f} ms in the queue")
        try:
            result = recognize.run_attendance(
                state["model"], request.video, identity_map, settings, GALLERY_DIR, request.class_id,
                annotated_out=request.annotated_out, memory_cache=gallery_memory_cache, log=log)
        except recognize.RecognitionError as error:
            raise HTTPException(status_code=400, detail=str(error))
        except Exception as error:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}")

    result["queue_wait_ms"] = round(queue_wait_ms)
    result["log"] = log_lines
    return result


def exit_when_parent_goes_away():
    """Node keeps our stdin pipe open. When Node exits (even if it crashes) the pipe closes, the
    read below returns, and we shut down too - so no orphaned python.exe is left running."""
    sys.stdin.buffer.read()
    print("parent process is gone - shutting down", flush=True)
    os._exit(0)


if __name__ == "__main__":
    if os.environ.get("CCTV_EXIT_WITH_PARENT") == "1":
        threading.Thread(target=exit_when_parent_goes_away, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")