#!/usr/bin/env python3
"""
recognize.py - CCTV classroom attendance: given a video clip (or live stream), detect faces,
track them across frames, and recognize each track (AdaFace ir101) only as often as needed.

Setup:    pip install insightface openvino opencv-python numpy gdown uvicorn scipy

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

Borderline matches (optional, --accept-threshold): by default ONE attempt at or above --threshold
(the floor) marks a student present. Set --accept-threshold above the floor (e.g. 0.26 / 0.35) and
only an attempt at or above it is accepted at once; an attempt between the two is "borderline" and
needs a second agreeing attempt on the same track. A borderline attempt is also ignored when a
live track already holds that student with a score clearly higher (CLAIM_MARGIN): one student
cannot sit in two seats, so the weaker face is a look-alike and ends up "unmatched". The price is
about one extra sampled frame for genuinely borderline students.

--max-attempts bounds the cost of ONE face, not the length of the scan. The scan length is fixed:
  * --duration: the scan window, in seconds of VIDEO time. Every scan processes the same frames
    (one every --every frames) whoever has been found, so the time students must look at the camera
    is known in advance and every laptop gets the same input. 0 means "no limit" (until the file
    ends) - never use 0 on a live/RTSP stream, which does not end on its own.
  There is deliberately no early exit: it made the scan length depend on who was in the room.
  scripts/window_study.py measures how long the window and the attempt budget need to be.

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

Live cameras (RTSP)
-------------------
--video can also be an rtsp:// URL (a CP Plus / Dahua NVR channel). A live source is read by a
background thread (LiveStream) that keeps the connection open and remembers only the NEWEST frame;
the scan takes a fresh frame about every --sample-interval seconds and skips any it has no time
for, so it never works on stale video. --duration and the sampling are measured in WALL-CLOCK
seconds (an RTSP stream's reported fps cannot be trusted). server.py keeps one LiveStream per
camera (StreamManager) so the connection can be opened ahead of time ("warmed").

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
import re
import sys
import threading
import time
from contextlib import contextmanager, nullcontext
from pathlib import Path
from types import SimpleNamespace

# RTSP over TCP (UDP drops packets on a busy network -> grey/smeared frames) and no input buffering.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay")

import cv2
import numpy as np
import onnxruntime

try:
    from insightface.app.common import Face
    from insightface.model_zoo import model_zoo
    from insightface.utils import face_align
except ImportError:
    sys.exit("InsightFace is missing. Run: pip install insightface onnxruntime opencv-python numpy")

import accel
import crop_ops
from tracker import Tracker, iou
from matching import (TrackPool, rank_candidates, choose_faces_to_report, RunState, stronger_live_claim,
                      nearest_gallery_match, decide_attempt, gate_track, CLAIM_MARGIN)   # the decision logic lives in matching.py
from enroll_qa import sharpness_of
from gallery_extras import (EmbeddingFileCache, degrade_photo, is_cctv_crop, parse_widths)

# ------------------------------------------------------------------ settings
HERE = Path(__file__).resolve().parent
IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
# Where the 5 landmarks sit in a perfectly aligned 112x112 crop, as (x, y) / 112. A KP-RPE recognizer takes the face's
# landmarks as a second input; this is what it gets when told to ignore the detector's own (noisy) landmarks.
TEMPLATE_KEYPOINTS = crop_ops.TEMPLATE_KEYPOINTS   # = face_align.arcface_dst / 112
KEYPOINT_MODES = ("detected", "template")


def keypoint_mode_setting():
    """CCTV_KEYPOINTS: 'detected' (default) feeds a KP-RPE recognizer the face's real landmarks, mapped into the
    aligned crop - how CVLface itself uses the model. 'template' feeds the fixed ideal landmark positions instead
    (the same thing as a model exported with `convert_to_onnx.py --keypoints template`). Ignored by models that
    take only an image. The setting is part of the gallery-cache name, so switching it rebuilds the embeddings."""
    value = os.environ.get("CCTV_KEYPOINTS", "detected").strip().lower()
    return value if value in KEYPOINT_MODES else "detected"


def default_crop_config(profile_crop=None):
    """The crop settings a FaceModel starts with: the model's profile (<model>.settings.json), and CCTV_KEYPOINTS,
    when that variable is set, decides the keypoints mode (detected / template) on top of it."""
    config = crop_ops.CropConfig.from_dict(profile_crop)
    if "CCTV_KEYPOINTS" in os.environ:
        config = crop_ops.CropConfig(**{**config.as_dict(), "keypoints": keypoint_mode_setting()})
    return config
GALLERY_DET_SIZE = (640, 640)
DEFAULT_DET_FILENAME = "10g_bnkps.onnx"
DEFAULT_REC_FILENAME = "adaface_ir101_webface12m.onnx"
RECOGNIZE_BATCH_SIZE = 16  # most faces sent to AdaFace in one model call (keeps memory use modest)
MODEL_URLS = {
    DEFAULT_DET_FILENAME: "https://drive.google.com/file/d/1rLV-F8MG4hXlTzaUfFrfOCH1LQDp8BHr",
    DEFAULT_REC_FILENAME: "https://drive.google.com/file/d/1dGzgy7cNdWYXrX4FLAGeMSEOXfD8g28j",
}

# Every per-run setting and its default, in ONE place. The command line (parse_args) and the
# server (the "options" in a request) both read from here, so the two can never disagree.
DEFAULT_SETTINGS = {
    "threshold": 0.26,      # the FLOOR: similarity an attempt needs to count as a match at all
    "accept_threshold": 0.28,  # IMMEDIATE-ACCEPT score. 0 = off (every attempt >= threshold is accepted at once, as before).
                            # If set above threshold: an attempt >= this is accepted at once, while one between
                            # threshold and this ("borderline") needs a 2nd agreeing attempt on the same track, and is
                            # rejected if another live track already holds that student with a clearly higher score.
    "max_attempts": 10,      # recognition attempts allowed per track before giving up on it
    "every": 18,            # process every Nth frame
    "duration": 10.0,        # seconds of video to scan; 0 = no limit
    "min_face": 0,          # skip faces shorter than this (px) - free, no attempt spent
    "min_sharpness": 0.0,   # skip blurry crops below this Laplacian variance - free
    "min_norm": 0.0,        # distrust an attempt whose AdaFace quality score is below this
    "start": 0.0,           # seconds into the clip to start at
    "sample_interval": 0.72,  # LIVE only: seconds between processed frames (the clip default, every=18 at 25 fps, is 0.72)
    "first_frame_timeout": 10.0,  # LIVE only: give up if the camera sends no frame within this many seconds
    "stall_timeout": 5.0,   # LIVE only: stop the scan if no new frame arrives for this many seconds
    "verbose": False,       # log one line per processed frame
    "pool_attempts": True,  # also match the AVERAGE of a track's best looks (quality-weighted), not only each look alone
    "pool_top_k": 5,        # how many of a track's best looks go into that average
    "suggestions": 3,       # "who might this be" candidates listed for each unmatched face
    "suggest_min_score": 0.12,  # ...but only students scoring at least this
    "gallery_degrade_widths": (),  # e.g. (20, 28): also keep CCTV-quality copies of every gallery photo. Off until measured (bakeoff.py)
    "aggregator": "max",    # how a student's several gallery photos become one score: max | mean2 | mean3. Off (max) until measured (bakeoff.py)
    "margin": 0.0,          # 0 = off. Else the best student must beat the best OTHER student by this much, or the attempt is "ambiguous"
    "pool_gate": 0.0,       # 0 = off. Else a look this dissimilar (cosine) to a track's pooled looks starts a fresh pool (seatmate took over the track)
    "trace": False,         # True: record every recognition attempt (result["trace"]) for offline replay
}


def model_fingerprint(path):
    """A short id for the recognizer FILE, so a re-export under the same name is noticed: the SHA-256 recorded by
    convert_to_onnx.py (a <model>.onnx.json next to it) plus the size, otherwise size + modified time."""
    path = Path(path)
    stat = path.stat()
    try:
        sha = json.loads(Path(str(path) + ".json").read_text(encoding="utf-8")).get("sha256")
        if sha:
            return f"{str(sha)[:12]}-{stat.st_size}"
    except (OSError, ValueError, AttributeError):
        pass
    return f"{stat.st_size}-{stat.st_mtime_ns}"


def load_model_profile(rec_path):
    """Optional per-model tuning in <model>.settings.json next to the .onnx (written by bakeoff.py), e.g.
    {"crop": {"interp": "cubic", "flip": true}, "settings": {"threshold": 0.2, "accept_threshold": 0.24}}."""
    try:
        data = json.loads(Path(rec_path).with_suffix(".settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def apply_profile_defaults(args, model):
    """args with the model's own tuned values filled in - but only where the caller left the global default, so an
    explicit command-line / request value always wins."""
    profile = getattr(model, "profile_settings", None) or {}
    if not profile:
        return args
    merged = dict(vars(args))
    for key, value in profile.items():
        if key in DEFAULT_SETTINGS and merged.get(key, DEFAULT_SETTINGS[key]) == DEFAULT_SETTINGS[key]:
            merged[key] = value
    return SimpleNamespace(**merged)


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

    Two kinds of model file work. The IR-101 kind takes the aligned image only. The KP-RPE ViT kind (made by
    convert_to_onnx.py --keypoints input) takes the image AND the face's 5 landmarks as a second input called
    'keypoints' - (x, y) in the aligned 112x112 crop, divided by 112, shape [N, 5, 2]. Which kind a file is gets
    detected from its inputs, so nothing else needs configuring.

    How a face becomes the 112x112 input (interpolation, photometric clean-up, flip / jitter averaging, and for a
    KP-RPE model whether it gets the detected or the template landmarks) is set by `crop_config`
    (crop_ops.CropConfig); the default is exactly insightface's own alignment. `role` says where a picture comes
    from: 'photo' = a clean phone/ID photo, 'cctv' = a camera crop (probes, saved CCTV crops, degraded gallery
    copies); some crop settings apply to only one of the two. The landmarks of a KP-RPE model always follow the
    crop: shifted for a jittered alignment, mirrored for a flipped crop.
    """

    def __init__(self, onnx_path, session=None, crop_config=None):
        self.crop_config = crop_config or default_crop_config()
        self.model_file = str(onnx_path)
        # `session` = an already-built engine (accel.OpenVINOSession); without one, plain onnxruntime on the CPU
        self.session = session or onnxruntime.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        inputs = self.session.get_inputs()
        model_input = inputs[0]
        self.input_name = model_input.name
        if len(inputs) > 2:
            sys.exit(f"{Path(onnx_path).name} has {len(inputs)} inputs - this script supports an image, "
                     f"optionally plus 'keypoints'.")
        self.keypoint_name = inputs[1].name if len(inputs) == 2 else None
        self.uses_keypoints = self.keypoint_name is not None
        self.output_names = [output.name for output in self.session.get_outputs()]
        if len(self.output_names) < 2:
            sys.exit(f"{Path(onnx_path).name} only has one output - this script needs the (embedding, quality_norm) "
                     f"export. Re-export with two outputs.")
        # The first number of the input shape is the batch size. A fixed number (usually 1) means
        # the model was exported for ONE face per call; a name like "batch" means any number works.
        batch_dim = model_input.shape[0]
        self.supports_batch = not (isinstance(batch_dim, int) and batch_dim > 0)
        out_shape = self.session.get_outputs()[0].shape
        self.dim = out_shape[1] if len(out_shape) > 1 and isinstance(out_shape[1], int) and out_shape[1] > 0 else 512

    @property
    def keypoint_mode(self):
        """'detected' or 'template' for a KP-RPE model (see crop_ops.CropConfig.keypoints); None for an image-only model."""
        return self.crop_config.keypoints if self.uses_keypoints else None

    def align_face(self, image, kps):
        """The 112x112 BGR crop the model sees: the face warped so eyes, nose and mouth sit in fixed places."""
        return crop_ops.align(image, np.asarray(kps, dtype=np.float32), self.crop_config.interp)

    def crop_keypoints(self, kps):
        """The 5 landmarks of a face as a KP-RPE model wants them: where they land INSIDE the aligned 112x112 crop,
        (x, y) / 112. Uses the very transform align_face applies, so the crop and its landmarks always agree."""
        if self.keypoint_mode == "template" or kps is None:
            return TEMPLATE_KEYPOINTS
        return crop_ops.crop_keypoints(kps)

    @staticmethod
    def to_tensor(aligned):
        """A 112x112 BGR crop -> the 1x3x112x112 number array AdaFace expects."""
        # AdaFace expects BGR pixels scaled to roughly [-1, 1]; cv2 images are already BGR
        pixels = (aligned.astype(np.float32) / 255.0 - 0.5) / 0.5
        return np.ascontiguousarray(pixels.transpose(2, 0, 1)[np.newaxis])  # HxWxC -> 1xCxHxW

    def _feed(self, batch, keypoints):
        """The model's input dict. `keypoints`: one [5, 2] row per image, or None for the template positions."""
        feed = {self.input_name: batch}
        if self.uses_keypoints:
            if keypoints is None:
                keypoints = np.repeat(TEMPLATE_KEYPOINTS[np.newaxis], len(batch), axis=0)
            feed[self.keypoint_name] = np.ascontiguousarray(np.asarray(keypoints, dtype=np.float32))
        return feed

    def blank_feed(self, size):
        """An all-zero input of `size` faces (for warming the models up)."""
        return self._feed(np.zeros((size, 3, 112, 112), dtype=np.float32), None)

    def preprocess(self, image, face):
        """Align one face to 112x112 and turn it into the 1x3x112x112 number array AdaFace expects."""
        aligned = self.align_face(image, face.kps)
        face.aligned_bgr = aligned   # kept so a confirmed match can be saved to the gallery as it was seen
        return self.to_tensor(aligned)

    def _run(self, tensors, keypoints):
        """(embeddings, norms) for a list of 1x3x112x112 arrays (and their [5, 2] landmark rows, KP-RPE models only),
        in chunks the model / engine accepts."""
        embeddings, norms = [], []
        # A batch-capable model takes up to RECOGNIZE_BATCH_SIZE crops per call; otherwise 1 per call
        chunk_size = RECOGNIZE_BATCH_SIZE if self.supports_batch else 1
        for start in range(0, len(tensors), chunk_size):
            batch = np.concatenate(tensors[start:start + chunk_size])   # shape: (crops in chunk, 3, 112, 112)
            chunk_keypoints = None if keypoints is None else np.stack(keypoints[start:start + chunk_size])
            chunk_embeddings, chunk_norms = self.session.run(self.output_names, self._feed(batch, chunk_keypoints))
            embeddings.append(np.asarray(chunk_embeddings, dtype=np.float32))
            norms.append(np.asarray(chunk_norms, dtype=np.float32).reshape(-1))   # one quality number per crop
        return np.concatenate(embeddings), np.concatenate(norms)

    def _embed_groups(self, groups, role):
        """`groups` = one list of (aligned crop, landmarks inside it) pairs per face (the primary crop first, then any
        jittered ones; landmarks None = the template). Every crop gets the configured clean-up (and its mirror image, with
        flip) and all of them go through the model together; each face's results are averaged.
        Returns [(unit embedding, quality)], one per face."""
        tensors, keypoints, owner = [], [], []
        for index, pairs in enumerate(groups):
            for crop, landmarks in crop_ops.finalize_pairs(pairs, self.crop_config, role):
                tensors.append(self.to_tensor(crop))
                keypoints.append(landmarks)
                owner.append(index)
        embeddings, norms = self._run(tensors, keypoints if self.uses_keypoints else None)
        owner = np.asarray(owner)
        return [crop_ops.combine(embeddings[owner == index], norms[owner == index]) for index in range(len(groups))]

    def embed_aligned(self, aligned_crops, keypoints=None, role="cctv"):
        """
        Embeddings for crops that are ALREADY aligned 112x112 (e.g. saved CCTV crops). Returns
        (unit embeddings, quality norms), one row per crop. `keypoints` (KP-RPE models only): one [5, 2] row per
        crop from crop_keypoints(); left out, the crops are assumed perfectly aligned (the template positions).
        """
        if not len(aligned_crops):
            return np.zeros((0, self.dim), np.float32), np.zeros((0,), np.float32)
        rows = keypoints if keypoints is not None else [None] * len(aligned_crops)
        results = self._embed_groups([[(crop, kp)] for crop, kp in zip(aligned_crops, rows)], role)
        return np.stack([embedding for embedding, _ in results]), np.array([quality for _, quality in results], np.float32)

    def embed_with_kps(self, image, kps, role="photo"):
        """Unit embedding + quality norm of the face with these five landmarks in `image`."""
        kps = np.asarray(kps, dtype=np.float32)
        ((embedding, quality),) = self._embed_groups([crop_ops.variants_for(image, kps, self.crop_config, role)], role)
        return embedding, float(quality)

    def get_batch(self, image, faces, timings=None, role="cctv"):
        """Align all the faces, run AdaFace on them in as few model calls as possible, and store
        the embedding + quality on each face."""
        if not faces:
            return
        timings = timings or Timings()
        with timings.measure("recognize: align + preprocess"):
            groups = []
            for face in faces:
                pairs = crop_ops.variants_for(image, face.kps, self.crop_config, role)
                face.aligned_bgr = pairs[0][0]   # the plain aligned crop, kept so a confirmed match can be saved as it was seen
                groups.append(pairs)
        with timings.measure("recognize: model inference"):
            results = self._embed_groups(groups, role)
        for face, (embedding, quality) in zip(faces, results):
            face.embedding = embedding  # face.normed_embedding is computed from this automatically
            face.quality = float(quality)

    def get(self, image, face, role="photo"):
        """Single-face version of get_batch (used for gallery photos)."""
        self.get_batch(image, [face], role=role)


class FaceModel:
    """Detector (SCRFD det_10g) + recognizer (AdaFace ir101), both loaded straight from local .onnx
    files."""

    def __init__(self, models_dir, det_size, det_thresh, rec_filename=DEFAULT_REC_FILENAME, log=print, crop_config=None):
        models_dir = Path(models_dir)
        det_path = download_if_missing(models_dir / DEFAULT_DET_FILENAME, MODEL_URLS[DEFAULT_DET_FILENAME])
        rec_path = download_if_missing(models_dir / rec_filename, MODEL_URLS.get(rec_filename))

        self.det_size = det_size
        # The detector object is always built the normal way (it reads its anchors/strides from the model); if
        # OpenVINO is in use its onnxruntime session is swapped for the OpenVINO one right after prepare().
        self.detector = model_zoo.get_model(str(det_path), providers=["CPUExecutionProvider"])
        self.detector.prepare(ctx_id=-1, input_size=det_size, det_thresh=det_thresh)  # ctx_id=-1 = CPU

        det_session, rec_session = self._open_openvino(det_path, rec_path, det_size, log)
        if det_session is not None:
            self.detector.session = det_session
        self.det_session, self.rec_session = det_session, rec_session   # None = onnxruntime
        # per-model tuning written by bakeoff.py (<model>.settings.json); an explicit crop_config wins over it
        self.profile = load_model_profile(rec_path)
        if crop_config is None:
            crop_config = default_crop_config(self.profile.get("crop"))
        self.recognizer = AdaFaceRecognizer(rec_path, session=rec_session, crop_config=crop_config)

        self.det_name, self.rec_name = det_path.stem, rec_path.stem
        self.rec_fingerprint = model_fingerprint(rec_path)
        self.model_mb = (det_path.stat().st_size + rec_path.stat().st_size) / 1e6

    @property
    def profile_settings(self):
        """Run settings tuned for THIS recognizer (from its .settings.json), applied where the caller kept the default."""
        settings = self.profile.get("settings")
        return settings if isinstance(settings, dict) else {}

    @property
    def cache_tag(self):
        """Identifies everything that changes what an embedding means: model name + file fingerprint + crop settings
        (which include the keypoints mode of a KP-RPE model). Part of every gallery cache key, so a re-exported model
        or a new crop / landmark setting never reuses old numbers."""
        return f"{self.rec_name}:{self.rec_fingerprint}:{self.recognizer.crop_config.signature()}"

    @staticmethod
    def _open_openvino(det_path, rec_path, det_size, log):
        """(detector session, recognizer session) on OpenVINO, or (None, None) to stay on onnxruntime. In the
        default 'auto' mode ANY problem (package missing, unsupported CPU, driver error) falls back quietly to
        onnxruntime, so the service always starts; with CCTV_BACKEND=openvino the error is raised instead."""
        if not accel.wants_openvino():
            return None, None
        try:
            common = dict(device=accel.device_setting(), cache=accel.cache_dir(HERE), precision=accel.precision_setting(),
                          log=log)
            det_session = accel.OpenVINOSession(det_path, **common)
            rec_session = accel.OpenVINOSession(rec_path, batches=accel.batch_buckets(), **common)
            # compile the two shapes every scan needs RIGHT NOW, so a device problem shows up here (and falls back)
            det_session.compile_shape((1, 3, det_size[1], det_size[0]))
            rec_session.compile_shape((rec_session.bucket_for(1), 3, 112, 112))
            return det_session, rec_session
        except Exception as error:
            if accel.backend_mode() == "openvino":
                raise
            log(f"  OpenVINO not used ({type(error).__name__}: {error}) - falling back to onnxruntime on the CPU")
            return None, None

    def backend_summary(self):
        """'OpenVINO 2025.x on GPU.0 (Intel(R) Iris(R) Xe Graphics)' or 'onnxruntime (CPU)'."""
        if self.rec_session is None:
            return "onnxruntime (CPU)"
        devices = self.rec_session.device_names() or [accel.device_setting()]
        return f"OpenVINO {accel.openvino_version()} on {', '.join(devices)}"

    def describe(self):
        """One line for the startup log."""
        batching = "on" if self.recognizer.supports_batch else "OFF (model has a fixed batch size of 1)"
        keypoints = (f", keypoints: {self.recognizer.keypoint_mode} landmarks"
                     if self.recognizer.uses_keypoints else "")
        crop = self.recognizer.crop_config.label()
        return (f"detector {self.det_name} @ {self.det_size[0]}x{self.det_size[1]}, "
                f"recognizer {self.rec_name} [{crop}], batching {batching}{keypoints}, {self.model_mb:.0f} MB of models, "
                f"engine: {self.backend_summary()}")

    def warm_up(self):
        """Run each model once on blank data. The very first call is slower (memory is set up lazily; on OpenVINO
        every input shape is compiled once), so do it at startup instead of during the first real request."""
        self.detect(np.zeros((self.det_size[1], self.det_size[0], 3), dtype=np.uint8))
        recognizer = self.recognizer
        sizes = self.rec_session.batches if self.rec_session is not None else (1,)
        for size in sizes:   # OpenVINO: one compile per batch size; onnxruntime: just the one warm-up call
            recognizer.session.run(recognizer.output_names, recognizer.blank_feed(size))
        if self.det_session is not None and tuple(GALLERY_DET_SIZE) != tuple(self.det_size):
            # gallery photos are detected at 640x640 - compile that shape now, not during the first gallery build
            self.detect(np.zeros((GALLERY_DET_SIZE[1], GALLERY_DET_SIZE[0], 3), dtype=np.uint8), det_size=GALLERY_DET_SIZE)

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
def gallery_photos(gallery_dir, only_folders=None):
    """[(folder name, photo path)] for every student photo, scoped to `only_folders` when given."""
    gallery_dir = Path(gallery_dir)
    student_dirs = sorted(d for d in gallery_dir.iterdir() if d.is_dir()) if gallery_dir.is_dir() else []
    if only_folders is not None:
        student_dirs = [d for d in student_dirs if d.name in only_folders]
    return [(d.name, p) for d in student_dirs for p in sorted(d.iterdir()) if p.suffix.lower() in IMAGE_TYPES]


def embed_gallery_photo(model, photo, degrade_widths=(), log=print):
    """
    The embeddings one gallery photo contributes: a (rows x 512) array, empty when no face was found.
    A saved CCTV crop (cctv_*.png) is already aligned, so it is embedded directly. Any other photo is searched
    for its largest face; with `degrade_widths`, smaller blurred copies of it are embedded too.
    """
    image = load_image(photo)
    if is_cctv_crop(photo):
        if image.shape[:2] != (112, 112):
            image = cv2.resize(image, (112, 112), interpolation=cv2.INTER_AREA)
        embeddings, _ = model.recognizer.embed_aligned([image], role="cctv")
        return embeddings
    faces, _, _ = model.find_faces(image, det_size=GALLERY_DET_SIZE)
    if not faces:
        log(f"    ! no face found in {photo.parent.name}/{photo.name}")
        return np.zeros((0, model.recognizer.dim), np.float32)
    if len(faces) > 1:
        log(f"    ! {len(faces)} faces in {photo.parent.name}/{photo.name}, using the largest")
    biggest = max(faces, key=lambda f: np.prod(face_size(f)))
    rows = [biggest.normed_embedding]
    face_width = face_size(biggest)[0]
    for width in degrade_widths:   # what this photo would look like from the CCTV camera
        degraded = degrade_photo(image, biggest.kps, face_width, width)
        if degraded is not None:
            small_image, small_kps = degraded
            rows.append(model.recognizer.embed_with_kps(small_image, small_kps, role="cctv")[0])
    return np.stack(rows)


def build_gallery(model, gallery_dir, cache_key, only_folders=None, memory_cache=None, log=print,
                  degrade_widths=()):
    """
    Return (embeddings, names) with one row per gallery entry (a photo, plus its degraded copies when
    `degrade_widths` is set), scoped to `only_folders` when given (the current class's roster) so a different
    class's students can never win the nearest-match search. Cached per `cache_key` (use the class id) so
    classes never share or invalidate each other's cache.

    Four levels, fastest first: `memory_cache` (a dict the long-lived server keeps between requests), the class
    .npz file in cache/, a per-PHOTO cache in cache/photos/ (so one new photo costs one embedding, not the whole
    class again), and finally the model itself. The fingerprint includes the recognizer model's name and the
    degrade widths, so switching models or settings rebuilds instead of silently mixing numbers.
    """
    degrade_widths = tuple(degrade_widths or ())
    photos = gallery_photos(gallery_dir, only_folders)
    if not photos:
        return None, None

    # A "fingerprint" of the gallery (model, names, sizes, dates) tells us if the cache is still valid
    photos = [(name, photo) for name, photo in photos if photo.exists()]   # one may be replaced while we list
    if not photos:
        return None, None
    fingerprint = str([model.cache_tag, degrade_widths]
                      + [(name, p.name, p.stat().st_size, int(p.stat().st_mtime)) for name, p in photos if p.exists()])

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

    photo_cache = EmbeddingFileCache(HERE / "cache" / "photos")
    folders = {name for name, _ in photos}
    log(f"  gallery: preparing {len(photos)} photo(s) of {len(folders)} student(s) ({cache_key}) ...")
    embeddings, names, computed = [], [], 0
    for name, photo in photos:
        try:
            key = photo_cache.key_for(photo, model.cache_tag, degrade_widths)
            rows = photo_cache.get(key, name)   # name = the student's folder: cache/photos/<student folder>/<key>.npy
            if rows is None:
                rows = embed_gallery_photo(model, photo, degrade_widths, log)
                photo_cache.put(key, rows, name)
                computed += 1
        except Exception as error:   # a damaged or vanished picture is skipped, never fatal for the whole class
            log(f"  gallery: skipped {photo.name} of {name} ({type(error).__name__}: {error})")
            continue
        for row in rows:
            embeddings.append(row)
            names.append(name)
    log(f"  gallery: {computed} photo(s) embedded now, {len(photos) - computed} taken from the photo cache")

    if not embeddings:
        return None, None
    embeddings = np.stack(embeddings)  # list of 512-number arrays -> one 2D array (entries x 512)
    cache_file.parent.mkdir(exist_ok=True)
    np.savez(cache_file, embeddings=embeddings, names=np.array(names), fingerprint=np.array(fingerprint))
    remember(embeddings, names)
    return embeddings, names


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


# ------------------------------------------------------------ live cameras (RTSP)
LIVE_PREFIXES = ("rtsp://", "rtsps://")
LIVE_MAX_FRAME_AGE = 1.0   # s: a frame older than this is not fresh enough to START a scan with
LIVE_MAX_SCAN = 60.0       # s: hard cap for a live scan when --duration is 0


class CameraError(RecognitionError):
    """The camera could not be reached or stopped sending frames - report it, it is not a bug."""


def is_live_source(video):
    return str(video).strip().lower().startswith(LIVE_PREFIXES)


def mask_url(text):
    """Hide 'user:password@' in an RTSP URL (or in any text containing one) before it reaches logs,
    error messages or API replies."""
    return re.sub(r"(?i)(rtsps?://)[^/@\s]*@", r"\1***@", str(text))


class LiveStream:
    """
    ONE open camera connection, read by a background thread that keeps only the newest frame.

    Why a thread: the scan (face detection + recognition) can take longer than the gap between
    sampled frames. If it read the camera itself, frames would pile up in the network buffer and
    it would end up analysing video that is seconds old - or the connection would drop. Here the
    thread always drains the camera, and the scan simply asks for "a frame newer than T".
    It also reconnects by itself (1, 2, 4, 8, 10 s ... between tries) when the camera drops.
    The thread is a daemon: a camera that hangs while opening can never block the scan - the scan
    gives up after first_frame_timeout - and it never keeps the server from exiting.
    """

    def __init__(self, url, open_timeout=8.0, read_timeout=5.0, keep_every=0.1, log=print):
        self.url = url
        self.label = mask_url(url)
        self.open_timeout = open_timeout
        self.read_timeout = read_timeout
        self.keep_every = keep_every      # convert at most this often (decoding every frame is unavoidable, converting is not)
        self.log = log
        self.connected = False
        self.last_error = None
        self.last_used = time.monotonic()
        self._cond = threading.Condition()
        self._frame, self._frame_time, self._seq = None, 0.0, 0
        self._stop = threading.Event()
        self._thread = None

    # -- control
    def start(self):
        self._thread = threading.Thread(target=self._run, name=f"camera-{abs(hash(self.label)) % 10000}", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        with self._cond:
            self._cond.notify_all()

    def alive(self):
        return self._thread is not None and self._thread.is_alive() and not self._stop.is_set()

    def touch(self):
        self.last_used = time.monotonic()

    def status(self):
        with self._cond:
            age = time.monotonic() - self._frame_time if self._frame is not None else None
        return {"camera": self.label, "connected": self.connected, "last_frame_age_s": None if age is None else round(age, 2),
                "last_error": self.last_error, "idle_s": round(time.monotonic() - self.last_used, 1)}

    # -- consumer side
    def wait_for_frame(self, after, timeout):
        """(seq, frame_time, frame) of the newest frame taken after time `after` (time.monotonic()
        clock), waiting up to `timeout` seconds for one; None if none arrives (or we were stopped)."""
        end = time.monotonic() + timeout
        with self._cond:
            while True:
                if self._frame is not None and self._frame_time > after:
                    return self._seq, self._frame_time, self._frame
                left = end - time.monotonic()
                if left <= 0 or self._stop.is_set():
                    return None
                self._cond.wait(left)

    # -- reader thread
    def _open(self):
        params = [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, int(self.open_timeout * 1000),
                  cv2.CAP_PROP_READ_TIMEOUT_MSEC, int(self.read_timeout * 1000)]
        try:
            return cv2.VideoCapture(self.url, cv2.CAP_FFMPEG, params)
        except (TypeError, cv2.error):   # an OpenCV build without the timeout parameters
            return cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)

    def _publish(self, frame):
        with self._cond:
            self._frame, self._frame_time = frame, time.monotonic()
            self._seq += 1
            self._cond.notify_all()

    def _run(self):
        backoff = 1.0
        while not self._stop.is_set():
            capture = None
            try:
                capture = self._open()
                if not capture.isOpened():
                    self.last_error = "could not open the stream (check address, login, channel number, or that the camera is online)"
                else:
                    self.connected, self.last_error, backoff = True, None, 1.0
                    self.log(f"[camera] connected: {self.label}")
                    last_kept = 0.0
                    while not self._stop.is_set():
                        if not capture.grab():
                            self.last_error = "the stream stopped delivering frames"
                            break
                        now = time.monotonic()
                        if now - last_kept >= self.keep_every:
                            ok, frame = capture.retrieve()
                            if ok:
                                self._publish(frame)
                                last_kept = now
            except Exception as error:   # a reader thread must never die silently
                self.last_error = f"{type(error).__name__}: {error}"
            finally:
                was_connected, self.connected = self.connected, False
                if capture is not None:
                    try:
                        capture.release()
                    except Exception:
                        pass
            if was_connected and not self._stop.is_set():
                self.log(f"[camera] lost: {self.label} - {self.last_error}; reconnecting")
            self._stop.wait(backoff)
            backoff = min(backoff * 2, 10.0)


class StreamManager:
    """One LiveStream per camera URL, shared by every scan of that camera, closed after sitting idle.
    'Warming' a camera = calling get() before anyone needs it, so the connection (and the wait for
    the camera's first full frame, which can take seconds) is already done when attendance starts."""

    def __init__(self, idle_seconds=600.0, max_streams=12, log=print):
        self.idle_seconds = idle_seconds
        self.max_streams = max_streams
        self.log = log
        self._streams = {}
        self._lock = threading.Lock()

    def start_sweeper(self):
        def loop():
            while True:
                time.sleep(30)
                self.sweep()
        threading.Thread(target=loop, name="camera-sweeper", daemon=True).start()

    def get(self, url):
        with self._lock:
            stream = self._streams.get(url)
            if stream is not None and not stream.alive():
                self._streams.pop(url, None)
                stream = None
            if stream is None:
                while len(self._streams) >= self.max_streams:   # drop the least recently used camera
                    oldest = min(self._streams, key=lambda key: self._streams[key].last_used)
                    self._streams.pop(oldest).stop()
                stream = LiveStream(url, log=self.log).start()
                self._streams[url] = stream
            stream.touch()
            return stream

    def release(self, url):
        with self._lock:
            stream = self._streams.pop(url, None)
        if stream is not None:
            stream.stop()
        return stream is not None

    def sweep(self):
        with self._lock:
            idle = [url for url, s in self._streams.items() if time.monotonic() - s.last_used > self.idle_seconds]
            stale = [self._streams.pop(url) for url in idle]
        for stream in stale:
            self.log(f"[camera] closing idle connection: {stream.label}")
            stream.stop()

    def status(self):
        with self._lock:
            return [stream.status() for stream in self._streams.values()]

    def stop_all(self):
        with self._lock:
            streams, self._streams = list(self._streams.values()), {}
        for stream in streams:
            stream.stop()


def file_frame_source(capture, fps, args, end_time, timings, stop_note):
    """Yields (frame_no, t, frame) for every args.every-th frame of a recorded clip - the original loop."""
    # Sequential read + skip (no seeking). grab() decodes a frame but skips the (costly) conversion
    # to a BGR image; retrieve() does that conversion, and we only need it for the 1-in-N frames we use.
    frame_no = 0
    while True:
        with timings.measure("video: grab (decode)"):
            grabbed = capture.grab()
        if not grabbed:
            return
        frame_no += 1
        t = frame_no / fps
        if t < args.start:
            continue
        if end_time is not None and t >= end_time:
            stop_note["reason"] = f"reached --duration ({args.duration:.1f}s of video)"
            return
        if frame_no % args.every != 0:
            continue
        with timings.measure("video: retrieve (convert)"):
            ok, frame = capture.retrieve()
        if not ok:
            return
        yield frame_no, t, frame


def live_frame_source(stream, args, timings, stop_note, log, lock=None):
    """
    Yields (frame_no, t, frame) from a LiveStream: the newest frame at least args.sample_interval
    seconds after the previous one. If processing a frame took longer than that, the next call
    returns immediately with the latest frame (frames in between are skipped, never queued).
    t = wall-clock seconds since the first frame; the scan ends args.duration seconds after it, not counting
    time spent waiting for the shared models (lock.wait_ms) - a busy server must not shorten anyone's scan -
    and at most duration / sample_interval + 1 frames.
    """
    stream.touch()
    with timings.measure("live: wait for first frame"):
        item = stream.wait_for_frame(after=time.monotonic() - LIVE_MAX_FRAME_AGE, timeout=args.first_frame_timeout)
    if item is None:
        raise CameraError(f"No video from the camera within {args.first_frame_timeout:.0f}s: "
                          f"{stream.last_error or 'no frames received'} ({stream.label})")
    scan_started = item[1]
    duration = args.duration if args.duration > 0 else LIVE_MAX_SCAN
    # The same number of samples a scan gets when the server is idle. Without this cap, a busy server
    # (waits do not use up the time budget) would make every scan process EXTRA frames back to back.
    max_samples = int(duration / max(args.sample_interval, 0.05)) + 1
    samples = 0
    waited_before = getattr(lock, "wait_ms", 0.0)

    def deadline():
        return scan_started + duration + (getattr(lock, "wait_ms", 0.0) - waited_before) / 1000

    while True:
        seq, frame_time, frame = item
        yield seq, frame_time - scan_started, frame      # the caller processes the frame, then resumes us here
        stream.touch()
        samples += 1
        if samples >= max_samples:
            stop_note["reason"] = f"reached --duration ({duration:.1f}s of live video)"
            return
        target = frame_time + args.sample_interval
        if target > deadline():
            stop_note["reason"] = f"reached --duration ({duration:.1f}s of live video)"
            return
        item = stream.wait_for_frame(after=target, timeout=min(args.stall_timeout, max(0.1, deadline() - time.monotonic())))
        if item is None:
            if time.monotonic() >= deadline() - 0.05:
                stop_note["reason"] = f"reached --duration ({duration:.1f}s of live video)"
            else:
                stop_note["reason"] = f"camera stopped delivering frames ({stream.last_error or 'stalled'})"
                log(f"  warning: {stop_note['reason']}")
            return


# ---------------------------------------------------------------- attendance
def remember_thumb(state, track_id, face, frame, size=80, margin=0.5):
    """Keeps a small picture of the face (with some surroundings) from the frame where the detector was surest, so
    the faculty can see WHO an unrecognised face is without hunting for it in the big picture."""
    score = float(face.det_score)
    if track_id in state.track_thumbs and state.track_thumbs[track_id][0] >= score:
        return
    x1, y1, x2, y2 = face.bbox
    pad_x, pad_y = (x2 - x1) * margin, (y2 - y1) * margin
    left, top = max(0, int(x1 - pad_x)), max(0, int(y1 - pad_y))
    right, bottom = min(frame.shape[1], int(x2 + pad_x)), min(frame.shape[0], int(y2 + pad_y))
    if right - left < 4 or bottom - top < 4:
        return
    state.track_thumbs[track_id] = (score, cv2.resize(frame[top:bottom, left:right], (size, size), interpolation=cv2.INTER_CUBIC))


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
    state.frame_faces = {}

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
            state.track_widths[track_id] = float(face.bbox[2] - face.bbox[0])
            remember_thumb(state, track_id, face, crop)
            info = {"bbox": face.bbox, "det": float(face.det_score), "status": "queued", "score": None, "quality": None}
            state.frame_faces[track_id] = info

            x1, y1, x2, y2 = (max(0, int(v)) for v in face.bbox)  # max(0, ..): a box poking out of the frame must not wrap around
            if gate_track(state, track_id, info, args,
                          big_enough=lambda: face_is_big_enough(face, args.min_face),
                          sharp_enough=lambda: crop_is_sharp_enough(crop[y1:y2, x1:x2], args.min_sharpness)):
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
            record = decide_attempt(state, track_id, face, gallery, identity_map, args, frame_index)   # matching.py
            if record is not None:
                newly_present.append((record, face))

    state.frame_stats.append({"frame": frame_index, "faces": len(faces), "recognized": len(to_recognize),
                              "detect_ms": round(detect_ms, 1), "recognize_ms": round(recognize_ms, 1),
                              "new_matches": len(newly_present)})
    if args.verbose:
        log(f"  frame {frame_index}: {len(faces)} face(s) detected ({detect_ms:.0f} ms), "
            f"{len(to_recognize)} recognized ({recognize_ms:.0f} ms), {len(newly_present)} newly matched")
    return newly_present


SNAPSHOT_COLORS = {          # BGR box colour per outcome on that frame
    "MATCHED": (0, 200, 0), "resolved": (0, 200, 0),
    "tried (no match)": (0, 0, 220), "tried (low quality)": (0, 0, 220), "gave up": (0, 0, 140),
    "borderline 1/2": (0, 165, 255),
    "queued": (0, 200, 220), "skipped: small": (0, 140, 255), "skipped: blurry": (0, 140, 255),
}


def open_snapshot_run_folder(snapshot_dir, cache_key):
    """A fresh sub-folder per scan, e.g. snapshots/F_310_ab12cd34ef_20261008_111855/."""
    tag = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(cache_key or "run"))
    folder = Path(snapshot_dir) / f"{tag}_{time.strftime('%Y%m%d_%H%M%S')}"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def save_frame_snapshot(folder, crop, frame_no, t, state, names):
    """
    Debug aid: save the frame just processed with EVERY detected face drawn, whatever happened to
    it, plus one row per face in detections.csv. Label = T<track id>, the student's name once
    matched, s<similarity of this frame's attempt>, d<detector confidence>, a<attempts used so far>.
    Colours: green matched/resolved, red tried and not matched (incl. "T<n> holds this student"),
    amber borderline - waiting for a 2nd agreeing attempt, yellow waiting for an attempt,
    orange skipped by --min-face / --min-sharpness, dark red gave up.
    """
    image = crop.copy()
    height, width = image.shape[:2]
    scale = max(0.6, height / 900)
    thickness = max(2, round(2 * scale))
    font, font_size = cv2.FONT_HERSHEY_SIMPLEX, max(0.4, 0.45 * scale)
    text_thickness = max(1, round(1.2 * scale))

    csv_path = folder / "detections.csv"
    new_csv = not csv_path.exists()
    rows = []
    # left-to-right, alternating label above / below the box so neighbouring labels collide less
    for order, (track_id, info) in enumerate(sorted(state.frame_faces.items(), key=lambda kv: kv[1]["bbox"][0])):
        x1, y1, x2, y2 = (int(v) for v in info["bbox"])
        status = info["status"]
        color = SNAPSHOT_COLORS.get(status) or ((0, 0, 220) if status.startswith("tried") else (200, 200, 200))
        student_id = state.track_identity.get(track_id)
        name = names.get(student_id, "") if student_id is not None else ""
        attempts = state.attempts_used.get(track_id, 0)
        parts = [f"T{track_id}"]
        if name:
            parts.append(name)
        if info["score"] is not None:
            parts.append(f"s{info['score']:.3f}")
        parts.append(f"d{info['det']:.2f}")
        parts.append(f"a{attempts}")
        label = " ".join(parts)
        cv2.rectangle(image, (x1, y1), (x2, y2), color, thickness)
        (text_w, text_h), baseline = cv2.getTextSize(label, font, font_size, text_thickness)
        top = y1 - text_h - baseline - 4 if order % 2 == 0 else y2 + 3
        top = min(max(0, top), max(0, height - text_h - baseline - 2))
        left = min(max(0, x1), max(0, width - text_w - 4))
        cv2.rectangle(image, (left, top), (left + text_w + 4, top + text_h + baseline + 2), color, -1)
        cv2.putText(image, label, (left + 2, top + text_h + 1), font, font_size, (255, 255, 255), text_thickness, cv2.LINE_AA)
        rows.append([frame_no, f"{t:.2f}", track_id, x1, y1, x2, y2, f"{info['det']:.3f}", status,
                     attempts, "" if info["score"] is None else f"{info['score']:.4f}",
                     "" if info["quality"] is None else f"{info['quality']:.2f}", name])

    matched = sum(1 for info in state.frame_faces.values() if info["status"] in ("MATCHED", "resolved"))
    header = f"frame {frame_no}  t={t:.1f}s  faces={len(state.frame_faces)}  matched/resolved={matched}"
    cv2.rectangle(image, (0, height - 34), (width, height), (0, 0, 0), -1)
    cv2.putText(image, header, (10, height - 10), font, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
    save_image(folder / f"frame_{frame_no:05d}_t{t:06.1f}s.jpg", image)

    import csv
    with open(csv_path, "a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if new_csv:
            writer.writerow(["frame", "time_s", "track", "x1", "y1", "x2", "y2", "det_score", "status",
                             "attempts", "similarity", "quality_norm", "student"])
        writer.writerows(rows)


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
ANNOTATE_RECENT_FRAMES = 0   # >0: also require a sighting within the last this-many processed frames (0 = off; it also hides faces that are only detected now and then, e.g. a head turned down)
ANNOTATE_AMBER_RECENT_FRAMES = 2   # an amber "name?" box must have been seen within the last this-many processed frames (drops dead tracks of someone who moved)
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


def select_tracks(track_boxes, track_identity, track_best_scores, track_sightings, track_last_seen, frames_processed):
    """Which tracks are drawn on the final picture and listed for review (see matching.choose_faces_to_report)."""
    return choose_faces_to_report(
        track_boxes, track_identity, track_best_scores, track_sightings, track_last_seen, frames_processed,
        min_sightings=ANNOTATE_MIN_SIGHTINGS, amber_recent_frames=ANNOTATE_AMBER_RECENT_FRAMES,
        recent_frames=ANNOTATE_RECENT_FRAMES, duplicate_test=_boxes_are_duplicates)


def save_aggregate_annotation(out_path, canvas, track_boxes, track_identity, track_best_scores, present, identity_map,
                              track_sightings=None, track_last_seen=None, frames_processed=0, drawn=None,
                              best_track_by_student=None):
    """
    One final image summarising the whole clip, drawn on `canvas` (the most recent frame read).
    Green + name + similarity for a track that resolved to a student; red + "unmatched" for a
    track that used up its attempts without matching anyone, or was still unresolved when the clip ended (labelled
    with its best similarity score only, to keep the picture readable); green and amber boxes carry the name too. When SEVERAL tracks resolved to the same student, only
    the best-scoring one is green; the others are drawn amber as "<name>? <score>" - one person
    cannot be in two seats, so an amber box is either a look-alike false match or a lost-and-found
    track of the same person. Either way it is a face that exists and must not silently vanish.

    Each box is the track's LAST known position, so the red boxes are filtered to keep the picture
    an honest head count: a face must have been seen in ANNOTATE_MIN_SIGHTINGS frames (and, if
    ANNOTATE_RECENT_FRAMES is set, seen recently), and a box that duplicates another drawn box
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
    if drawn is None or best_track_by_student is None:   # normally run_attendance passes these in, to share them with the review list
        drawn, best_track_by_student = select_tracks(track_boxes, track_identity, track_best_scores,
                                                     track_sightings, track_last_seen, frames_processed)

    for track_id, box in reversed(drawn):  # reversed: green boxes are painted last, on top
        x1, y1, x2, y2 = (int(v) for v in box)
        if track_id not in track_identity:
            student_id = None
            color, label = (0, 0, 220), None
        elif track_identity[track_id] is None:
            student_id = None
            color, label = (0, 0, 220), None
        else:
            student_id = track_identity[track_id]
            record = by_student_id.get(student_id)
            # (name or id): a roster entry with no name must not crash the label
            short_name = (record.get('name') or str(student_id)).split()[0] if record else str(student_id)
            if best_track_by_student[student_id][1] == track_id:
                color = (0, 200, 0)
                label = f"{short_name} {record['best_score']:.3f}" if record else short_name
            else:  # a second track claimed this student: show it, flagged, instead of hiding it
                color = (0, 165, 255)
                own_score = track_best_scores.get(track_id)
                label = f"{short_name}? {own_score:.3f}" if own_score is not None else f"{short_name}?"
        if student_id is None and track_id in track_best_scores:
            label = f"{track_best_scores[track_id]:.3f}"   # red: just the best score it reached
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, box_thickness)
        if label is None:
            continue   # a face that never produced a score (e.g. no attempt yet) is only a red box

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


def thumb_data_url(picture):
    """A small BGR picture -> a data: URL the page can show directly (JPEG, ~3 KB at 80x80)."""
    import base64
    ok, encoded = cv2.imencode(".jpg", picture, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii") if ok else None


def build_face_report(state, drawn, best_track_by_student, gallery, identity_map, args, crops_dir=None, stamp=""):
    """
    One entry per face worth showing to the faculty, in the same order and with the same filtering as the boxes on
    the final picture:
      status  "matched"      named a student (and is that student's best track)
              "unmatched"    a face big enough to be recognised that nobody matched; `suggestions` lists who it
                             most looks like among the students NOT already present
    When `crops_dir` is given, the aligned 112x112 crop the recognizer saw is saved there as <stamp>_t<track>.png
    (lossless) and named in `crop_file`: this is what is added to a student's gallery once the faculty confirms.
    """
    gallery_embeddings, gallery_names = gallery
    present_ids = set(state.present)
    faces = []
    for track_id, box in drawn:
        student_id = state.track_identity.get(track_id)
        is_best = student_id is not None and best_track_by_student[student_id][1] == track_id
        width = state.track_widths.get(track_id, float(box[2] - box[0]))
        if is_best:
            status = "matched"
        else:
            status = "unmatched"
        pool = state.track_pools.get(track_id)
        entry = {"track_id": track_id, "status": status, "width_px": round(width, 1),
                 "bbox": [round(float(v), 1) for v in box],
                 "student_id": student_id if is_best else None,
                 "score": None if track_id not in state.track_best_scores else round(state.track_best_scores[track_id], 4),
                 "quality": None if pool is None or pool.best_quality() is None else round(pool.best_quality(), 2),
                 "crop_score": None,
                 "suggestions": [], "crop_file": None, "thumb": None}
        if status != "matched" and pool is not None and pool.pooled() is not None and args.suggestions > 0:
            entry["suggestions"] = rank_candidates(pool.pooled(), gallery_embeddings, gallery_names, identity_map,
                                                   exclude_student_ids=present_ids, top_n=args.suggestions,
                                                   min_score=args.suggest_min_score)
        # The crop kept for the gallery is the SHARPEST of the track's best looks, and it is ranked by face width x
        # sharpness: more real pixels and a crisper picture, whatever the model's feature norm says (the norm was
        # nearly flat across a whole classroom, so it could not tell a good look from a poor one).
        aligned, sharpness = pool.sharpest_aligned(sharpness_of) if pool is not None else (None, None)
        if aligned is not None:
            entry["crop_score"] = round(width * sharpness, 1)
        if crops_dir and aligned is not None:
            crops_dir = Path(crops_dir)
            crops_dir.mkdir(parents=True, exist_ok=True)
            file_name = f"{stamp}_t{track_id}.png"
            cv2.imwrite(str(crops_dir / file_name), aligned)
            entry["crop_file"] = file_name
        if track_id in state.track_thumbs:
            entry["thumb"] = thumb_data_url(state.track_thumbs[track_id][1])
        faces.append(entry)
    return faces


def run_attendance(model, video, identity_map, args, gallery_dir, cache_key, annotated_out=None,
                   debug_dir=None, memory_cache=None, log=print, snapshot_dir=None, stream=None, infer_lock=None,
                   crops_dir=None):
    """
    Scan one video and return the result dict (present/absent students, timings, ...).

    model        an already-loaded FaceModel (load it once and reuse it - that is the whole point of server.py)
    identity_map {gallery_folder: {"student_id", "name"}} - who to look for
    args         settings object from make_settings() (or the parsed command line)
    memory_cache optional dict that keeps gallery embeddings in memory between calls
    log          function that receives each progress line (print, or the server's collector)
    stream       optional LiveStream (server.py passes a shared, already-open one). Without it, an rtsp:// `video`
                 gets a private LiveStream that is closed when the scan ends.
    crops_dir    optional folder: the aligned crop of every reported face is saved there (see build_face_report)
    infer_lock   optional context manager held while the models run (gallery build, one frame of detection +
                 recognition) - NOT while waiting for the camera. server.py shares one between all scans, so several
                 classes can be scanned at once: while one waits for its next frame, another uses the models.
    Raises RecognitionError for problems the caller should report (no gallery, video will not open);
    CameraError (a RecognitionError) when a live camera cannot be reached.
    """
    timings = Timings()
    run_started = time.perf_counter()
    infer_lock = infer_lock if infer_lock is not None else nullcontext()
    args = apply_profile_defaults(args, model)   # this recognizer's own tuned thresholds, where the caller kept the defaults

    with timings.measure("gallery (load/build)"), infer_lock:
        gallery = build_gallery(model, gallery_dir, cache_key, only_folders=set(identity_map),
                                memory_cache=memory_cache, log=log,
                                degrade_widths=tuple(args.gallery_degrade_widths or ()))
    if gallery[0] is None:
        raise RecognitionError(f"No gallery found for this roster in {gallery_dir} - see recognize.py's "
                               f"docstring for the expected layout.")
    target_ids = {identity["student_id"] for identity in identity_map.values()}
    log(f"  {len(target_ids)} enrollable student(s) to look for")

    live = stream is not None or is_live_source(video)
    owns_stream = False
    capture = None
    if live:
        if stream is None:   # private connection for this scan only (command line use)
            stream, owns_stream = LiveStream(video, log=log).start(), True
    else:
        with timings.measure("open video"):
            capture = cv2.VideoCapture(str(video))
        if not capture.isOpened():
            raise RecognitionError(f"Could not open video: {video}")

    state = RunState()
    tracker = Tracker()
    # Per-frame debug snapshots: pass snapshot_dir, or set the CCTV_SNAPSHOT_DIR environment variable.
    snapshot_dir = snapshot_dir or os.environ.get("CCTV_SNAPSHOT_DIR") or None
    snapshot_folder = None
    snapshot_names = {identity["student_id"]: (identity.get("name") or str(identity["student_id"])).split()[0]
                      for identity in identity_map.values()}
    frame_no, processed, last_crop, scanned_to = 0, 0, None, 0.0
    stop_reason = None   # taken from the frame source (stop_note) once the window is used up
    try:
        stop_note = {"reason": "end of video"}
        if live:
            roi = None   # no saved region for live cameras (yet): use the whole frame
            frames = live_frame_source(stream, args, timings, stop_note, log, infer_lock)
            log(f"  live camera {stream.label}: a frame about every {args.sample_interval:.2f}s, "
                f"for up to {args.duration if args.duration > 0 else LIVE_MAX_SCAN:.1f}s")
        else:
            fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
            total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            end_time = args.start + args.duration if args.duration > 0 else None
            if end_time is None and total_frames <= 0:
                log("  warning: this source doesn't report a frame count and --duration is 0 - "
                    "this run will not stop on its own until the video ends.")
            roi = load_cached_roi(video)  # None = whole frame; filled in from the first frame we process
            log(f"  video: {fps:.1f} fps; sampling every {args.every} frames from t={args.start:.1f}s"
                + (f" to t={end_time:.1f}s" if end_time else " to end of source"))
            frames = file_frame_source(capture, fps, args, end_time, timings, stop_note)

        for frame_no, t, frame in frames:
            if roi is None:
                roi = (0, 0, frame.shape[1], frame.shape[0])
                log(f"  region: {roi[2]}x{roi[3]} (whole frame)")
            roi_x, roi_y, roi_w, roi_h = roi
            crop = frame[roi_y:roi_y + roi_h, roi_x:roi_x + roi_w]
            last_crop = crop
            scanned_to = t

            with infer_lock:   # the models: one frame at a time across all scans
                newly_present = process_frame(model, tracker, crop, gallery, identity_map, state, args,
                                              frame_no, timings, log)
            state.frame_stats[-1]["t"] = round(t, 2)
            for record, face in newly_present:
                record["t"] = round(t, 2)
                log(f"  frame {frame_no} (t={t:.1f}s): "
                    f"{record.get('name') or record['student_id']} present (score {record['best_score']:.2f})")
                if debug_dir:
                    save_debug_snapshot(debug_dir, crop, face, record)

            if snapshot_dir:
                try:  # a debug aid must never be able to break an attendance run
                    with timings.measure("save frame snapshot"):
                        if snapshot_folder is None:
                            snapshot_folder = open_snapshot_run_folder(snapshot_dir, cache_key)
                            log(f"  saving per-frame snapshots to {snapshot_folder}")
                        save_frame_snapshot(snapshot_folder, crop, frame_no, t, state, snapshot_names)
                except Exception as error:
                    log(f"  snapshot failed (ignored): {error}")
                    snapshot_dir = None

            processed += 1
        if stop_reason is None:
            stop_reason = stop_note["reason"]
    finally:
        if capture is not None:
            capture.release()  # always, even on an error - a long-lived server must not leak cameras
        if owns_stream:
            stream.stop()
    log(f"  scan ended at t={scanned_to:.1f}s: {stop_reason}")

    present_students = list(state.present.values())
    seen_ids = set(state.present)
    absent_students = [identity for identity in identity_map.values() if identity["student_id"] not in seen_ids]

    result = {"video": mask_url(video), "source": "live" if live else "file", "processed_frames": processed,
              "present_students": present_students, "absent_students": absent_students}

    # Which faces to show: the same selection draws the boxes on the picture and fills the review list
    drawn, best_track_by_student = select_tracks(state.track_boxes, state.track_identity, state.track_best_scores,
                                                 state.track_sightings, state.track_last_seen, state.frames_processed)
    faces = build_face_report(state, drawn, best_track_by_student, gallery, identity_map, args,
                              crops_dir=crops_dir, stamp=time.strftime("%Y%m%d%H%M%S"))
    result["faces"] = faces
    result["frame_stats"] = state.frame_stats
    result["track_summary"] = [{"track_id": tid, "student_id": state.track_identity.get(tid),
                                "attempts": state.attempts_used.get(tid, 0),
                                "sightings": state.track_sightings.get(tid, 0),
                                "attempt_frames": state.track_attempt_frames.get(tid, []),
                                "best_score": None if tid not in state.track_best_scores else round(state.track_best_scores[tid], 4)}
                               for tid in sorted(state.track_sightings)]
    result["faces_detected"] = len(faces)
    result["face_counts"] = {status: sum(1 for face in faces if face["status"] == status)
                             for status in ("matched", "unmatched")}

    if annotated_out and last_crop is not None:
        with timings.measure("save annotated image"):
            out_path = save_aggregate_annotation(annotated_out, last_crop, state.track_boxes, state.track_identity,
                                                 state.track_best_scores, state.present, identity_map,
                                                 track_sightings=state.track_sightings,
                                                 track_last_seen=state.track_last_seen,
                                                 frames_processed=state.frames_processed,
                                                 drawn=drawn, best_track_by_student=best_track_by_student)
        result["annotated_image"] = str(out_path)
        log(f"  annotated image: {out_path}")

    elapsed = time.perf_counter() - run_started
    result.update({"elapsed_seconds": round(elapsed, 2), "stop_reason": stop_reason,
                   "video_seconds_scanned": round(scanned_to, 1), "recognitions": state.recognitions,
                   "timings": timings.as_dict()})
    if getattr(args, "trace", False):
        result["trace"] = state.attempt_log   # one entry per recognition attempt, for offline replay

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
    parser.add_argument("--accept-threshold", type=float, default=DEFAULT_SETTINGS["accept_threshold"],
                        help="immediate-accept similarity (0 = off). Attempts between --threshold and this need a second agreeing attempt; e.g. --threshold 0.26 --accept-threshold 0.35")
    parser.add_argument("--max-attempts", type=int, default=DEFAULT_SETTINGS["max_attempts"],
                        help="recognition attempts allowed per track before giving up on it")
    parser.add_argument("--every", type=int, default=DEFAULT_SETTINGS["every"], help="process every Nth frame")
    parser.add_argument("--duration", type=float, default=DEFAULT_SETTINGS["duration"],
                        help="stop after this many seconds of video time, regardless of who has been found - the real scan budget. 0 = no limit (to the end of the file); never use 0 for a live/RTSP source")
    parser.add_argument("--sample-interval", type=float, default=DEFAULT_SETTINGS["sample_interval"],
                        help="LIVE (rtsp://) only: seconds between processed frames; --every is used for recorded files")
    parser.add_argument("--first-frame-timeout", type=float, default=DEFAULT_SETTINGS["first_frame_timeout"],
                        help="LIVE only: give up if the camera sends no frame within this many seconds")
    parser.add_argument("--stall-timeout", type=float, default=DEFAULT_SETTINGS["stall_timeout"],
                        help="LIVE only: stop the scan if no new frame arrives for this many seconds")
    parser.add_argument("--det-size", default="1920x1080")
    parser.add_argument("--det-thresh", type=float, default=0.3)
    parser.add_argument("--min-face", type=int, default=DEFAULT_SETTINGS["min_face"],
                        help="skip faces shorter than this (px) on either side - free, no attempt spent")
    parser.add_argument("--min-sharpness", type=float, default=DEFAULT_SETTINGS["min_sharpness"],
                        help="skip blurry crops below this Laplacian-variance score - free, no attempt spent; tune on your own footage")
    parser.add_argument("--min-norm", type=float, default=DEFAULT_SETTINGS["min_norm"],
                        help="ignore a recognition attempt if AdaFace's own quality score is below this (the attempt still counts against --max-attempts); 0 = disabled until calibrated. Re-calibrate after switching to an int8 model - its norms differ slightly")
    parser.add_argument("--no-pool", dest="pool_attempts", action="store_false",
                        help="match each look at a face on its own, instead of also matching the average of its best looks")
    parser.add_argument("--pool-top-k", type=int, default=DEFAULT_SETTINGS["pool_top_k"],
                        help="how many of a face's best looks are averaged")
    parser.add_argument("--suggestions", type=int, default=DEFAULT_SETTINGS["suggestions"],
                        help="how many 'might be' students to list for each unmatched face")
    parser.add_argument("--suggest-min-score", type=float, default=DEFAULT_SETTINGS["suggest_min_score"])
    parser.add_argument("--gallery-degrade", dest="gallery_degrade_widths", type=parse_widths,
                        default=parse_widths(os.environ.get("CCTV_GALLERY_DEGRADE", "")),
                        help="e.g. '20,28': also keep CCTV-quality copies of every gallery photo (measure with bakeoff.py first)")
    parser.add_argument("--aggregator", choices=["max", "mean2", "mean3"], default=DEFAULT_SETTINGS["aggregator"],
                        help="how a student's several gallery photos become one score (measure with bakeoff.py)")
    parser.add_argument("--margin", type=float, default=DEFAULT_SETTINGS["margin"],
                        help="0 = off. The best student must beat the best OTHER student by this much, else the attempt is ambiguous")
    parser.add_argument("--pool-gate", type=float, default=DEFAULT_SETTINGS["pool_gate"],
                        help="0 = off. A look whose similarity to the track's earlier looks is below this starts a fresh pool")
    parser.add_argument("--trace-out", default=None, help="write one JSON line per recognition attempt here (offline replay)")
    parser.add_argument("--interp", choices=sorted(crop_ops.INTERP_FLAGS), default=None,
                        help="interpolation when warping the face to 112x112 (default: the model's profile, else linear)")
    parser.add_argument("--enhance", default=None,
                        help="clean-up of the aligned crop, e.g. clahe:2:4, gamma:0.7, autogamma, histeq, unsharp, gauss:0.7, nlm:5 (chain with +)")
    parser.add_argument("--enhance-side", choices=["both", "cctv"], default=None,
                        help="apply --enhance to every crop, or only to camera-side crops (probes, saved CCTV crops)")
    parser.add_argument("--flip-tta", action="store_true", help="embed each crop and its mirror image and average them (2x model cost)")
    parser.add_argument("--jitter", type=int, choices=[0, 4, 8], default=None,
                        help="CCTV probes: also embed this many slightly shifted alignments and average them")
    parser.add_argument("--crops-dir", default=None, help="save the aligned crop of each reported face here")
    parser.add_argument("--start", type=float, default=DEFAULT_SETTINGS["start"], help="seconds into the clip to start at")
    parser.add_argument("--verbose", action="store_true", help="log one line per processed frame")
    parser.add_argument("--debug-dir", default=None, help="save a snapshot of each newly-confirmed match here")
    parser.add_argument("--snapshot-dir", default=str(HERE / "snapshots"),
                        help="save every processed frame with all detected faces drawn (plus detections.csv) in a sub-folder here; "
                             "the CCTV_SNAPSHOT_DIR environment variable does the same")
    return parser.parse_args()


def main():
    args = parse_args()
    det_size = parse_det_size(args.det_size)

    print("Loading models ...")
    load_started = time.perf_counter()
    crop_flags = {"interp": args.interp, "enhance": args.enhance, "enhance_side": args.enhance_side,
                  "jitter": args.jitter, "flip": True if args.flip_tta else None}
    given = {key: value for key, value in crop_flags.items() if value is not None}
    # None = the model's profile (and CCTV_KEYPOINTS); any flag given builds the config from the flags + the profile
    crop_config = None
    if given:
        base = default_crop_config(load_model_profile(Path(args.models) / args.rec_model).get("crop"))
        crop_config = crop_ops.CropConfig(**{**base.as_dict(), **given})
    model = FaceModel(args.models, det_size, args.det_thresh, args.rec_model, crop_config=crop_config)
    print(f"  loaded in {time.perf_counter() - load_started:.1f}s: {model.describe()}")

    if args.students_json:
        identity_map = build_identity_map(load_roster(args.students_json))
        cache_key = args.class_id or roster_cache_key(identity_map)
    else:
        identity_map = identity_map_from_gallery(args.gallery)
        cache_key = "all"

    settings = make_settings(**{**{name: getattr(args, name) for name in DEFAULT_SETTINGS if hasattr(args, name)},
                                "trace": bool(args.trace_out)})
    try:
        result = run_attendance(model, args.video, identity_map, settings, args.gallery, cache_key,
                                annotated_out=args.annotated_out, debug_dir=args.debug_dir,
                                snapshot_dir=args.snapshot_dir, crops_dir=args.crops_dir)
    except RecognitionError as error:
        sys.exit(mask_url(error))

    trace = result.pop("trace", None)
    if args.trace_out and trace is not None:
        Path(args.trace_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.trace_out).write_text("\n".join(json.dumps(entry) for entry in trace) + "\n", encoding="utf-8")
        print(f"Saved: {args.trace_out} ({len(trace)} attempts)")
    out_path = Path(args.json_out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=1))
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()