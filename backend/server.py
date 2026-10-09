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


class SharedModels:
    """
    The models run ONE job at a time (the CPU is the bottleneck: two jobs at once would each run at half
    speed). The lock is held per FRAME, not per scan - while one class's scan waits for its camera's next
    frame, another class's frame is being recognised. Counts let the UI say "N other classes are being scanned".
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._count = threading.Lock()
        self.active_scans = 0
        self.waiting = 0     # scans currently waiting for the models

    def turn(self):
        return ScanTurn(self)

    def scan_started(self):
        with self._count:
            self.active_scans += 1

    def scan_finished(self):
        with self._count:
            self.active_scans -= 1


class ScanTurn:
    """One scan's handle on the shared lock: `with turn:` takes it, wait_ms adds up the time spent waiting."""

    def __init__(self, shared):
        self.shared = shared
        self.wait_ms = 0.0

    def __enter__(self):
        started = time.perf_counter()
        with self.shared._count:
            self.shared.waiting += 1
        self.shared._lock.acquire()
        with self.shared._count:
            self.shared.waiting -= 1
        self.wait_ms += (time.perf_counter() - started) * 1000
        return self

    def __exit__(self, *exc):
        self.shared._lock.release()
        return False


models = SharedModels()
# One open connection per live camera, shared by every scan of it; closed after sitting idle.
streams = recognize.StreamManager(
    idle_seconds=float(os.environ.get("CCTV_STREAM_IDLE_SEC", "600")),
    max_streams=int(os.environ.get("CCTV_MAX_STREAMS", "12")))


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
    streams.start_sweeper()
    print(f"Recognition service ready on http://127.0.0.1:{PORT}", flush=True)
    yield
    streams.stop_all()


app = FastAPI(title="CCTV recognition service", lifespan=lifespan)


class RunRequest(BaseModel):
    video: str                                    # file path or RTSP/HTTP URL
    roster: List[Dict[str, Any]]                  # [{student_id, name, gallery_folder}, ...]
    class_id: str                                 # keys the gallery cache (we use "<block>_<room>")
    annotated_out: Optional[str] = None           # where to save the annotated image
    options: Dict[str, Any] = Field(default_factory=dict)  # overrides for recognize.DEFAULT_SETTINGS


class StreamRequest(BaseModel):
    url: str                                      # rtsp:// address of one camera


def live_url_or_400(url):
    if not recognize.is_live_source(url):
        raise HTTPException(status_code=400, detail="url must start with rtsp:// or rtsps://")
    return url.strip()


@app.post("/stream/warm")
def stream_warm(request: StreamRequest):
    """Open (or keep open) the camera connection NOW, so a later /run does not pay for connecting."""
    stream = streams.get(live_url_or_400(request.url))
    return stream.status()


@app.post("/stream/release")
def stream_release(request: StreamRequest):
    return {"released": streams.release(live_url_or_400(request.url))}


@app.get("/stream/status")
def stream_status():
    return {"streams": streams.status()}


@app.get("/queue")
def queue():
    """How busy the service is - the page shows it while a scan runs."""
    return {"active_scans": models.active_scans, "waiting_for_models": models.waiting}


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

    # A live camera is connected BEFORE waiting for the lock, so connecting overlaps the queue.
    stream = None
    if recognize.is_live_source(request.video):
        stream = streams.get(request.video.strip())

    turn = models.turn()
    models.scan_started()
    try:
        log(f"[run] class {request.class_id}: {len(identity_map)} student(s) with photos; "
            f"{models.active_scans - 1} other scan(s) in progress")
        try:
            result = recognize.run_attendance(
                state["model"], request.video, identity_map, settings, GALLERY_DIR, request.class_id,
                annotated_out=request.annotated_out, memory_cache=gallery_memory_cache, log=log, stream=stream,
                infer_lock=turn)
        except recognize.CameraError as error:      # camera offline / wrong login / no frames
            raise HTTPException(status_code=502, detail=recognize.mask_url(error))
        except recognize.RecognitionError as error:
            raise HTTPException(status_code=400, detail=recognize.mask_url(error))
        except Exception as error:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=recognize.mask_url(f"{type(error).__name__}: {error}"))
    finally:
        models.scan_finished()

    result["queue_wait_ms"] = round(turn.wait_ms)   # total time this scan spent waiting for the models
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