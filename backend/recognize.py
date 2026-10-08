#!/usr/bin/env python3
"""
recognize.py - CCTV classroom attendance: given a video clip (or live stream), detect faces,
track them across frames, and recognize each track (AdaFace ir101) only as often as needed.

Setup:    pip install insightface onnxruntime opencv-python numpy gdown uvicorn

Usage:
    python recognize.py --video clip.mp4
    python recognize.py --video clip.mp4 --students-json roster.json --json-out result.json --class-id 12
    python recognize.py --video clip.mp4 --verbose          # one log line per processed frame

This file is also the engine behind server.py (the long-lived service the Node backend talks to):
server.py loads the models ONCE and calls run_attendance() below for every request.

Folders (all next to this script, override with the matching flag):
    models/    det_10g.onnx (SCRFD detector) and adaface_ir101_webface4m.onnx (recognizer) -
               downloaded automatically on first run from MODEL_URLS below. An int8 version of
               the recognizer can be made with quantize_model.py and chosen with --rec-model.
    gallery/   one sub-folder per student, e.g. gallery/yash/front.jpg, gallery/yash/left.jpg
    cache/     saved gallery embeddings per class, so they are not recomputed on every run

How a track gets marked present
--------------------------------
Detection runs every sampled frame (cheap); recognition (AdaFace) is the expensive step and is
only run on a track that is not yet resolved, up to --max-attempts times, and only on frames that
pass two free pre-checks first (big enough, not blurry). All the faces of one frame that need
recognition are sent to AdaFace together in ONE batched call (faster than one call per face).
AdaFace's own feature norm (a free by-product of every recognition call - see
https://arxiv.org/abs/2204.00964) is used as a second, post-hoc quality check: a low-norm result
still counts against --max-attempts (the compute was spent) but is not trusted as a match. A track
keeps trying on later frames until it matches, or runs out of attempts and is then marked
"unmatched" for the rest of the clip.

--max-attempts bounds the cost of ONE face, not the length of the scan: a classroom almost always
has absentees, so waiting for "everyone present" to stop is not a real exit condition. Two things
end the scan instead:
  * --duration: the scan budget, in seconds of VIDEO time (default 5). 0 means "no limit" (until
    the file ends) - never use 0 on a live/RTSP stream, which does not end on its own.
  * early exit: as soon as every face currently visible (and seen on 3+ sampled frames) is
    resolved - matched, or out of attempts - there is nothing left to learn, so the scan stops.
    The catch: a student who only appears after that point is not scanned for. Turn it off with
    --no-early-exit if you want the full --duration every time.

Attendance is kept by STUDENT IDENTITY, not by track ID: if a track is lost and the same student
is re-detected later as a new track, they simply get recognized again under their existing
record - nothing needs to link the two track IDs together. This is also why the tracker in
tracker.py is deliberately simple (see that file's docstring): track continuity here is a
compute-saving device, not something correctness depends on.

Gallery is scoped to the class: with --students-json (and ideally --class-id), only the gallery
folders belonging to that roster are embedded and searched. This matters for correctness, not
just speed - matching against the whole school's gallery means an unrelated student's face can
win the nearest-match search over the correct (but slightly lower-scoring) class student, silently
losing a real match.

Timing log
-----------
Every run measures how long each step took (decoding, detection, recognition, ...) and prints a
table at the end, also saved under "timings" in the result JSON. Add --verbose for a line per frame.

Node.js integration
--------------------
--students-json points at a roster file the backend writes: a JSON list of
{"student_id", "gallery_folder", "name"}. Each student is matched to gallery/<gallery_folder>/.
--class-id keys the embeddings cache so different classes never share (or fight over) one cache
file. --json-out is where the result is written: {"present_students": [...], "absent_students":
[...], "annotated_image": "<path, if --annotated-out was used>", "timings": {...}}.
(The Node backend now goes through server.py instead and sends the roster in the request.)
"""
import argparse
import hashlib
import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import onnxruntime

try:
    from insightface.app.common import Face
    from insightface.model_zoo import model_zoo
    from insightface.utils import face_align
except ImportError:
    sys.exit("InsightFace is missing. Run: pip install insightface onnxruntime opencv-python numpy")

from tracker import Tracker, iou

# ------------------------------------------------------------------ settings
HERE = Path(__file__).resolve().parent
IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
GALLERY_DET_SIZE = (640, 640)
DEFAULT_REC_FILENAME = "adaface_ir101_webface4m.onnx"
RECOGNIZE_BATCH_SIZE = 16  # most faces sent to AdaFace in one model call (keeps memory use modest)
MODEL_URLS = {
    "det_10g.onnx": "https://drive.google.com/file/d/1Y10_5Eb8lk8wfMOv9AZIjQb_qqyVpkry/view?usp=sharing",
    DEFAULT_REC_FILENAME: "https://drive.google.com/file/d/1xKznKlLYCeCrmR_Vpfn-GDqYRCebFjLz/view?usp=sharing",
}

# Every per-run setting and its default, in ONE place. The command line (parse_args) and the
# server (the "options" in a request) both read from here, so the two can never disagree.
DEFAULT_SETTINGS = {
    "threshold": 0.26,      # similarity needed for ONE recognition attempt to count as a match
    "max_attempts": 5,      # recognition attempts allowed per track before giving up on it
    "every": 18,            # process every Nth frame
    "duration": 5.0,        # seconds of video to scan; 0 = no limit
    "min_face": 0,          # skip faces shorter than this (px) - free, no attempt spent
    "min_sharpness": 0.0,   # skip blurry crops below this Laplacian variance - free
    "min_norm": 0.0,        # distrust an attempt whose AdaFace quality score is below this
    "start": 0.0,           # seconds into the clip to start at
    "early_exit": True,     # stop once every visible face is resolved
    "verbose": False,       # log one line per processed frame
}


def make_settings(**overrides):
    """DEFAULT_SETTINGS with some values replaced, as an object you read like args.threshold."""
    unknown = set(overrides) - set(DEFAULT_SETTINGS)
    if unknown:
        raise ValueError(f"unknown setting(s): {', '.join(sorted(unknown))}")
    return SimpleNamespace(**{**DEFAULT_SETTINGS, **overrides})


class RecognitionError(Exception):
    """A problem the caller should report (no gallery, video will not open) - not a crash."""


# ------------------------------------------------------------- timing log
class Timings:
    """Adds up how long each named step takes, so we can see where the time goes."""

    def __init__(self):
        self.total_ms = {}   # step name -> milliseconds spent in total
        self.calls = {}      # step name -> how many times the step ran

    def add(self, step, milliseconds):
        self.total_ms[step] = self.total_ms.get(step, 0.0) + milliseconds
        self.calls[step] = self.calls.get(step, 0) + 1

    @contextmanager
    def measure(self, step):
        """Use as:  with timings.measure("some step"):  ...code to time...  """
        started = time.perf_counter()
        try:
            yield
        finally:
            self.add(step, (time.perf_counter() - started) * 1000)

    def as_dict(self):
        return {step: {"calls": self.calls[step], "total_ms": round(ms, 1),
                       "avg_ms": round(ms / self.calls[step], 2)}
                for step, ms in self.total_ms.items()}

    def report_lines(self, run_ms):
        """A readable table, slowest step first. Time not inside any measured step shows as '(not timed)'."""
        run_ms = max(run_ms, 1e-9)
        lines = [f"  {'step':<34}{'calls':>6}{'total ms':>10}{'avg ms':>9}{'% of run':>9}"]
        rows = sorted(self.total_ms.items(), key=lambda item: item[1], reverse=True)
        for step, spent in rows:
            calls = self.calls[step]
            lines.append(f"  {step:<34}{calls:>6}{spent:>10.0f}{spent / calls:>9.1f}{100 * spent / run_ms:>8.0f}%")
        other = run_ms - sum(self.total_ms.values())
        lines.append(f"  {'(not timed)':<34}{'':>6}{other:>10.0f}{'':>9}{100 * other / run_ms:>8.0f}%")
        return lines


# ------------------------------------------------------------ small helpers
def load_image(path):
    """Read an image file (also works when the path has non-English characters)."""
    image = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Cannot read image: {path}")
    return image


def save_image(path, image):
    """Save an image as .jpg (also works when the path has non-English characters)."""
    _, encoded = cv2.imencode(".jpg", image)
    encoded.tofile(str(path))


def parse_det_size(text):
    """'1280x736' -> (1280, 736); '640' -> (640, 640). The detector needs multiples of 32, so we round up."""
    parts = text.lower().split("x")
    width, height = int(parts[0]), int(parts[-1])  # a single number means a square size
    return (width + 31) // 32 * 32, (height + 31) // 32 * 32


def face_size(face):
    """Width and height of a detected face box, in pixels."""
    x1, y1, x2, y2 = face.bbox
    return x2 - x1, y2 - y1


def download_if_missing(path, url):
    """Fetch a model file once (Google Drive link or any direct URL); no-op if already on disk."""
    path = Path(path)
    if path.exists():
        return path
    if not url:
        sys.exit(f"{path.name} is missing and no download URL is set - fill in MODEL_URLS in "
                 f"this script, or place the file at {path} by hand (an int8 model is made by "
                 f"running quantize_model.py).")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import gdown
    except ImportError:
        sys.exit("Model download needs gdown. Run: pip install gdown")
    print(f"  downloading {path.name} ...")
    gdown.download(url=url, output=str(path), quiet=False)
    if not path.exists():
        sys.exit(f"Could not download {path.name} from {url} - download it by hand and save it as {path}")
    return path


# -------------------------------------------------------------------- model
class AdaFaceRecognizer:
    """
    Wraps the AdaFace .onnx model so it can be used like an InsightFace recognizer: calling
    .get(image, face) (one face) or .get_batch(image, faces) (many faces, one model call) fills
    in face.embedding AND face.quality (AdaFace's own quality score for that crop - see the
    module docstring).
    """

    def __init__(self, onnx_path):
        self.align = face_align.norm_crop  # the same 112x112 face alignment InsightFace's own recognizers use
        self.model_file = str(onnx_path)
        self.session = onnxruntime.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        model_input = self.session.get_inputs()[0]
        self.input_name = model_input.name
        self.output_names = [output.name for output in self.session.get_outputs()]
        if len(self.output_names) < 2:
            sys.exit(f"{Path(onnx_path).name} only has one output - this script needs the (embedding, quality_norm) "
                     f"export. Re-export with two outputs.")
        # The first number of the input shape is the batch size. A fixed number (usually 1) means
        # the model was exported for ONE face per call; a name like "batch" means any number works.
        batch_dim = model_input.shape[0]
        self.supports_batch = not (isinstance(batch_dim, int) and batch_dim > 0)

    def preprocess(self, image, face):
        """Align one face to 112x112 and turn it into the 1x3x112x112 number array AdaFace expects."""
        aligned = self.align(image, landmark=face.kps, image_size=112)
        # AdaFace expects BGR pixels scaled to roughly [-1, 1]; cv2 images are already BGR
        pixels = (aligned.astype(np.float32) / 255.0 - 0.5) / 0.5
        return np.ascontiguousarray(pixels.transpose(2, 0, 1)[np.newaxis])  # HxWxC -> 1xCxHxW

    def get_batch(self, image, faces, timings=None):
        """Align all the faces, run AdaFace on them in as few model calls as possible, and store
        the embedding + quality on each face."""
        if not faces:
            return
        timings = timings or Timings()
        with timings.measure("recognize: align + preprocess"):
            tensors = [self.preprocess(image, face) for face in faces]

        # A batch-capable model takes up to RECOGNIZE_BATCH_SIZE faces per call; otherwise 1 per call
        chunk_size = RECOGNIZE_BATCH_SIZE if self.supports_batch else 1
        for start in range(0, len(faces), chunk_size):
            chunk_faces = faces[start:start + chunk_size]
            batch = np.concatenate(tensors[start:start + chunk_size])  # shape: (faces in chunk, 3, 112, 112)
            with timings.measure("recognize: model inference"):
                embeddings, norms = self.session.run(self.output_names, {self.input_name: batch})
            norms = np.asarray(norms).reshape(-1)  # one quality number per face
            for face, embedding, norm in zip(chunk_faces, embeddings, norms):
                face.embedding = embedding  # face.normed_embedding is computed from this automatically
                face.quality = float(norm)

    def get(self, image, face):
        """Single-face version of get_batch (used for gallery photos)."""
        self.get_batch(image, [face])


class FaceModel:
    """Detector (SCRFD det_10g) + recognizer (AdaFace ir101), both loaded straight from local .onnx
    files."""

    def __init__(self, models_dir, det_size, det_thresh, rec_filename=DEFAULT_REC_FILENAME):
        models_dir = Path(models_dir)
        det_path = download_if_missing(models_dir / "det_10g.onnx", MODEL_URLS["det_10g.onnx"])
        rec_path = download_if_missing(models_dir / rec_filename, MODEL_URLS.get(rec_filename))

        self.det_size = det_size
        self.detector = model_zoo.get_model(str(det_path), providers=["CPUExecutionProvider"])
        self.detector.prepare(ctx_id=-1, input_size=det_size, det_thresh=det_thresh)  # ctx_id=-1 = CPU
        self.recognizer = AdaFaceRecognizer(rec_path)

        self.det_name, self.rec_name = det_path.stem, rec_path.stem
        self.model_mb = (det_path.stat().st_size + rec_path.stat().st_size) / 1e6

    def describe(self):
        """One line for the startup log."""
        batching = "on" if self.recognizer.supports_batch else "OFF (model has a fixed batch size of 1)"
        return (f"detector {self.det_name} @ {self.det_size[0]}x{self.det_size[1]}, "
                f"recognizer {self.rec_name}, batching {batching}, {self.model_mb:.0f} MB of models")

    def warm_up(self):
        """Run each model once on blank data. The very first ONNX call is slower (memory is set up
        lazily), so do it at startup instead of during the first real request."""
        self.detect(np.zeros((self.det_size[1], self.det_size[0], 3), dtype=np.uint8))
        blank_face = np.zeros((1, 3, 112, 112), dtype=np.float32)
        self.recognizer.session.run(self.recognizer.output_names, {self.recognizer.input_name: blank_face})

    def detect(self, image, det_size=None):
        """Find faces only - no recognition yet, and much cheaper than recognizing every one of them."""
        start = time.perf_counter()
        boxes, landmarks = self.detector.detect(image, input_size=det_size or self.det_size,
                                                max_num=0, metric="default")
        faces = [Face(bbox=boxes[i, :4], kps=landmarks[i], det_score=boxes[i, 4]) for i in range(len(boxes))]
        return faces, (time.perf_counter() - start) * 1000

    def recognize_batch(self, image, faces, timings=None):
        """Compute embedding + quality for several faces at once. The expensive step - call selectively."""
        self.recognizer.get_batch(image, faces, timings)

    def find_faces(self, image, det_size=None):
        """Detect AND recognize every face in one call - used only for gallery photos."""
        faces, detect_ms = self.detect(image, det_size)
        start = time.perf_counter()
        for face in faces:
            self.recognizer.get(image, face)
        return faces, detect_ms, (time.perf_counter() - start) * 1000


# ------------------------------------------------------------------ gallery
def build_gallery(model, gallery_dir, cache_key, only_folders=None, memory_cache=None, log=print):
    """
    Return (embeddings, names) with one row per gallery photo, scoped to `only_folders` when given
    (the current class's roster) so a different class's students can never win the nearest-match
    search. Cached per `cache_key` (use the class id) so classes never share or invalidate each
    other's cache.

    Three levels, fastest first: `memory_cache` (a dict the long-lived server keeps between
    requests), then the .npz file in cache/, then computing from the photos. The fingerprint
    includes the recognizer model's name, so switching models (e.g. fp32 -> int8) rebuilds the
    embeddings instead of silently mixing two models' numbers.
    """
    gallery_dir = Path(gallery_dir)
    student_dirs = sorted(d for d in gallery_dir.iterdir() if d.is_dir()) if gallery_dir.is_dir() else []
    if only_folders is not None:
        student_dirs = [d for d in student_dirs if d.name in only_folders]
    photos = [(d.name, p) for d in student_dirs for p in sorted(d.iterdir()) if p.suffix.lower() in IMAGE_TYPES]
    if not photos:
        return None, None

    # A "fingerprint" of the gallery (model, names, sizes, dates) tells us if the cache is still valid
    fingerprint = str([model.rec_name] + [(name, p.name, p.stat().st_size, int(p.stat().st_mtime)) for name, p in photos])

    if memory_cache is not None:
        remembered = memory_cache.get(cache_key)
        if remembered and remembered["fingerprint"] == fingerprint:
            log(f"  gallery: {len(remembered['names'])} embeddings already in memory ({cache_key})")
            return remembered["embeddings"], remembered["names"]

    def remember(embeddings, names):
        if memory_cache is not None:
            memory_cache[cache_key] = {"fingerprint": fingerprint, "embeddings": embeddings, "names": names}

    cache_file = HERE / "cache" / f"gallery_{cache_key}.npz"
    if cache_file.exists():
        saved = np.load(cache_file)
        if str(saved["fingerprint"]) == fingerprint:
            log(f"  gallery: loaded {len(saved['names'])} embeddings from cache file ({cache_key})")
            embeddings, names = saved["embeddings"], list(saved["names"])
            remember(embeddings, names)
            return embeddings, names

    log(f"  gallery: computing embeddings for {len(student_dirs)} student(s) ({cache_key}) ...")
    embeddings, names = [], []
    for name, photo in photos:
        faces, _, _ = model.find_faces(load_image(photo), det_size=GALLERY_DET_SIZE)
        if not faces:
            log(f"    ! no face found in {name}/{photo.name}")
            continue
        if len(faces) > 1:
            log(f"    ! {len(faces)} faces in {name}/{photo.name}, using the largest")
        biggest = max(faces, key=lambda f: np.prod(face_size(f)))
        embeddings.append(biggest.normed_embedding)  # "normed" = scaled to length 1, so dot product = similarity
        names.append(name)

    if not embeddings:
        return None, None
    embeddings = np.stack(embeddings)  # list of 512-number arrays -> one 2D array (photos x 512)
    cache_file.parent.mkdir(exist_ok=True)
    np.savez(cache_file, embeddings=embeddings, names=np.array(names), fingerprint=np.array(fingerprint))
    remember(embeddings, names)
    return embeddings, names


def nearest_gallery_match(embedding, gallery_embeddings, gallery_names):
    """
    The single closest gallery photo to this embedding, and its similarity score. This already
    finds the best-matching STUDENT too, not just the best photo: whichever photo scores highest
    across the searched gallery is, by definition, that student's own best photo.
    """
    scores = gallery_embeddings @ embedding  # both are unit-length, so this is cosine similarity
    best = int(np.argmax(scores))
    return gallery_names[best], float(scores[best])


# -------------------------------------------------------------- quality gates
def face_is_big_enough(face, min_px):
    """Free pre-check: is this face at least min_px pixels on its shorter side? Skips tiny, unreliable faces."""
    width, height = face_size(face)
    return min(width, height) >= min_px


def crop_is_sharp_enough(crop, min_variance):
    """
    Free pre-check: a sharp image has strong edges, which a Laplacian filter responds strongly
    to; its variance drops a lot on a blurred face. min_variance has no universal value - it
    depends on your camera and resolution, so measure it on a few of your own sharp vs. blurry
    crops and set accordingly.
    """
    if crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var() >= min_variance


# --------------------------------------------------------- roster / identity
def load_roster(path):
    """The backend's roster file: a JSON list of {student_id, gallery_folder, name}."""
    return json.loads(Path(path).read_text())


def build_identity_map(roster):
    """{gallery_folder: {"student_id", "name"}} - one entry per roster student that has a gallery
    folder. A roster student with no gallery_folder (not yet enrolled with photos) is left out."""
    return {s["gallery_folder"]: {"student_id": s["student_id"], "name": s.get("name")}
            for s in roster if s.get("gallery_folder")}


def identity_map_from_gallery(gallery_dir):
    """No roster given: every gallery folder is a student, identified by its folder name."""
    gallery_dir = Path(gallery_dir)
    folders = [d.name for d in gallery_dir.iterdir() if d.is_dir()] if gallery_dir.is_dir() else []
    return {name: {"student_id": name, "name": name} for name in folders}


def roster_cache_key(identity_map):
    """A cache name that is the SAME on every run for the same gallery folders. (Python's built-in
    hash() is not - it is randomized per run, so a hash()-based key would never find its cache.)"""
    digest = hashlib.md5("|".join(sorted(identity_map)).encode("utf-8")).hexdigest()[:12]
    return f"roster_{digest}"


def load_cached_roi(video_path):
    """Read a region saved earlier by roi_select.py; None means use the whole frame.
    Never opens a selection window itself - this script may run headless (e.g. spawned by Node)."""
    video_path = Path(video_path)
    cache_path = video_path.with_suffix(video_path.suffix + ".roi.json")
    if cache_path.exists():
        return tuple(json.loads(cache_path.read_text())["roi"])
    return None


# ---------------------------------------------------------------- attendance
class RunState:
    """Everything that changes while one clip is being scanned."""

    def __init__(self):
        self.present = {}            # student_id -> record of the match that marked them present
        self.attempts_used = {}      # track_id -> recognition attempts spent so far
        self.track_identity = {}     # track_id -> student_id, or None once given up on
        self.track_boxes = {}        # track_id -> last known bbox (for the final annotated image)
        self.track_best_scores = {}  # track_id -> best trusted similarity so far
        self.recognitions = 0        # total face recognitions run (for the timing summary)
        self.frames_processed = 0    # processed frames so far (the clock for track_last_seen)
        self.track_sightings = {}    # track_id -> number of processed frames it was detected in
        self.track_last_seen = {}    # track_id -> frames_processed value at its latest sighting


def process_frame(model, tracker, crop, gallery, identity_map, state, args, frame_index, timings, log):
    """
    Feed one frame's detected faces through the tracker. Every track that is not yet resolved and
    passes the free quality pre-checks gets a recognition attempt - all of them in ONE batched
    model call - until it matches a gallery student above --threshold, or its --max-attempts
    budget runs out. `state` (a RunState) is updated in place.
    Returns [(record, face), ...] for students newly marked present THIS frame.
    """
    gallery_embeddings, gallery_names = gallery
    state.frames_processed += 1

    faces, detect_ms = model.detect(crop)
    timings.add("detect faces", detect_ms)
    with timings.measure("track faces"):
        track_ids = tracker.update([face.bbox for face in faces])

    # Step 1 (cheap): decide which faces are worth a recognition attempt on this frame
    to_recognize = []  # list of (face, track_id)
    with timings.measure("quality pre-checks"):
        for face, track_id in zip(faces, track_ids):
            state.track_boxes[track_id] = face.bbox  # keep the freshest sighting for the final annotated image
            state.track_sightings[track_id] = state.track_sightings.get(track_id, 0) + 1
            state.track_last_seen[track_id] = state.frames_processed

            if track_id in state.track_identity:
                continue  # already resolved (matched, or gave up) - nothing left to do for this track
            if state.attempts_used.get(track_id, 0) >= args.max_attempts:
                state.track_identity[track_id] = None  # give up on this track for good
                continue
            if not face_is_big_enough(face, args.min_face):
                continue  # too small to bother with - free, does not use up an attempt
            x1, y1, x2, y2 = (max(0, int(v)) for v in face.bbox)  # max(0, ..): a box poking out of the frame must not wrap around
            if not crop_is_sharp_enough(crop[y1:y2, x1:x2], args.min_sharpness):
                continue  # too blurry - also free
            to_recognize.append((face, track_id))

    # Step 2 (expensive): one batched AdaFace call for every face chosen above
    recognize_ms = 0.0
    if to_recognize:
        recognize_started = time.perf_counter()
        model.recognize_batch(crop, [face for face, _ in to_recognize], timings)
        recognize_ms = (time.perf_counter() - recognize_started) * 1000
        state.recognitions += len(to_recognize)

    # Step 3 (cheap): compare each result with the gallery
    newly_present = []
    with timings.measure("match against gallery"):
        for face, track_id in to_recognize:
            attempts = state.attempts_used.get(track_id, 0) + 1
            state.attempts_used[track_id] = attempts
            matched = False

            if face.quality >= args.min_norm:  # a low-norm crop is not trusted (its attempt still counted)
                name, score = nearest_gallery_match(face.normed_embedding, gallery_embeddings, gallery_names)
                state.track_best_scores[track_id] = max(state.track_best_scores.get(track_id, float("-inf")), score)
                identity = identity_map.get(name)  # None = a gallery folder with no matching roster student
                if score >= args.threshold and identity is not None:
                    matched = True
                    state.track_identity[track_id] = identity["student_id"]
                    if identity["student_id"] not in state.present:
                        record = {**identity, "best_score": round(score, 4), "frame": frame_index, "track_id": track_id}
                        state.present[identity["student_id"]] = record
                        newly_present.append((record, face))

            if not matched and attempts >= args.max_attempts:
                state.track_identity[track_id] = None  # out of attempts: resolved as "unmatched" right away

    if args.verbose:
        log(f"  frame {frame_index}: {len(faces)} face(s) detected ({detect_ms:.0f} ms), "
            f"{len(to_recognize)} recognized ({recognize_ms:.0f} ms), {len(newly_present)} newly matched")
    return newly_present


def all_visible_faces_resolved(tracker, state):
    """
    Early-exit check: True when at least one face is currently visible on a trusted (confirmed)
    track, and every such track is resolved. Tracks that are not visible this frame
    (missed > 0) do not hold the scan open - they may be gone for good.
    """
    visible = [track for track in tracker.tracks if track.confirmed and track.missed == 0]
    return bool(visible) and all(track.id in state.track_identity for track in visible)


def save_debug_snapshot(debug_dir, crop, face, record):
    """Optional (--debug-dir): a small annotated crop for each newly-confirmed match, for manual review."""
    debug_dir = Path(debug_dir)
    debug_dir.mkdir(parents=True, exist_ok=True)
    x1, y1, x2, y2 = (int(v) for v in face.bbox)
    snapshot = crop.copy()
    cv2.rectangle(snapshot, (x1, y1), (x2, y2), (0, 200, 0), 2)
    label = f"{record.get('name') or record['student_id']} {record['best_score']:.2f}"
    cv2.putText(snapshot, label, (x1, max(0, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 0), 2, cv2.LINE_AA)
    save_image(debug_dir / f"{record['student_id']}.jpg", snapshot)


# Annotated-image filtering for faces that did NOT resolve to a student (the red boxes)
ANNOTATE_MIN_SIGHTINGS = 2   # must have been detected in at least this many processed frames (drops 1-frame flickers)
ANNOTATE_RECENT_FRAMES = 3   # ...and still seen within the last this-many processed frames (drops departed faces)
ANNOTATE_DUPLICATE_IOU = 0.25  # a box overlapping an already-drawn box by more than this is a duplicate of it


def _boxes_are_duplicates(box_a, box_b):
    """True if two face boxes almost surely show the same face (heavy overlap, or one centre inside the other)."""
    if iou(box_a, box_b) > ANNOTATE_DUPLICATE_IOU:
        return True
    for outer, inner in ((box_a, box_b), (box_b, box_a)):
        cx, cy = (inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2
        if outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]:
            return True
    return False


def save_aggregate_annotation(out_path, canvas, track_boxes, track_identity, track_best_scores, present, identity_map,
                              track_sightings=None, track_last_seen=None, frames_processed=0):
    """
    One final image summarising the whole clip, drawn on `canvas` (the most recent frame read).
    Green + name + similarity for a track that resolved to a student; red + "unmatched" for a
    track that used up its attempts without matching anyone; red + "unknown" for a track that was
    still unresolved when the clip ended.

    Each box is the track's LAST known position, so the red boxes are filtered to keep the picture
    an honest head count: a face must have been seen in ANNOTATE_MIN_SIGHTINGS frames and still be
    visible in the last ANNOTATE_RECENT_FRAMES frames, and a box that duplicates another drawn box
    (same face detected twice, or an old track plus its replacement) is drawn once, green first.
    Pass track_sightings / track_last_seen / frames_processed (from RunState) to enable the
    filtering; without them every track is drawn, as before.
    """
    annotated = canvas.copy()
    image_height, image_width = annotated.shape[:2]
    scale = max(0.6, image_height / 900)
    box_thickness = max(2, round(2 * scale))
    font_size = max(0.4, 0.5 * scale)
    text_thickness = max(1, round(1.3 * scale))
    padding = max(2, round(2 * scale))
    gap = max(2, round(4 * scale))
    font = cv2.FONT_HERSHEY_SIMPLEX
    by_student_id = {v["student_id"]: v for v in present.values()}
    best_track_by_student = {}
    for track_id, student_id in track_identity.items():
        if student_id is None or track_id not in track_boxes:
            continue
        box = track_boxes[track_id]
        area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
        rank = (track_best_scores.get(track_id, float("-inf")), area)
        if student_id not in best_track_by_student or rank > best_track_by_student[student_id][0]:
            best_track_by_student[student_id] = (rank, track_id)

    # Decide what to draw: resolved (green) tracks first, then the red ones, biggest face first.
    candidates = []
    for track_id, box in track_boxes.items():
        student_id = track_identity.get(track_id)
        if student_id is not None:
            if best_track_by_student[student_id][1] != track_id:
                continue
            priority = 0
        else:
            if track_sightings is not None and track_sightings.get(track_id, 0) < ANNOTATE_MIN_SIGHTINGS:
                continue
            if track_last_seen is not None and track_last_seen.get(track_id, 0) <= frames_processed - ANNOTATE_RECENT_FRAMES:
                continue
            priority = 1
        area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
        candidates.append((priority, -area, track_id, box))
    candidates.sort(key=lambda c: (c[0], c[1]))
    drawn = []
    for priority, _, track_id, box in candidates:
        if any(_boxes_are_duplicates(box, kept_box) for _, kept_box in drawn):
            continue
        drawn.append((track_id, box))

    for track_id, box in reversed(drawn):  # reversed: green boxes are painted last, on top
        x1, y1, x2, y2 = (int(v) for v in box)
        if track_id not in track_identity:
            student_id = None
            color, label = (0, 0, 220), "unknown"
        elif track_identity[track_id] is None:
            student_id = None
            color, label = (0, 0, 220), "unmatched"
        else:
            student_id = track_identity[track_id]
            record = by_student_id.get(student_id)
            color = (0, 200, 0)
            # (name or id): a roster entry with no name must not crash the label
            label = f"{(record.get('name') or str(student_id)).split()[0]} {record['best_score']:.3f}" if record else str(student_id)
        if student_id is None and track_id in track_best_scores:
            label = f"{label} {track_best_scores[track_id]:.3f}"
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, box_thickness)

        label_padding = min(padding, max(0, (image_width - 1) // 2))
        label_font_size = font_size
        (text_width, text_height), baseline = cv2.getTextSize(label, font, label_font_size, text_thickness)
        available_text_width = max(1, image_width - label_padding * 2)
        if text_width > available_text_width:
            label_font_size *= available_text_width / text_width
            (text_width, text_height), baseline = cv2.getTextSize(label, font, label_font_size, text_thickness)
        label_width = text_width + label_padding * 2
        label_height = text_height + baseline + label_padding * 2
        label_x = min(max(0, x1), max(0, image_width - label_width))
        if y1 - label_height - gap >= 0:
            label_top = y1 - label_height - gap
        else:
            label_top = min(y2 + gap, max(0, image_height - label_height))
        label_baseline = label_top + label_padding + text_height

        cv2.rectangle(annotated, (label_x, label_top),
                      (min(image_width - 1, label_x + label_width), min(image_height - 1, label_top + label_height)),
                      color, -1)
        cv2.putText(annotated, label, (label_x + label_padding, label_baseline), font, label_font_size,
                    (255, 255, 255), text_thickness, cv2.LINE_AA)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    save_image(out_path, annotated)
    return out_path


def run_attendance(model, video, identity_map, args, gallery_dir, cache_key, annotated_out=None,
                   debug_dir=None, memory_cache=None, log=print):
    """
    Scan one video and return the result dict (present/absent students, timings, ...).

    model        an already-loaded FaceModel (load it once and reuse it - that is the whole point of server.py)
    identity_map {gallery_folder: {"student_id", "name"}} - who to look for
    args         settings object from make_settings() (or the parsed command line)
    memory_cache optional dict that keeps gallery embeddings in memory between calls
    log          function that receives each progress line (print, or the server's collector)
    Raises RecognitionError for problems the caller should report (no gallery, video will not open).
    """
    timings = Timings()
    run_started = time.perf_counter()

    with timings.measure("gallery (load/build)"):
        gallery = build_gallery(model, gallery_dir, cache_key, only_folders=set(identity_map),
                                memory_cache=memory_cache, log=log)
    if gallery[0] is None:
        raise RecognitionError(f"No gallery found for this roster in {gallery_dir} - see recognize.py's "
                               f"docstring for the expected layout.")
    target_ids = {identity["student_id"] for identity in identity_map.values()}
    log(f"  {len(target_ids)} enrollable student(s) to look for")

    with timings.measure("open video"):
        capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RecognitionError(f"Could not open video: {video}")

    state = RunState()
    tracker = Tracker()
    frame_no, processed, last_crop, scanned_to = 0, 0, None, 0.0
    stop_reason = "end of video"
    try:
        fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        end_time = args.start + args.duration if args.duration > 0 else None
        if end_time is None and total_frames <= 0:
            log("  warning: this source doesn't report a frame count (likely a live stream) and "
                "--duration is 0 - this run will not stop on its own until the stream ends.")
        roi = load_cached_roi(video)  # None = whole frame; filled in from the first frame we process
        log(f"  video: {fps:.1f} fps; sampling every {args.every} frames from t={args.start:.1f}s"
            + (f" to t={end_time:.1f}s" if end_time else " to end of source"))

        # Sequential read + skip (no seeking): works the same for a recorded file and a live/RTSP
        # stream, where seeking to an arbitrary frame index either fails or is meaningless.
        # grab() decodes a frame but skips the (costly) conversion to a BGR image; retrieve() does
        # that conversion. We only need it for the 1-in-N frames we actually process.
        while True:
            with timings.measure("video: grab (decode)"):
                grabbed = capture.grab()
            if not grabbed:
                break
            frame_no += 1
            t = frame_no / fps
            if t < args.start:
                continue
            if end_time is not None and t >= end_time:
                stop_reason = f"reached --duration ({args.duration:.1f}s of video)"
                break
            if frame_no % args.every != 0:
                continue
            with timings.measure("video: retrieve (convert)"):
                ok, frame = capture.retrieve()
            if not ok:
                break

            if roi is None:
                roi = (0, 0, frame.shape[1], frame.shape[0])
                log(f"  region: {roi[2]}x{roi[3]} (whole frame)")
            roi_x, roi_y, roi_w, roi_h = roi
            crop = frame[roi_y:roi_y + roi_h, roi_x:roi_x + roi_w]
            last_crop = crop
            scanned_to = t

            newly_present = process_frame(model, tracker, crop, gallery, identity_map, state, args,
                                          frame_no, timings, log)
            for record, face in newly_present:
                log(f"  frame {frame_no} (t={t:.1f}s): "
                    f"{record.get('name') or record['student_id']} present (score {record['best_score']:.2f})")
                if debug_dir:
                    save_debug_snapshot(debug_dir, crop, face, record)

            processed += 1
            if target_ids and set(state.present) >= target_ids:
                stop_reason = "everyone present"
                break
            if args.early_exit and all_visible_faces_resolved(tracker, state):
                stop_reason = "every visible face resolved"
                break
    finally:
        capture.release()  # always, even on an error - a long-lived server must not leak cameras
    log(f"  scan ended at t={scanned_to:.1f}s: {stop_reason}")

    present_students = list(state.present.values())
    seen_ids = set(state.present)
    absent_students = [identity for identity in identity_map.values() if identity["student_id"] not in seen_ids]

    result = {"video": str(video), "processed_frames": processed,
              "present_students": present_students, "absent_students": absent_students}

    if annotated_out and last_crop is not None:
        with timings.measure("save annotated image"):
            out_path = save_aggregate_annotation(annotated_out, last_crop, state.track_boxes, state.track_identity,
                                                 state.track_best_scores, state.present, identity_map,
                                                 track_sightings=state.track_sightings,
                                                 track_last_seen=state.track_last_seen,
                                                 frames_processed=state.frames_processed)
        result["annotated_image"] = str(out_path)
        log(f"  annotated image: {out_path}")

    elapsed = time.perf_counter() - run_started
    result.update({"elapsed_seconds": round(elapsed, 2), "stop_reason": stop_reason,
                   "video_seconds_scanned": round(scanned_to, 1), "recognitions": state.recognitions,
                   "timings": timings.as_dict()})

    log(f"\n{len(present_students)}/{len(target_ids)} present, {processed} frame(s) processed in {elapsed:.2f}s")
    if state.recognitions:
        recognize_ms = sum(timings.total_ms.get(step, 0.0) for step in
                           ("recognize: align + preprocess", "recognize: model inference"))
        log(f"  {state.recognitions} face recognition(s), {recognize_ms / state.recognitions:.1f} ms per face on average")
    for line in timings.report_lines(elapsed * 1000):
        log(line)
    return result


# --------------------------------------------------------------- command line
def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", required=True, help="file path, or an RTSP/HTTP stream URL for live CCTV")
    parser.add_argument("--models", default=str(HERE / "models"))
    parser.add_argument("--rec-model", default=os.environ.get("CCTV_REC_MODEL", DEFAULT_REC_FILENAME),
                        help="recognizer file inside --models; use the int8 file made by quantize_model.py to run faster")
    parser.add_argument("--gallery", default=str(HERE / "gallery"))
    parser.add_argument("--students-json", default=None,
                        help="roster JSON from the backend; omit to use gallery folder names as identities directly")
    parser.add_argument("--class-id", default=None,
                        help="keys the embeddings cache so different classes never share one cache file")
    parser.add_argument("--json-out", default=str(HERE / "results" / "result.json"))
    parser.add_argument("--annotated-out", default=None,
                        help="save one final annotated image here (last frame, every track's box, green=matched/red=unmatched); omit to skip. Already saved by cctv.routes.js")
    parser.add_argument("--threshold", type=float, default=DEFAULT_SETTINGS["threshold"],
                        help="similarity needed for ONE recognition attempt to count as a match - set this from calibrate.py's report, not this default")
    parser.add_argument("--max-attempts", type=int, default=DEFAULT_SETTINGS["max_attempts"],
                        help="recognition attempts allowed per track before giving up on it")
    parser.add_argument("--every", type=int, default=DEFAULT_SETTINGS["every"], help="process every Nth frame")
    parser.add_argument("--duration", type=float, default=DEFAULT_SETTINGS["duration"],
                        help="stop after this many seconds of video time, regardless of who has been found - the real scan budget. 0 = no limit (to the end of the file); never use 0 for a live/RTSP source")
    parser.add_argument("--no-early-exit", dest="early_exit", action="store_false",
                        help="always scan the full --duration, even when every visible face is already resolved")
    parser.add_argument("--det-size", default="1920x1080")
    parser.add_argument("--det-thresh", type=float, default=0.25)
    parser.add_argument("--min-face", type=int, default=DEFAULT_SETTINGS["min_face"],
                        help="skip faces shorter than this (px) on either side - free, no attempt spent")
    parser.add_argument("--min-sharpness", type=float, default=DEFAULT_SETTINGS["min_sharpness"],
                        help="skip blurry crops below this Laplacian-variance score - free, no attempt spent; tune on your own footage")
    parser.add_argument("--min-norm", type=float, default=DEFAULT_SETTINGS["min_norm"],
                        help="ignore a recognition attempt if AdaFace's own quality score is below this (the attempt still counts against --max-attempts); 0 = disabled until calibrated. Re-calibrate after switching to an int8 model - its norms differ slightly")
    parser.add_argument("--start", type=float, default=DEFAULT_SETTINGS["start"], help="seconds into the clip to start at")
    parser.add_argument("--verbose", action="store_true", help="log one line per processed frame")
    parser.add_argument("--debug-dir", default=None, help="save a snapshot of each newly-confirmed match here")
    return parser.parse_args()


def main():
    args = parse_args()
    det_size = parse_det_size(args.det_size)

    print("Loading models ...")
    load_started = time.perf_counter()
    model = FaceModel(args.models, det_size, args.det_thresh, args.rec_model)
    print(f"  loaded in {time.perf_counter() - load_started:.1f}s: {model.describe()}")

    if args.students_json:
        identity_map = build_identity_map(load_roster(args.students_json))
        cache_key = args.class_id or roster_cache_key(identity_map)
    else:
        identity_map = identity_map_from_gallery(args.gallery)
        cache_key = "all"

    settings = make_settings(**{name: getattr(args, name) for name in DEFAULT_SETTINGS})
    try:
        result = run_attendance(model, args.video, identity_map, settings, args.gallery, cache_key,
                                annotated_out=args.annotated_out, debug_dir=args.debug_dir)
    except RecognitionError as error:
        sys.exit(str(error))

    out_path = Path(args.json_out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=1))
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()