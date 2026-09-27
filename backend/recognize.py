#!/usr/bin/env python3
"""
recognize.py - CCTV classroom attendance: given a video clip (or live stream), detect faces,
track them across frames, and recognize each track (AdaFace ir101) only as often as needed.

Setup:    pip install insightface onnxruntime opencv-python numpy gdown

Usage:
    python recognize.py --video clip.mp4
    python recognize.py --video clip.mp4 --students-json roster.json --json-out result.json --class-id 12

Folders (all next to this script, override with the matching flag):
    models/    det_10g.onnx (SCRFD detector) and adaface_ir101.onnx (recognizer) - downloaded
               automatically on first run from MODEL_URLS below
    gallery/   one sub-folder per student, e.g. gallery/yash/front.jpg, gallery/yash/left.jpg
    cache/     saved gallery embeddings per class, so they are not recomputed on every run

How a track gets marked present
--------------------------------
Detection runs every sampled frame (cheap); recognition (AdaFace) is the expensive step and is
only run on a track that is not yet resolved, up to --max-attempts times, and only on frames that
pass two free pre-checks first (big enough, not blurry). AdaFace's own feature norm (a free
by-product of every recognition call - see https://arxiv.org/abs/2204.00964) is used as a second,
post-hoc quality check: a low-norm result still counts against --max-attempts (the compute was
spent) but is not trusted as a match. A track keeps trying on later frames until it matches, or
runs out of attempts and is left unresolved for the rest of the clip.

--max-attempts bounds the cost of ONE face, not the length of the scan: a classroom almost always
has absentees, so waiting for "everyone present" to stop is not a real exit condition. --duration
is the actual scan budget - it caps how much video (in seconds of video time) gets processed,
independent of how many students have been found. Without it, a recorded file is still bounded by
its own length; a live/RTSP source is NOT (frame count is unreliable or unavailable on a stream),
so --duration should always be set for live use.

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

Node.js integration
--------------------
--students-json points at a roster file the backend writes: a JSON list of
{"student_id", "gallery_folder", "name"}. Each student is matched to gallery/<gallery_folder>/.
--class-id keys the embeddings cache so different classes never share (or fight over) one cache
file. --json-out is where the result is written: {"present_students": [...], "absent_students":
[...], "annotated_image": "<path, if --annotated-out was used>"}.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime

try:
    from insightface.app.common import Face
    from insightface.model_zoo import model_zoo
    from insightface.utils import face_align
except ImportError:
    sys.exit("InsightFace is missing. Run: pip install insightface onnxruntime opencv-python numpy")

from tracker import Tracker

# ------------------------------------------------------------------ settings
HERE = Path(__file__).resolve().parent
IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
GALLERY_DET_SIZE = (640, 640) 
MODEL_URLS = {
    "det_10g.onnx": "https://drive.google.com/file/d/1Y10_5Eb8lk8wfMOv9AZIjQb_qqyVpkry/view?usp=sharing",   
    "adaface_ir101_webface4m.onnx": "https://drive.google.com/file/d/1xKznKlLYCeCrmR_Vpfn-GDqYRCebFjLz/view?usp=sharing", 
}


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
                 f"this script, or place the file at {path} by hand.")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import gdown
    except ImportError:
        sys.exit("Model download needs gdown. Run: pip install gdown")
    print(f"  downloading {path.name} ...")
    gdown.download(url=url, output=str(path), quiet=False, fuzzy=True)
    if not path.exists():
        sys.exit(f"Could not download {path.name} from {url} - download it by hand and save it as {path}")
    return path


# -------------------------------------------------------------------- model
class AdaFaceRecognizer:
    """
    Wraps the AdaFace .onnx model so it can be used like an InsightFace recognizer: calling
    .get(image, face) fills in face.embedding AND face.quality (AdaFace's own quality score for
    that crop - see the module docstring).
    """

    def __init__(self, onnx_path):
        self.align = face_align.norm_crop  # the same 112x112 face alignment InsightFace's own recognizers use
        self.model_file = str(onnx_path)
        self.session = onnxruntime.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_names = [output.name for output in self.session.get_outputs()]
        if len(self.output_names) < 2:
            sys.exit(f"{onnx_path.name} only has one output - this script needs the (embedding, quality_norm) "
                     f"export. Re-export with two outputs.")

    def get(self, image, face):
        """Align the face to 112x112, run AdaFace, and store the embedding + quality on `face`."""
        aligned = self.align(image, landmark=face.kps, image_size=112)
        # AdaFace expects BGR pixels scaled to roughly [-1, 1]; cv2 images are already BGR
        pixels = (aligned.astype(np.float32) / 255.0 - 0.5) / 0.5
        tensor = pixels.transpose(2, 0, 1)[np.newaxis]  # HxWxC -> 1xCxHxW
        embedding, quality_norm = self.session.run(self.output_names, {self.input_name: tensor})
        face.embedding = embedding[0]  # face.normed_embedding is computed from this automatically
        face.quality = float(quality_norm[0])


class FaceModel:
    """Detector (SCRFD det_10g) + recognizer (AdaFace ir101), both loaded straight from local .onnx
    files."""

    def __init__(self, models_dir, det_size, det_thresh):
        models_dir = Path(models_dir)
        det_path = download_if_missing(models_dir / "det_10g.onnx", MODEL_URLS["det_10g.onnx"])
        rec_path = download_if_missing(models_dir / "adaface_ir101_webface4m.onnx", MODEL_URLS["adaface_ir101_webface4m.onnx"])

        self.det_size = det_size
        self.detector = model_zoo.get_model(str(det_path), providers=["CPUExecutionProvider"])
        self.detector.prepare(ctx_id=-1, input_size=det_size, det_thresh=det_thresh)  # ctx_id=-1 = CPU
        self.recognizer = AdaFaceRecognizer(rec_path)

        self.det_name, self.rec_name = det_path.stem, rec_path.stem
        self.model_mb = (det_path.stat().st_size + rec_path.stat().st_size) / 1e6

    def detect(self, image, det_size=None):
        """Find faces only - no recognition yet, and much cheaper than recognizing every one of them."""
        start = time.perf_counter()
        boxes, landmarks = self.detector.detect(image, input_size=det_size or self.det_size,
                                                max_num=0, metric="default")
        faces = [Face(bbox=boxes[i, :4], kps=landmarks[i], det_score=boxes[i, 4]) for i in range(len(boxes))]
        return faces, (time.perf_counter() - start) * 1000

    def recognize(self, image, face):
        """Compute one face's embedding + quality score. The expensive step - call this selectively."""
        start = time.perf_counter()
        self.recognizer.get(image, face)
        return (time.perf_counter() - start) * 1000

    def find_faces(self, image, det_size=None):
        """Detect AND recognize every face in one call - used only for gallery photos."""
        faces, detect_ms = self.detect(image, det_size)
        start = time.perf_counter()
        for face in faces:
            self.recognizer.get(image, face)
        return faces, detect_ms, (time.perf_counter() - start) * 1000


# ------------------------------------------------------------------ gallery
def build_gallery(model, gallery_dir, cache_key, only_folders=None):
    """
    Return (embeddings, names) with one row per gallery photo, scoped to `only_folders` when given
    (the current class's roster) so a different class's students can never win the nearest-match
    search. Cached per `cache_key` (use the class id) so classes never share or invalidate each
    other's cache.
    """
    gallery_dir = Path(gallery_dir)
    student_dirs = sorted(d for d in gallery_dir.iterdir() if d.is_dir()) if gallery_dir.is_dir() else []
    if only_folders is not None:
        student_dirs = [d for d in student_dirs if d.name in only_folders]
    photos = [(d.name, p) for d in student_dirs for p in sorted(d.iterdir()) if p.suffix.lower() in IMAGE_TYPES]
    if not photos:
        return None, None

    # A "fingerprint" of the gallery (names, sizes, dates) tells us if the cache is still valid
    fingerprint = str([(name, p.name, p.stat().st_size, int(p.stat().st_mtime)) for name, p in photos])
    cache_file = HERE / "cache" / f"gallery_{cache_key}.npz"
    if cache_file.exists():
        saved = np.load(cache_file)
        if str(saved["fingerprint"]) == fingerprint:
            print(f"  gallery: loaded {len(saved['names'])} embeddings from cache ({cache_key})")
            return saved["embeddings"], list(saved["names"])

    print(f"  gallery: computing embeddings for {len(student_dirs)} student(s) ({cache_key}) ...")
    embeddings, names = [], []
    for name, photo in photos:
        faces, _, _ = model.find_faces(load_image(photo), det_size=GALLERY_DET_SIZE)
        if not faces:
            print(f"    ! no face found in {name}/{photo.name}")
            continue
        if len(faces) > 1:
            print(f"    ! {len(faces)} faces in {name}/{photo.name}, using the largest")
        biggest = max(faces, key=lambda f: np.prod(face_size(f)))
        embeddings.append(biggest.normed_embedding)  # "normed" = scaled to length 1, so dot product = similarity
        names.append(name)

    if not embeddings:
        return None, None
    embeddings = np.stack(embeddings)  # list of 512-number arrays -> one 2D array (photos x 512)
    cache_file.parent.mkdir(exist_ok=True)
    np.savez(cache_file, embeddings=embeddings, names=np.array(names), fingerprint=np.array(fingerprint))
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


def load_cached_roi(video_path):
    """Read a region saved earlier by roi_select.py; None means use the whole frame.
    Never opens a selection window itself - this script may run headless (e.g. spawned by Node)."""
    video_path = Path(video_path)
    cache_path = video_path.with_suffix(video_path.suffix + ".roi.json")
    if cache_path.exists():
        return tuple(json.loads(cache_path.read_text())["roi"])
    return None


# ---------------------------------------------------------------- attendance
def process_frame(model, tracker, crop, gallery, identity_map, present, attempts_used, track_identity,
                  track_boxes, args, frame_index):
    """
    Feed one frame's detected faces through the tracker. For any track not yet resolved, spend up
    to --max-attempts recognition attempts (skipping frames that fail the free quality pre-checks)
    until it matches a gallery student above --threshold, or the budget runs out.

    `present` (student_id -> record), `attempts_used` (track_id -> count), `track_identity`
    (track_id -> student_id, or None once given up on), and `track_boxes` (track_id -> last known
    bbox, for the final annotated image) are all updated in place.
    Returns [(record, face), ...] for students newly marked present THIS frame.
    """
    gallery_embeddings, gallery_names = gallery
    faces, _ = model.detect(crop)
    track_ids = tracker.update([face.bbox for face in faces])

    newly_present = []
    for face, track_id in zip(faces, track_ids):
        track_boxes[track_id] = face.bbox  # keep the freshest sighting for the final annotated image

        if track_id in track_identity:
            continue  # already resolved (matched, or gave up) - nothing left to do for this track

        if attempts_used.get(track_id, 0) >= args.max_attempts:
            track_identity[track_id] = None  # give up on this track for good
            continue
        if not face_is_big_enough(face, args.min_face):
            continue  # too small to bother with - free, does not use up an attempt
        x1, y1, x2, y2 = (int(v) for v in face.bbox)
        if not crop_is_sharp_enough(crop[y1:y2, x1:x2], args.min_sharpness):
            continue  # too blurry - also free

        if gallery_embeddings is None:
            continue  # no gallery to compare against
        model.recognize(crop, face)  # the expensive step - this is what --max-attempts is limiting
        attempts_used[track_id] = attempts_used.get(track_id, 0) + 1

        if face.quality < args.min_norm:
            continue  # AdaFace itself is not confident in this crop; the attempt still counted, but ignore the result

        name, score = nearest_gallery_match(face.normed_embedding, gallery_embeddings, gallery_names)
        if score < args.threshold:
            continue  # no match on this attempt - track stays open for another try on a later frame

        identity = identity_map.get(name)
        if identity is None:
            continue  # this gallery folder has no matching roster student (see the startup warning)
        track_identity[track_id] = identity["student_id"]
        if identity["student_id"] not in present:
            record = {**identity, "best_score": round(score, 4), "frame": frame_index, "track_id": track_id}
            present[identity["student_id"]] = record
            newly_present.append((record, face))
    return newly_present


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


def save_aggregate_annotation(out_path, canvas, track_boxes, track_identity, present, identity_map):
    """
    One final image summarising the whole clip: every track's LAST known box, drawn on `canvas`
    (the most recent frame read). Green + name + similarity for a track that resolved to a
    student; red + "unmatched" for a track that used up its attempts without matching anyone.
    Tracks still mid-attempt when the clip ended (never confirmed, never given up) are skipped -
    there is nothing conclusive to report for them yet.
    """
    annotated = canvas.copy()
    by_student_id = {v["student_id"]: v for v in present.values()}
    for track_id, box in track_boxes.items():
        if track_id not in track_identity:
            continue  # still undecided when the clip ended - not a green or red verdict either way
        student_id = track_identity[track_id]
        x1, y1, x2, y2 = (int(v) for v in box)
        if student_id is None:
            color, label = (0, 0, 220), "unmatched"
        else:
            record = by_student_id.get(student_id)
            color = (0, 200, 0)
            label = f"{record.get('name') or student_id} {record['best_score']:.2f}" if record else str(student_id)
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
        cv2.putText(annotated, label, (x1, max(0, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    save_image(out_path, annotated)
    return out_path


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", required=True, help="file path, or an RTSP/HTTP stream URL for live CCTV")
    parser.add_argument("--models", default=str(HERE / "models"))
    parser.add_argument("--gallery", default=str(HERE / "gallery"))
    parser.add_argument("--students-json", default=None,
                        help="roster JSON from the backend; omit to use gallery folder names as identities directly")
    parser.add_argument("--class-id", default=None,
                        help="keys the embeddings cache so different classes never share one cache file")
    parser.add_argument("--json-out", default=str(HERE / "outputs" / "result.json"))
    parser.add_argument("--annotated-out", default=None,
                        help="save one final annotated image here (last frame, every track's box, "
                             "green=matched/red=unmatched); omit to skip")
    parser.add_argument("--threshold", type=float, default=0.26,
                        help="similarity needed for ONE recognition attempt to count as a match - "
                             "set this from calibrate.py's report, not this default")
    parser.add_argument("--max-attempts", type=int, default=5,
                        help="recognition attempts allowed per track before giving up on it")
    parser.add_argument("--every", type=int, default=36, help="process every Nth frame")
    parser.add_argument("--duration", type=float, default=20,
                        help="stop after this many seconds of video time, regardless of who has been "
                             "found - the real scan budget. Always set this for a live/RTSP source; "
                             "for a recorded file, omitting it just falls back to the file's own length")
    parser.add_argument("--det-size", default="1920x1080")
    parser.add_argument("--det-thresh", type=float, default=0.3)
    parser.add_argument("--min-face", type=int, default=0,
                        help="skip faces shorter than this (px) on either side - free, no attempt spent")
    parser.add_argument("--min-sharpness", type=float, default=0.0,
                        help="skip blurry crops below this Laplacian-variance score - free, no attempt spent; "
                             "tune on your own footage")
    parser.add_argument("--min-norm", type=float, default=0.0,
                        help="ignore a recognition attempt if AdaFace's own quality score is below this "
                             "(the attempt still counts against --max-attempts); 0 = disabled until calibrated")
    parser.add_argument("--start", type=float, default=0.0, help="seconds into the clip to start at")
    parser.add_argument("--debug-dir", default=None, help="save a snapshot of each newly-confirmed match here")
    return parser.parse_args()


def main():
    args = parse_args()
    det_size = parse_det_size(args.det_size)

    print("Loading models ...")
    model = FaceModel(args.models, det_size, args.det_thresh)

    if args.students_json:
        roster = load_roster(args.students_json)
        identity_map = build_identity_map(roster)
        cache_key = args.class_id or "roster_" + str(abs(hash(tuple(sorted(identity_map)))))
    else:
        gallery_dir = Path(args.gallery)
        all_folders = [d.name for d in gallery_dir.iterdir() if d.is_dir()] if gallery_dir.is_dir() else []
        identity_map = {name: {"student_id": name, "name": name} for name in all_folders}
        cache_key = "all"
    gallery = build_gallery(model, args.gallery, cache_key, only_folders=set(identity_map))
    if gallery[0] is None:
        sys.exit(f"No gallery found for this roster in {args.gallery} - see this script's docstring "
                 f"for the expected layout.")

    target_ids = {identity["student_id"] for identity in identity_map.values()}
    print(f"  {len(target_ids)} enrollable student(s) to look for")

    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        sys.exit(f"Could not open video: {args.video}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames <= 0 and args.duration is None:
        print("  warning: this source doesn't report a frame count (likely a live stream) and "
             "--duration wasn't set - this run will not stop on its own until the stream ends.")

    roi = load_cached_roi(args.video)
    if roi is None:
        ok, probe_frame = capture.read()
        roi = (0, 0, probe_frame.shape[1], probe_frame.shape[0]) if ok else (0, 0, 0, 0)
        capture.release()
        capture = cv2.VideoCapture(str(args.video))  # re-open: we consumed the probe frame above
    roi_x, roi_y, roi_w, roi_h = roi
    end_time = args.start + args.duration if args.duration is not None else None
    print(f"  video: {fps:.1f} fps; region {roi_w}x{roi_h}; sampling every {args.every} frames "
         f"from t={args.start:.1f}s" + (f" to t={end_time:.1f}s" if end_time else " to end of source"))

    tracker = Tracker()
    present, attempts_used, track_identity, track_boxes = {}, {}, {}, {}
    started = time.perf_counter()
    frame_no, processed, last_crop = 0, 0, None

    # Sequential read + skip (no seeking): works the same for a recorded file and a live/RTSP
    # stream, where seeking to an arbitrary frame index either fails or is meaningless.
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frame_no += 1
        t = frame_no / fps
        if t < args.start:
            continue
        if end_time is not None and t >= end_time:
            print(f"  reached --duration ({args.duration:.1f}s of video) - stopping")
            break
        if frame_no % args.every != 0:
            continue

        crop = frame[roi_y:roi_y + roi_h, roi_x:roi_x + roi_w]
        last_crop = crop
        newly_present = process_frame(model, tracker, crop, gallery, identity_map, present, attempts_used,
                                      track_identity, track_boxes, args, frame_no)
        for record, face in newly_present:
            print(f"  frame {frame_no} (t={t:.1f}s): "
                 f"{record.get('name') or record['student_id']} present (score {record['best_score']:.2f})")
            if args.debug_dir:
                save_debug_snapshot(args.debug_dir, crop, face, record)

        processed += 1
        if target_ids and set(present) >= target_ids:
            print(f"  everyone present at t={t:.1f}s - stopping early")
            break
    capture.release()
    elapsed = time.perf_counter() - started

    present_students = list(present.values())
    seen_ids = set(present)
    absent_students = [identity for identity in identity_map.values() if identity["student_id"] not in seen_ids]

    result = {"video": str(args.video), "processed_frames": processed, "elapsed_seconds": round(elapsed, 1),
             "present_students": present_students, "absent_students": absent_students}

    if args.annotated_out and last_crop is not None:
        out_path = save_aggregate_annotation(args.annotated_out, last_crop, track_boxes, track_identity,
                                             present, identity_map)
        result["annotated_image"] = str(out_path)
        print(f"  annotated image: {out_path}")

    out_path = Path(args.json_out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=1))

    print(f"\n{len(present_students)}/{len(target_ids)} present, {processed} frame(s) processed in {elapsed:.1f}s")
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()
