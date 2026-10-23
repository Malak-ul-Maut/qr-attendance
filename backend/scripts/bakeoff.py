#!/usr/bin/env python3
"""
bakeoff.py (v2) - which recognizer, and which settings, work best on YOUR cameras and YOUR students? Measure, don't guess.

    python scripts/bakeoff.py all --videos ./*.avi --models-to-test A.onnx B.onnx C.onnx      (the whole study)
    python scripts/bakeoff.py plan --videos ...      what will be embedded, and roughly how long it takes (no models are run)
    python scripts/bakeoff.py selftest               known-answer checks of the statistics: run this FIRST, it takes seconds

or step by step (each step resumes where it stopped and reuses what it already computed):

  prep        sample frames of each clip, detect (permissively) and track every face once          -> work/clips/<clip>/dets.json
  label       name every face ONCE per clip (frame A), then confirm the propagated names on later frames (B...). Per face:
                  part of a name / roll number   an enrolled student          x   a real face, NOT enrolled (an impostor)
                  n   not a face (false detection)  ?   unsure (left out)      a   add a face the detector missed (draw its box)
                  xx  every remaining face in this frame is not enrolled       Enter  skip (or keep / accept the suggestion)
              Label EVERY face you can: x and n faces are what the false-accept rate is measured on.
  audit       re-ask a random 10% of your labels (blind) -> agreement and kappa: how noisy are the labels themselves?
  models      PART 1 - which recognizer separates your students best?            -> work/reports/models.md
  sweep       PART 2 - on the chosen model: crop / gallery / pooling / decision settings. Settings are chosen on the TUNE clips only
              (leave-one-clip-out for the decision settings), then scored ONCE on the held-out TEST clips
                                                                                 -> work/reports/sweep.md, work/settings.<model>.json
  adjudicate  show the few faces the system named that you never labelled; answer y/n once
  detector    detector size / threshold vs ALL labelled faces incl. hand-added ones, by face width and zone
  tracker     tracker settings at the PRODUCTION frame cadence, over every scan window
  all         everything above, then work/reports/FINAL.md: the decision, the evidence, and which trust checks passed

Honesty rules built in
  * intervals resample CLIPS and STUDENTS (impostors: tracks) together; every comparison is paired and Holm-corrected; verdicts are
    better / worse / equivalent / inconclusive, with the minimum detectable difference printed;
  * settings are chosen on the tune clips and scored on the held-out test clips, never the other way round;
  * the decision replay runs like production: every Nth frame, a 10 s scan, several start offsets, the tracker re-run at that
    cadence, and EVERY embedded face (students, impostors, unlabelled) takes part;
  * saved CCTV crops are NOT used in the gallery unless you pass --use-cctv (they may come from the clips being tested).
"""
import argparse
import glob
import hashlib
import json
import platform
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bakeoff_lib as L  # noqa: E402
import crop_ops  # noqa: E402
import recognize  # noqa: E402
from enroll_qa import SELF_PHOTO  # noqa: E402
from gallery_extras import degrade_photo, is_cctv_crop  # noqa: E402
from tracker import Tracker  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
DEGRADE_WIDTHS = (20, 28, 36)
GALLERY_EXTRACT_VERSION = "1"
EXTRACT_VERSION = "2"
SCHEMA = 2


# ============================================================================================ workspace
class Work:
    """All files of one bakeoff live under one folder."""

    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def clip_dir(self, clip):
        d = self.root / "clips" / clip
        d.mkdir(parents=True, exist_ok=True)
        return d

    def frame_path(self, clip, pos):
        return self.clip_dir(clip) / "frames" / f"{pos:05d}.jpg"

    def _json(self, path, default=None):
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default

    def clips(self):
        return self._json(self.root / "clips.json", {})

    def save_clips(self, clips):
        (self.root / "clips.json").write_text(json.dumps(clips, indent=1), encoding="utf-8")

    def dets(self, clip):
        data = self._json(self.clip_dir(clip) / "dets.json")
        if data and data.get("schema") != SCHEMA:
            sys.exit(f"{clip}: prepared by an older bakeoff.py (schema {data.get('schema')}); re-run `prep --force` and `label --redo`.")
        return data

    def labels(self, clip):
        data = self._json(self.clip_dir(clip) / "labels.json")
        if not data:
            return None
        data["labels"] = {int(k): v for k, v in data.get("labels", {}).items()}
        data["sources"] = {int(k): v for k, v in data.get("sources", {}).items()}
        data["verified"] = set(int(t) for t in data.get("verified", []))
        data["first_answers"] = {int(k): v for k, v in data.get("first_answers", {}).items()}
        data["verify_answers"] = {int(p): {int(k): v for k, v in a.items()} for p, a in data.get("verify_answers", {}).items()}
        data.setdefault("manual", [])
        data.setdefault("audit", None)
        return data

    def save_labels(self, clip, data):
        out = dict(data)
        out["verified"] = sorted(data.get("verified", []))
        out["schema"] = SCHEMA
        (self.clip_dir(clip) / "labels.json").write_text(json.dumps(out, indent=1), encoding="utf-8")

    def labels_stamp(self, clip):
        path = self.clip_dir(clip) / "labels.json"
        return hashlib.sha1(path.read_bytes()).hexdigest()[:12] if path.exists() else "none"

    def adjudications(self):
        raw = self._json(self.root / "adjudications.json", {})
        out = {}
        for key, value in raw.items():
            clip, track, student = key.split("|", 2)
            out[(clip, int(track), student)] = value
        return out

    def save_adjudications(self, data):
        raw = {f"{c}|{t}|{s}": v for (c, t, s), v in data.items()}
        (self.root / "adjudications.json").write_text(json.dumps(raw, indent=1), encoding="utf-8")

    def reports(self):
        d = self.root / "reports"
        d.mkdir(parents=True, exist_ok=True)
        return d


def make_model(args, rec_filename, crop_config=None, det_thresh=None):
    return recognize.FaceModel(args.models, recognize.parse_det_size(args.det_size), args.det_thresh if det_thresh is None else det_thresh,
                               rec_filename, crop_config=crop_config)


MODEL_FACTORY = make_model  # tests replace this with a fake


def model_dirname(model):
    return f"{model.rec_name}-{model.rec_fingerprint}"


def cfg_dirname(cfg):
    return hashlib.sha1(cfg.signature().encode()).hexdigest()[:10]


def sharpness(image, bbox):
    x1, y1, x2, y2 = (max(0, int(v)) for v in bbox)
    crop = image[y1:y2, x1:x2]
    if crop.size == 0:
        return 0.0
    return float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())


def split_clips(clips, test_clips=None):
    """(tune clips, test clips). Default: every third clip (2nd, 5th, ...) is held out, so the test clips are spread over rooms and
    times instead of being 'the last ones'. With fewer than 3 clips nothing is held out and the report says so."""
    names = sorted(clips)
    if test_clips:
        test = [c for c in names if c in set(test_clips)]
    else:
        test = names[2::3] if len(names) >= 3 else []
    return [c for c in names if c not in test], test


def stride_of(args):
    if args.every % args.step:
        sys.exit(f"--every {args.every} must be a multiple of --step {args.step} (production's cadence is built from the sampled frames)")
    return args.every // args.step


def window_frames_for(args, fps):
    return max(2, int(round(args.scan_seconds * fps / args.every)))


def hop_frames_for(args, fps):
    return max(1, int(round(args.window_hop * fps / args.every)))


def tracker_params(args):
    return {"assignment": args.tracker_assignment, "iou_threshold": args.tracker_iou, "max_center_dist": args.tracker_dist,
            "max_missed": args.tracker_missed}


# ============================================================================================ prep
def cmd_prep(args, work):
    model = MODEL_FACTORY(args, args.rec_model, det_thresh=args.prep_thresh)
    clips = work.clips()
    for video in args.videos:
        clip = Path(video).stem
        if (work.clip_dir(clip) / "dets.json").exists() and not args.force:
            print(f"  {clip}: already prepared")
            continue
        cap = cv2.VideoCapture(str(video))
        if not cap.isOpened():
            print(f"  ! cannot open {video}")
            continue
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        limit = min(total, int(args.seconds * fps)) if args.seconds else total
        tracker = Tracker(assignment=args.assignment)
        frames, size = [], None
        (work.clip_dir(clip) / "frames").mkdir(exist_ok=True)
        index = 0
        while index < limit:
            ok, frame = cap.read()
            if not ok:
                break
            if index % args.step == 0:
                size = [frame.shape[1], frame.shape[0]]
                faces, _ = model.detect(frame)
                ids = tracker.update([f.bbox for f in faces])
                pos = len(frames)
                cv2.imwrite(str(work.frame_path(clip, pos)), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
                frames.append({"pos": pos, "idx": index, "dets": [
                    {"bbox": [float(v) for v in f.bbox], "kps": np.asarray(f.kps, dtype=float).tolist(),
                     "det": float(f.det_score), "track": int(t)} for f, t in zip(faces, ids)]})
            index += 1
        cap.release()
        data = {"schema": SCHEMA, "video": str(Path(video).resolve()), "fps": fps, "step": args.step, "size": size, "frames": frames,
                "det_size": args.det_size, "prep_thresh": args.prep_thresh}
        (work.clip_dir(clip) / "dets.json").write_text(json.dumps(data), encoding="utf-8")
        clips[clip] = {"video": data["video"], "fps": fps, "step": args.step, "n_frames": len(frames)}
        n_tracks = len({d["track"] for fr in frames for d in fr["dets"]})
        print(f"  {clip}: {len(frames)} frames sampled, {n_tracks} tracks (detector threshold {args.prep_thresh})")
    work.save_clips(clips)


# ============================================================================================ labelling
def prompt_for_label(roster, ask=input, say=print, current=None, suggestion=None, allow_add=True):
    """
    Ask about ONE face. Returns (kind, value, source): ('label', value, 'typed'|'suggested'|'kept') | ('skip', None, None)
    | ('rest_x', None, None) | ('add', None, None) | ('quit', None, None).
    """
    hint = []
    if current not in (None, ""):
        hint.append(f"Enter = keep '{current}'")
    elif suggestion:
        hint.append(f"Enter = accept suggestion {suggestion[0]} ({suggestion[1]:.2f})")
    else:
        hint.append("Enter = skip")
    extra = "; a add missed face" if allow_add else ""
    while True:
        text = ask(f"    who? [{'; '.join(hint)}; ? unsure; x not enrolled; n not a face; xx all remaining not enrolled{extra}; q quit] > ").strip()
        if text == "":
            if current not in (None, ""):
                return "label", current, "kept"
            if suggestion:
                return "label", suggestion[0], "suggested"
            return "skip", None, None
        low = text.lower()
        if low == "q":
            return "quit", None, None
        if low == "xx":
            return "rest_x", None, None
        if low == "a" and allow_add:
            return "add", None, None
        if text in ("?", "x", "n"):
            return "label", text, "typed"
        matches = roster.search(text)
        if not matches:
            say("    no student matches that, try again")
        elif len(matches) == 1:
            return "label", matches[0], "typed"
        else:
            for i, m in enumerate(matches, 1):
                say(f"      {i}. {m}")
            pick = ask("    number (or Enter to search again) > ").strip()
            if pick.isdigit() and 1 <= int(pick) <= len(matches):
                return "label", matches[int(pick) - 1], "typed"


class Display:
    """Shows the frame with numbered boxes and a zoomed view of the face being asked about. Falls back to a jpg file."""

    def __init__(self, work, gui=True):
        self.path = work.root / "label_view.jpg"
        self.gui = gui
        self.window = "bakeoff label"
        self.window_created = False

    def show(self, image, frame, highlight, names, extra_boxes=()):
        out = image.copy()
        scale = max(1.0, image.shape[1] / 1600)
        for i, det in enumerate(frame["dets"]):
            x1, y1, x2, y2 = (int(v) for v in det["bbox"])
            color = (0, 255, 255) if i == highlight else (0, 200, 0)
            cv2.rectangle(out, (x1, y1), (x2, y2), color, max(1, int(scale)) + (1 if i == highlight else 0))
            tag = str(i + 1) + (f" {names.get(i)}" if names.get(i) else "")
            cv2.putText(out, tag[:22], (x1, max(12, y1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * scale, color, 1, cv2.LINE_AA)
        for box, label in extra_boxes:
            x1, y1, x2, y2 = (int(v) for v in box)
            cv2.rectangle(out, (x1, y1), (x2, y2), (255, 0, 255), max(1, int(scale)))
            cv2.putText(out, f"+ {label}"[:22], (x1, max(12, y1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * scale, (255, 0, 255), 1, cv2.LINE_AA)
        if highlight is not None:
            x1, y1, x2, y2 = (int(v) for v in frame["dets"][highlight]["bbox"])
            pad = int(0.4 * max(x2 - x1, y2 - y1))
            zoom = image[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
            if zoom.size:
                side = max(1, min(240, out.shape[0], out.shape[1]))
                out[0:side, 0:side] = cv2.resize(zoom, (side, side), interpolation=cv2.INTER_CUBIC)
        if self.gui:
            try:
                preview_scale = min(1.0, 1280 / out.shape[1], 720 / out.shape[0])
                preview = cv2.resize(out, (int(out.shape[1] * preview_scale), int(out.shape[0] * preview_scale)),
                                     interpolation=cv2.INTER_AREA) if preview_scale < 1.0 else out
                if not self.window_created:
                    cv2.namedWindow(self.window, cv2.WINDOW_NORMAL)
                    self.window_created = True
                cv2.imshow(self.window, preview)
                cv2.resizeWindow(self.window, preview.shape[1], preview.shape[0])
                cv2.waitKey(1)
                return
            except cv2.error:
                self.gui = False
        cv2.imwrite(str(self.path), out)


def select_roi_box(image, display):
    """Let the labeller draw a box around a face the detector missed. Returns [x1,y1,x2,y2] or None. Replaced in tests."""
    if not display.gui:
        return None
    try:
        x, y, w, h = cv2.selectROI("draw the missed face, then Enter (Esc cancels)", image, showCrosshair=False)
        cv2.destroyWindow("draw the missed face, then Enter (Esc cancels)")
    except cv2.error:
        return None
    return [float(x), float(y), float(x + w), float(y + h)] if w > 0 and h > 0 else None


def ask_about_frame(frame, image, roster, display, ask, say, current_labels=None, suggestions=None, title="", only=None, roi=select_roi_box):
    """
    Walk through the boxes of one frame. Returns (answers {det index: label|None}, sources {det index: how}, manual [{bbox,label}], quit?).
    `only(det)` (verify frames) limits which boxes are asked about.
    """
    answers, sources, manual, quit_ = {}, {}, [], False
    shown = {i: current_labels.get(d["track"]) if current_labels else None for i, d in enumerate(frame["dets"])}
    todo = [i for i, d in enumerate(frame["dets"]) if only is None or only(d)]
    say(f"\n{title}: {len(todo)} faces to name. Look at the window (or {display.path}).")
    for n, i in enumerate(todo):
        det = frame["dets"][i]
        while True:
            display.show(image, frame, i, {k: v for k, v in {**shown, **{k: v for k, v in answers.items() if v}}.items()},
                         [(m["bbox"], m["label"]) for m in manual])
            say(f"  face {n + 1}/{len(todo)} (id {i + 1}, width {det['bbox'][2] - det['bbox'][0]:.0f}px, detector score {det['det']:.2f})")
            kind, value, source = prompt_for_label(roster, ask, say, current=shown.get(i) if current_labels else None,
                                                   suggestion=(suggestions or {}).get(i), allow_add=roi is not None)
            if kind == "add":
                box = roi(image, display)
                if box is None:
                    say("    no box drawn")
                    continue
                k2, v2, _ = prompt_for_label(roster, ask, say, allow_add=False)
                if k2 == "label":
                    manual.append({"bbox": box, "label": v2})
                continue
            break
        if kind == "quit":
            quit_ = True
            break
        if kind == "rest_x":
            rest = [j for j in todo[n:] if answers.get(j) is None]
            if ask(f"    mark {len(rest)} remaining faces as x (not enrolled)? [y/N] > ").strip().lower() == "y":
                for j in rest:
                    answers[j], sources[j] = "x", "typed"
                break
            continue
        answers[i] = value if kind == "label" else None
        if kind == "label":
            sources[i] = source
    return answers, sources, manual, quit_


def cmd_label(args, work, ask=None, say=print, roi=select_roi_box):
    ask = ask or input
    folders = [d.name for d in Path(args.gallery).iterdir() if d.is_dir()]
    roster = L.Roster(folders)
    display = Display(work, gui=not args.no_gui)
    for clip in sorted(work.clips()):
        data = work.labels(clip)
        if data and data.get("done") and not args.redo:
            continue
        dets = work.dets(clip)
        frames = dets["frames"]
        if not any(f["dets"] for f in frames):
            say(f"  {clip}: no faces found, skipped")
            continue
        first_pos, verify_pos = L.choose_label_frames(frames, args.verify_frames)
        data = data if (data and not args.redo) else {"labels": {}, "sources": {}, "verified": set(), "first_answers": {}, "verify_answers": {},
                                                      "swaps": [], "manual": [], "audit": None}
        data.update({"first_pos": first_pos, "verify_pos": verify_pos, "done": False})
        if not data["first_answers"]:
            image = cv2.imread(str(work.frame_path(clip, first_pos)))
            suggestions = args._suggestions(clip, first_pos) if getattr(args, "_suggestions", None) else None
            answers, sources, manual, quit_ = ask_about_frame(frames[first_pos], image, roster, display, ask, say, suggestions=suggestions,
                                                              title=f"{clip} - frame A (position {first_pos})", roi=roi)
            for note in L.apply_first_labels(data["labels"], frames[first_pos], answers, data["sources"], sources):
                say("  note: " + note)
            data["first_answers"] = {i: a for i, a in answers.items() if a is not None}
            data["manual"] += [{"pos": first_pos, **m} for m in manual]
            work.save_labels(clip, data)
            if quit_:
                return
        for vpos in verify_pos:
            if str(vpos) in {str(k) for k in data["verify_answers"]}:
                continue
            image = cv2.imread(str(work.frame_path(clip, vpos)))
            answers, sources, manual, quit_ = ask_about_frame(
                frames[vpos], image, roster, display, ask, say, current_labels=data["labels"],
                title=f"{clip} - frame B (position {vpos}); Enter keeps the name shown",
                only=lambda d: L.is_student_label(data["labels"].get(d["track"])), roi=roi)
            report = L.apply_verify_labels(data["labels"], frames[vpos], answers, data["verified"])
            data["verify_answers"][vpos] = {i: a for i, a in answers.items() if a is not None}
            data["swaps"] += report["swaps"]
            data["manual"] += [{"pos": vpos, **m} for m in manual]
            say(f"  check: {report['agree']}/{report['checked']} names agreed, {len(report['swaps'])} tracks dropped as swap suspects")
            work.save_labels(clip, data)
            if quit_:
                return
        data["done"] = True
        work.save_labels(clip, data)
        say(f"  {clip}: {len(L.student_labels(data['labels']))} student tracks, {len(L.impostor_labels(data['labels']))} impostor tracks, "
            f"{len(data['manual'])} hand-added faces")
    if display.gui:
        cv2.destroyAllWindows()


def cmd_audit(args, work, ask=None, say=print):
    ask = ask or input
    """Re-ask a random share of the labels WITHOUT showing the old answer; agreement and kappa say how noisy the labels are."""
    folders = [d.name for d in Path(args.gallery).iterdir() if d.is_dir()]
    roster = L.Roster(folders)
    display = Display(work, gui=not args.no_gui)
    rng = np.random.default_rng(args.seed)
    for clip in sorted(work.clips()):
        data = work.labels(clip)
        if not data or not data.get("done") or (data.get("audit") and not args.redo):
            continue
        frames = work.dets(clip)["frames"]
        frame = frames[data["first_pos"]]
        tracks = [d["track"] for d in frame["dets"] if data["labels"].get(d["track"]) not in (None, "", "?")]
        pick = set(rng.choice(tracks, size=max(1, int(round(args.audit_fraction * len(tracks)))), replace=False).tolist()) if tracks else set()
        if not pick:
            continue
        image = cv2.imread(str(work.frame_path(clip, data["first_pos"])))
        answers, _, _, quit_ = ask_about_frame(frame, image, roster, display, ask, say, title=f"{clip} AUDIT (answer blind)",
                                               only=lambda d: d["track"] in pick, roi=None)
        second = {frame["dets"][i]["track"]: a for i, a in answers.items() if a is not None}
        agree, kappa, n = L.label_agreement({t: data["labels"][t] for t in second}, second)
        data["audit"] = {"n": n, "agreement": agree, "kappa": kappa, "disagreements": [
            {"track": t, "first": data["labels"][t], "second": second[t]} for t in second if second[t] != data["labels"][t]]}
        work.save_labels(clip, data)
        say(f"  {clip}: {n} re-labelled, agreement {agree:.0%}, kappa {kappa:.2f}")
        if quit_:
            return


# ============================================================================================ extraction
def _unit(v):
    return v / max(float(np.linalg.norm(v)), 1e-9)


def look_tag(per_track, include_unknown):
    return "full" if (per_track is None and include_unknown) else f"k{per_track or 'all'}{'u' if include_unknown else ''}"


def target_detections(work, clip, args, per_track=None, include_unknown=True):
    """[(frame dict, detection dict, label)] to embed for one clip, in time order. Only frames on the PRODUCTION cadence (every Nth
    sampled frame) and detections above --embed-thresh. Labelled tracks (student / x / n) are capped at `per_track` looks each."""
    dets, ldata = work.dets(clip), work.labels(clip)
    labels = ldata["labels"] if ldata else {}
    stride = stride_of(args)
    taken, out = {}, []
    for frame in dets["frames"]:
        if frame["pos"] % stride:
            continue
        for d in frame["dets"]:
            if d["det"] < args.embed_thresh:
                continue
            label = labels.get(d["track"])
            known = label not in (None, "", "?")
            if not known and not include_unknown:
                continue
            if per_track is not None and known:
                if taken.get(d["track"], 0) >= per_track:
                    continue
                taken[d["track"]] = taken.get(d["track"], 0) + 1
            out.append((frame, d, label))
    return out


def looks_stamp(work, clip, args, per_track, include_unknown):
    dets_path = work.clip_dir(clip) / "dets.json"
    stat = dets_path.stat()
    text = repr([EXTRACT_VERSION, stat.st_size, stat.st_mtime_ns, work.labels_stamp(clip), args.embed_thresh, stride_of(args),
                 per_track, include_unknown])
    return hashlib.sha1(text.encode()).hexdigest()[:16]


def cap_per_track(arrays, per_track, include_unknown):
    """Subset of a 'full' looks dict that a capped extraction would have produced (first K looks of each labelled track)."""
    labels = arrays["label"]
    known = np.array([l not in ("", "?", None) for l in labels])
    keep = np.zeros(len(labels), bool)
    seen = {}
    order = np.lexsort((np.arange(len(labels)), arrays["frame"]))
    for i in order:
        if known[i]:
            if per_track is not None and seen.get(int(arrays["track"][i]), 0) >= per_track:
                continue
            seen[int(arrays["track"][i])] = seen.get(int(arrays["track"][i]), 0) + 1
            keep[i] = True
        elif include_unknown:
            keep[i] = True
    return {k: v[keep] for k, v in arrays.items()}


def extract_clip_looks(work, model, clip, args, per_track, include_unknown):
    rows = {k: [] for k in ("track", "frame", "emb", "norm", "sharp", "width", "height", "det", "label", "bbox")}
    by_frame = {}
    for frame, d, label in target_detections(work, clip, args, per_track, include_unknown):
        by_frame.setdefault(frame["pos"], []).append((d, label))
    for pos in sorted(by_frame):
        todo = by_frame[pos]
        image = cv2.imread(str(work.frame_path(clip, pos)))
        faces = [SimpleNamespace(bbox=np.asarray(d["bbox"]), kps=np.asarray(d["kps"], dtype=np.float32)) for d, _ in todo]
        model.recognizer.get_batch(image, faces, role="cctv")
        for (d, label), f in zip(todo, faces):
            rows["track"].append(d["track"]); rows["frame"].append(pos)
            rows["emb"].append(_unit(np.asarray(f.embedding, dtype=np.float32))); rows["norm"].append(float(f.quality))
            rows["sharp"].append(sharpness(image, d["bbox"])); rows["width"].append(d["bbox"][2] - d["bbox"][0])
            rows["height"].append(d["bbox"][3] - d["bbox"][1]); rows["det"].append(d["det"])
            rows["label"].append(label or ""); rows["bbox"].append(d["bbox"])
    dim = model.recognizer.dim
    return {"track": np.array(rows["track"], dtype=int), "frame": np.array(rows["frame"], dtype=int),
            "emb": np.stack(rows["emb"]) if rows["emb"] else np.zeros((0, dim), np.float32),
            "norm": np.array(rows["norm"], dtype=float), "sharp": np.array(rows["sharp"], dtype=float),
            "width": np.array(rows["width"], dtype=float), "height": np.array(rows["height"], dtype=float),
            "det": np.array(rows["det"], dtype=float), "label": np.array(rows["label"], dtype=object),
            "bbox": np.array(rows["bbox"], dtype=float).reshape(-1, 4)}


def get_looks(work, model, cfg, clips, args, per_track=None, include_unknown=True, log=print):
    """
    Embeddings of the faces of `clips` with (model, crop setting `cfg`). per_track=K: only the first K looks of each LABELLED track
    (students, x, n) - enough for look-level metrics, and cheap; per_track=None + include_unknown: every face (what the decision replay
    needs). Results are cached per clip together with a stamp of the labels and detections they came from, so relabelling or a new
    threshold can never reuse stale embeddings. A capped request is cut from an existing 'full' file when there is one.
    """
    model.recognizer.crop_config = cfg
    folder = work.root / "emb" / model_dirname(model) / cfg_dirname(cfg)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "config.json").write_text(json.dumps({"crop": cfg.as_dict(), "label": cfg.label(), "tag": model.cache_tag}), encoding="utf-8")
    tag = look_tag(per_track, include_unknown)
    parts = []
    for clip in clips:
        if not work.labels(clip):
            continue
        path, full_path = folder / f"{clip}.{tag}.npz", folder / f"{clip}.full.npz"
        stamp = looks_stamp(work, clip, args, per_track, include_unknown)
        arrays = None
        if path.exists():
            z = np.load(path, allow_pickle=True)
            if str(z["stamp"]) == stamp:
                arrays = {k: z[k] for k in z.files if k != "stamp"}
        if arrays is None and tag != "full" and full_path.exists():
            z = np.load(full_path, allow_pickle=True)
            if str(z["stamp"]) == looks_stamp(work, clip, args, None, True):
                arrays = cap_per_track({k: z[k] for k in z.files if k != "stamp"}, per_track, include_unknown)
        if arrays is None:
            arrays = extract_clip_looks(work, model, clip, args, per_track, include_unknown)
            np.savez(path, stamp=np.array(stamp), **arrays)
        if len(arrays["track"]):
            parts.append({**arrays, "clip": np.array([clip] * len(arrays["track"]), dtype=object)})
    if not parts:
        return None
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def photo_rows(model, photo, widths):
    """[(unit embedding, tag)]: the photo itself ('photo') and its CCTV-quality copies ('deg20', ...)."""
    image = recognize.load_image(photo)
    if is_cctv_crop(photo):
        if image.shape[:2] != (112, 112):
            image = cv2.resize(image, (112, 112), interpolation=cv2.INTER_AREA)
        emb, _ = model.recognizer.embed_aligned([image], role="cctv")
        return [(_unit(emb[0]), "photo")]
    faces, _, _ = model.find_faces(image, det_size=recognize.GALLERY_DET_SIZE)
    if not faces:
        return []
    biggest = max(faces, key=lambda f: np.prod(recognize.face_size(f)))
    rows = [(_unit(biggest.normed_embedding), "photo")]
    width = recognize.face_size(biggest)[0]
    for w in widths:
        degraded = degrade_photo(image, biggest.kps, width, w)
        if degraded is not None:
            small, kps = degraded
            rows.append((_unit(model.recognizer.embed_with_kps(small, kps, role="cctv")[0]), f"deg{w}"))
    return rows


def photo_kind(photo):
    return "cctv" if is_cctv_crop(photo) else "self" if SELF_PHOTO.match(photo.name) else "reference"


def shot_of(photo):
    meta = photo.parent / "self_meta.dat"
    if not meta.exists():
        return ""
    try:
        return json.loads(meta.read_text(encoding="utf-8")).get("files", {}).get(photo.name, {}).get("shot", "") or ""
    except (OSError, ValueError):
        return ""


def extract_gallery(work, model, cfg, gallery_dir, force=False, log=print):
    """Every gallery photo -> rows (embedding, student folder, kind, tag, shot), with a per-photo cache."""
    model.recognizer.crop_config = cfg
    folder = work.root / "gallery" / model_dirname(model) / cfg_dirname(cfg)
    folder.mkdir(parents=True, exist_ok=True)
    out = folder / "gallery.npz"
    photos = recognize.gallery_photos(gallery_dir)
    stamp = hashlib.sha1(repr([GALLERY_EXTRACT_VERSION, DEGRADE_WIDTHS] + [(n, p.name, p.stat().st_size, p.stat().st_mtime_ns)
                                                                           for n, p in photos]).encode()).hexdigest()
    if out.exists() and not force:
        z = np.load(out, allow_pickle=True)
        if str(z["stamp"]) == stamp:
            return {k: z[k] for k in ("emb", "student", "kind", "tag", "shot")}
    emb, student, kind, tag, shot = [], [], [], [], []
    done = skipped = 0
    for name, photo in photos:
        key = hashlib.sha1(f"{GALLERY_EXTRACT_VERSION}|{photo.resolve()}|{photo.stat().st_size}|{photo.stat().st_mtime_ns}".encode()).hexdigest()
        cache = folder / "photos" / name / f"{key}.npz"
        if cache.exists():
            z = np.load(cache, allow_pickle=True)
            rows = list(zip(z["emb"], [str(t) for t in z["tags"]])) if len(z["tags"]) else []
        else:
            try:
                rows = photo_rows(model, photo, DEGRADE_WIDTHS)
            except Exception as error:  # a damaged picture is skipped, never fatal
                log(f"  gallery: skipped {name}/{photo.name} ({type(error).__name__}: {error})")
                continue
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.savez(cache, emb=np.stack([r[0] for r in rows]) if rows else np.zeros((0, model.recognizer.dim), np.float32),
                     tags=np.array([r[1] for r in rows], dtype=object))
            done += 1
        if not rows:
            skipped += 1
        for e, t in rows:
            emb.append(e); student.append(name); kind.append(photo_kind(photo)); tag.append(t); shot.append(shot_of(photo))
    log(f"  gallery [{cfg.label()}]: {len(set(student))} students, {len(emb)} rows ({done} photos embedded now, {skipped} photos without a face)")
    data = {"emb": np.stack(emb) if emb else np.zeros((0, model.recognizer.dim), np.float32),
            "student": np.array(student, dtype=object), "kind": np.array(kind, dtype=object),
            "tag": np.array(tag, dtype=object), "shot": np.array(shot, dtype=object)}
    np.savez(out, stamp=np.array(stamp), **data)
    return data


def quality_mode_for(model_file, models_dir):
    """Pooling weights: the feature norm only means 'quality' for AdaFace-trained models (see <model>.onnx.json)."""
    try:
        meta = json.loads((Path(models_dir) / (model_file + ".json")).read_text(encoding="utf-8"))
        if meta.get("norm_is_quality_hint") is False:
            return "equal"
    except (OSError, ValueError):
        pass
    return "norm"


def recipe_for(args, name="clean"):
    recipe = dict(L.RECIPES[name])
    if not args.use_cctv:
        recipe["kinds"] = set(recipe["kinds"]) - {"cctv"}
    return recipe


def score(looks, gallery, recipe, aggregator="max"):
    emb, names = L.apply_recipe(gallery, recipe)
    return L.genuine_impostor(looks["emb"], looks["label"], emb, names, aggregator)


def prepare(args, work, model, cfg, clips, per_track=None, include_unknown=True):
    """(looks, gallery) ready for scoring for one (model, crop setting)."""
    looks = get_looks(work, model, cfg, clips, args, per_track, include_unknown)
    return looks, extract_gallery(work, model, cfg, args.gallery)


def time_model(model, work, clips, args, runs=3):
    """ms per face of the recognizer on a real frame (the production engine, device and precision, whatever they are)."""
    try:
        for clip in clips:
            dets = work.dets(clip)
            for frame in dets["frames"]:
                good = [d for d in frame["dets"] if d["det"] >= args.det_thresh]
                if len(good) >= 8:
                    image = cv2.imread(str(work.frame_path(clip, frame["pos"])))
                    faces = [SimpleNamespace(bbox=np.asarray(d["bbox"]), kps=np.asarray(d["kps"], dtype=np.float32)) for d in good[:32]]
                    model.recognizer.get_batch(image, faces, role="cctv")
                    best = float("inf")
                    for _ in range(runs):
                        t0 = time.perf_counter()
                        model.recognizer.get_batch(image, faces, role="cctv")
                        best = min(best, time.perf_counter() - t0)
                    return 1000 * best / len(faces)
    except Exception as error:  # timing is informative; never fatal
        print(f"  (timing skipped: {type(error).__name__}: {error})")
    return float("nan")


# ============================================================================================ data summary + trust checks
def data_summary(work, clips):
    """Counts that decide how much any result can be trusted."""
    out = {"clips": len(clips), "student_tracks": 0, "impostor_tracks": 0, "n_tracks": 0, "unlabelled_tracks": 0, "swaps": 0,
           "unverified_students": 0, "manual_faces": 0, "typed": 0, "suggested": 0, "students": set(), "audit": []}
    for clip in clips:
        data = work.labels(clip)
        if not data:
            continue
        labels = data["labels"]
        out["student_tracks"] += len(L.student_labels(labels))
        out["impostor_tracks"] += len(L.impostor_labels(labels))
        out["students"] |= set(L.student_labels(labels).values())
        out["swaps"] += len(data["swaps"])
        out["manual_faces"] += len(data["manual"])
        out["unverified_students"] += sum(1 for t in L.student_labels(labels) if t not in data["verified"])
        out["typed"] += sum(1 for s in data["sources"].values() if s == "typed")
        out["suggested"] += sum(1 for s in data["sources"].values() if s == "suggested")
        if data.get("audit"):
            out["audit"].append(data["audit"])
        out["n_tracks"] += len({d["track"] for f in work.dets(clip)["frames"] for d in f["dets"]})
    out["unlabelled_tracks"] = out["n_tracks"] - out["student_tracks"] - out["impostor_tracks"]
    out["n_students"] = len(out["students"])
    return out


def metrics_row(name, ss, resampler, boot_metrics=("auc", "top1", "dir@far0.01", "odir@far0.01")):
    m = L.roc_metrics(ss)
    row = {"name": name, **{k: v for k, v in m.items() if k in ("n", "n_impostor", "top1", "auc", "eer", "dir@far0.01", "odir@far0.01",
                                                                  "dprime", "margin", "thr@far0.01", "othr@far0.01")}}
    for metric in boot_metrics:
        lo, hi = L.bootstrap_ci(ss, metric, resampler)
        row[f"{metric} CI"] = "-" if np.isnan(lo) else f"{lo:.3f}-{hi:.3f}"
    return row


def choose_winner(results, paired_track, args):
    """The PRE-DECLARED rule: another model replaces the control only if its TRACK-level paired difference is 'better' (Holm-adjusted)
    AND at least --equiv-margin; if no model is clearly better, an 'equivalent' model that is at least 25% faster wins; else the control."""
    control = results[0]
    better = [r for r in paired_track if r["verdict"] == "better" and r["diff"] >= args.equiv_margin]
    if better:
        top = max(better, key=lambda r: r["diff"])
        return top["name"], f"{top['name']} is clearly better than the control at track level (diff {top['diff']:+.3f}, Holm p {top['p_holm']:.3g})"
    speed = {r["file"]: r["ms"] for r in results}
    fast = [r for r in paired_track if r["verdict"] == "equivalent" and speed.get(r["name"], np.nan) <= 0.75 * speed.get(control["file"], np.nan)]
    if fast:
        top = min(fast, key=lambda r: speed[r["name"]])
        return top["name"], f"{top['name']} is equivalent to the control (within +-{args.equiv_margin}) and at least 25% faster"
    return control["file"], "no model is clearly better than the control (or the data cannot tell): keep the control"


# ============================================================================================ Part 1: models
def cmd_models(args, work, ledger=None):
    ledger = ledger or L.Ledger()
    clips = sorted(work.clips())
    results = []
    for model_file in args.models_to_test:
        model = MODEL_FACTORY(args, model_file)
        cfg = model.recognizer.crop_config
        looks, gallery = prepare(args, work, model, cfg, clips, per_track=args.probe_looks, include_unknown=False)
        if looks is None:
            print(f"  ! no labelled faces for {model_file}")
            continue
        ms = time_model(model, work, clips, args)
        results.append({"file": model_file, "looks": looks, "gallery": gallery, "cfg": cfg, "ms": ms,
                        "quality": quality_mode_for(model_file, args.models)})
        print(f"  {model_file}: {len(looks['track'])} looks embedded, {ms:.1f} ms/face")
    if not results:
        sys.exit("nothing to compare")
    control = results[0]
    recipe = recipe_for(args)
    for r in results:
        r["gi"] = score(r["looks"], r["gallery"], recipe)
        r["pooled"] = L.pool_tracks(r["looks"], quality=r["quality"])
        emb, names = L.apply_recipe(r["gallery"], recipe)
        r["gi_track"] = L.genuine_impostor(r["pooled"]["emb"], r["pooled"]["label"], emb, names)
    common_look = np.logical_and.reduce([r["gi"]["valid"] | r["gi"]["impostor"] for r in results])
    common_track = np.logical_and.reduce([r["gi_track"]["valid"] | r["gi_track"]["impostor"] for r in results])
    for r in results:
        r["ss_look"] = L.make_scoreset(r["looks"], r["gi"], args.weighting, common_look)
        r["ss_track"] = L.make_scoreset(r["pooled"], r["gi_track"], "balanced", common_track)
    if control["ss_look"].n_g == 0:
        sys.exit("no labelled student faces could be scored (are the gallery folder names the labels?)")
    res_look = L.Resampler(control["ss_look"], args.boot, args.seed)
    res_track = L.Resampler(control["ss_track"], args.boot, args.seed)

    look_rows = [dict(metrics_row(r["file"], r["ss_look"], res_look), ms=r["ms"]) for r in results]
    track_rows = [dict(metrics_row(r["file"], r["ss_track"], res_track), ms=r["ms"]) for r in results]
    fam = {}
    for level, key, resampler in (("look", "ss_look", res_look), ("track", "ss_track", res_track)):
        fam[level] = L.Family(f"models/{level}", args.equiv_margin, ledger)
        for r in results[1:]:
            fam[level].add(r["file"], r[key], control[key], args.metric, resampler, level=level)
        fam[level].close()
    paired = fam["look"].rows + fam["track"].rows
    winner, reason = choose_winner(results, fam["track"].rows, args)

    ensemble_rows, ensemble_note = [], ""
    if len(results) >= 2:
        ranked = sorted(range(len(results)), key=lambda i: -(track_rows[i]["auc"] if not np.isnan(track_rows[i]["auc"]) else -1))
        best_single = results[ranked[0]]
        combos = [tuple(sorted(ranked[:2]))] + ([tuple(sorted(ranked[:3]))] if len(results) >= 3 else []) + ([tuple(sorted(range(len(results))))] if len(results) > 3 else [])
        levels = {}
        for level, key, data_key, quality_key in (("look", "ss_look", "looks", "gi"), ("track", "ss_track", "pooled", "gi_track")):
            items = []
            for combo in dict.fromkeys(combos):
                mats, students_ref, ok = [], None, True
                for i in combo:
                    r = results[i]
                    emb, names = L.apply_recipe(r["gallery"], recipe)
                    students, scores = L.per_student_scores(np.asarray(r[data_key]["emb"], np.float32), emb, names)
                    students_ref = students_ref or students
                    ok &= students == students_ref
                    mats.append(scores)
                if not ok:
                    continue
                gi = L.fuse_scores(mats, results[combo[0]][data_key]["label"], students_ref)
                mask = common_look if level == "look" else common_track
                ens_ss = L.make_scoreset(results[combo[0]][data_key], gi, args.weighting if level == "look" else "balanced", mask)
                items.append(("ensemble: " + " + ".join(results[i]["file"] for i in combo), "ensemble", ens_ss, sum(results[i]["ms"] for i in combo)))
            levels[level] = items
        for level, key, rs in (("look", "ss_look", res_look), ("track", "ss_track", res_track)):
            fam_e = L.Family(f"ensemble/{level}", args.equiv_margin, ledger)
            for name, group, ens_ss, ms in levels.get(level, []):
                fam_e.add(name, ens_ss, best_single[key], args.metric, rs, level=level, ms=ms)
            fam_e.close()
            ensemble_rows += fam_e.rows
        ensemble_note = (f"Compared with the best single model ({best_single['file']}). Fusion = mean of each model's scores standardised on its own impostor scores. "
                         "Running k models costs the sum of their ms/face; an ensemble is never adopted automatically because production would need code to run and fuse them.")
    strata = []
    for r in results:
        ss, looks = r["ss_look"], r["looks"]
        width = looks["width"][ss.idx_g]
        zones = np.array([L.zone_of(b, work.dets(c)["size"][1]) for b, c in zip(looks["bbox"][ss.idx_g], looks["clip"][ss.idx_g])])
        for kind, values in (("width", np.array([L.width_bin(w) for w in width])), ("zone", zones)):
            for v in sorted(set(values)):
                sub = ss.subset_g(values == v)
                if sub.n_g >= 5:
                    m = L.roc_metrics(sub)
                    strata.append({"name": r["file"], "by": kind, "bin": v, "n": m["n"], "top1": m["top1"], "auc": m["auc"], "dir@far0.01": m["dir@far0.01"]})
    summary = data_summary(work, clips)
    cols = [("name", "model"), ("n", "n looks"), ("n_impostor", "impostor looks"), ("top1", "top-1"), ("top1 CI", "top-1 95% CI"), ("auc", "AUC"),
            ("auc CI", "AUC 95% CI"), ("eer", "EER"), ("dir@far0.01", "DIR@FAR 1%"), ("dir@far0.01 CI", "CI"), ("odir@far0.01", "open DIR@FAR 1%"),
            ("odir@far0.01 CI", "CI"), ("dprime", "d'"), ("othr@far0.01", "open thr @FAR 1%"), ("ms", "ms/face")]
    warn = []
    if control["ss_look"].n_o == 0:
        warn.append("**No impostor ('x' / 'n') faces are labelled, so the open-set false-accept rate is unavailable.** Label the non-enrolled faces.")
    r0 = res_look
    text = ["# Part 1 - model bakeoff", "",
            f"Clips {summary['clips']}; {summary['n_students']} students, {summary['student_tracks']} student tracks, {summary['impostor_tracks']} impostor tracks; "
            f"{len(control['looks']['track'])} looks (first {args.probe_looks} of each labelled track). Gallery: clean phone photos"
            f"{' + CCTV crops (LEAKAGE RISK)' if args.use_cctv else ''}. Each model with its own default crop settings.",
            f"Weighting: **{args.weighting}** (every track counts equally). Bootstrap: {args.boot} draws over {r0.n_clips} clip(s) x {r0.n_students} student(s) "
            f"(impostors: tracks). Control for paired comparisons: **{control['file']}**. Primary metric: **{args.metric}**; "
            f"'equivalent' means the whole interval lies within +-{args.equiv_margin}.", ""] + warn + [
            "", "## Decision rule (declared before looking at the numbers)", "",
            "Another model replaces the control only if its TRACK-level paired difference is 'better' after Holm correction AND at least the margin; "
            "otherwise a clearly-equivalent model that is >= 25% faster wins; otherwise keep the control.", "",
            f"**Result: {winner}.** {reason}.", "",
            "## Per look", "", L.md_table(look_rows, cols), "", "## Per track (pooled quality-weighted looks, like production)", "", L.md_table(track_rows, cols), "",
            "## Paired differences vs the control", "",
            L.md_table(paired, [("name", "model"), ("level", "level"), ("diff", f"{args.metric} diff"), ("CI", "95% CI"), ("p_holm", "Holm p"),
                                ("mde", "min. detectable diff"), ("verdict", "verdict")]), "",
            "`min. detectable diff` is the smallest true difference this data would detect 80% of the time. An 'inconclusive' verdict with a MDE "
            "larger than the gap you care about means: collect more clips, do not conclude 'no difference'.", "",
            "## Ensemble of models (score-level fusion)", "",
            L.md_table(ensemble_rows, [("name", "ensemble"), ("level", "level"), ("diff", f"{args.metric} diff vs best single"), ("CI", "95% CI"), ("p_holm", "Holm p"),
                                       ("mde", "min. detectable diff"), ("verdict", "verdict"), ("ms", "ms/face (sum)")]) if ensemble_rows else "_Needs at least two models._", "", ensemble_note, "",
            "## By face width and by zone (looks, point estimates)", "", L.md_table(strata, [("name", "model"), ("by", "by"), ("bin", "bin"), ("n", "n"), ("top1", "top-1"), ("auc", "AUC"), ("dir@far0.01", "DIR@FAR 1%")]), "",
            "How to read it: AUC and DIR@FAR do not depend on a model's score scale, so models can be compared. 'open thr' is where to start tuning "
            "that model's threshold (it rises with the size of the roster: see sweep.md)."]
    path = work.reports() / "models.md"
    path.write_text("\n".join(text), encoding="utf-8")
    L.write_csv(work.reports() / "models_look.csv", look_rows)
    L.write_csv(work.reports() / "models_track.csv", track_rows)
    print(f"Wrote {path}\nWinner: {winner} ({reason})")
    return {"winner": winner, "reason": reason, "track_rows": track_rows, "paired": paired, "ensemble": ensemble_rows, "speed": {r["file"]: r["ms"] for r in results}}


# ============================================================================================ Part 2: sweep
def stage_a_configs(base, quick=False, uses_keypoints=False):
    """Crop settings to try, one factor at a time: (name, group, config). Each is the model's own base config with ONE change."""
    def with_(**changes):
        return crop_ops.CropConfig(**{**base.as_dict(), **changes})

    configs = [("default", "default", base)]
    configs += [(f"interp {i}", "interp", with_(interp=i)) for i in ("cubic", "lanczos", "area") if i != base.interp]
    enhances = ["gamma:0.7", "clahe:2:4", "histeq"] if quick else crop_ops.ENHANCE_PRESETS[1:]
    for e in enhances:
        configs.append((f"enhance {e} (all crops)", "enhance", with_(enhance=e, enhance_side="both")))
        configs.append((f"enhance {e} (CCTV only)", "enhance", with_(enhance=e, enhance_side="cctv")))
    if not base.flip:
        configs.append(("flip", "flip", with_(flip=True)))
    configs += [(f"jitter {k}", "jitter", with_(jitter=k)) for k in ((4,) if quick else (4, 8)) if k != base.jitter]
    if uses_keypoints:
        other = "template" if base.keypoints == "detected" else "detected"
        configs.append((f"{other} keypoints", "keypoints", with_(keypoints=other)))
    return configs


def aligned_with(a, b):
    return len(a["track"]) == len(b["track"]) and np.array_equal(a["track"], b["track"]) and np.array_equal(a["frame"], b["frame"]) \
        and np.array_equal(a["clip"], b["clip"])


def combine_cfg(base, picked):
    """The base config with every picked group's change applied."""
    changes = {}
    for cfg in picked:
        for k, v in cfg.as_dict().items():
            if v != base.as_dict()[k]:
                changes[k] = v
    return crop_ops.CropConfig(**{**base.as_dict(), **changes})


def run_family(items, control_name, args, name, ledger, metric=None):
    """items: [(name, group, ScoreSet)] on the same looks. Returns the closed Family (Holm over every non-control row)."""
    metric = metric or args.metric
    control = next(ss for n, _, ss in items if n == control_name)
    resampler = L.Resampler(control, args.boot, args.seed)
    fam = L.Family(name, args.equiv_margin, ledger)
    for n, group, ss in items:
        if n != control_name:
            fam.add(n, ss, control, metric, resampler, group=group)
    fam.close()
    return fam, resampler


def rows_with_metrics(fam, items, control_name):
    by_name = {n: ss for n, _, ss in items}
    out = []
    for n in [control_name] + [r["name"] for r in fam.rows]:
        m = L.roc_metrics(by_name[n])
        row = {"name": n, **{k: m.get(k) for k in ("n", "top1", "auc", "dir@far0.01", "odir@far0.01")}}
        if n != control_name:
            r = next(r for r in fam.rows if r["name"] == n)
            row.update({"diff": r["diff"], "CI": r["CI"], "p_holm": r["p_holm"], "mde": r["mde"], "verdict": r["verdict"], "group": r.get("group", "")})
        else:
            row.update({"diff": 0.0, "CI": "-", "verdict": "(control)"})
        out.append(row)
    return out


A_COLS = [("name", "setting"), ("n", "n"), ("top1", "top-1"), ("auc", "AUC"), ("dir@far0.01", "DIR@FAR 1%"), ("odir@far0.01", "open DIR@FAR 1%"),
          ("diff", "diff"), ("CI", "95% CI"), ("p_holm", "Holm p"), ("mde", "MDE"), ("verdict", "verdict")]


def run_stage_a(args, work, model, base_cfg, tune, recipe, ledger):
    uses_kp = bool(getattr(model.recognizer, "uses_keypoints", False))
    data = []
    for name, group, cfg in stage_a_configs(base_cfg, args.quick, uses_kp):
        looks, gallery = prepare(args, work, model, cfg, tune, per_track=args.sweep_looks, include_unknown=False)
        if looks is None:
            continue
        data.append({"name": name, "group": group, "cfg": cfg, "looks": looks, "gallery": gallery})
    base = data[0]
    data = [d for d in data if aligned_with(d["looks"], base["looks"]) or d is base]
    # hybrid: detected landmarks only for faces at least W px wide (KP-RPE models), built from the two keypoint extractions
    if uses_kp:
        other = next((d for d in data if d["group"] == "keypoints"), None)
        if other is not None:
            det_d, tpl_d = (base, other) if base["cfg"].keypoints == "detected" else (other, base)
            for w in args.hybrid_widths:
                mix = np.where((base["looks"]["width"] >= w)[:, None], det_d["looks"]["emb"], tpl_d["looks"]["emb"])
                data.append({"name": f"keypoints: detected only if face >= {w}px, else template", "group": "keypoints-hybrid", "cfg": None,
                             "looks": {**base["looks"], "emb": mix}, "gallery": base["gallery"], "note": "needs code in crop_ops/recognize to adopt"})
    for d in data:
        d["gi"] = score(d["looks"], d["gallery"], recipe)
    mask = np.logical_and.reduce([d["gi"]["valid"] | d["gi"]["impostor"] for d in data])
    items = [(d["name"], d["group"], L.make_scoreset(d["looks"], d["gi"], args.weighting, mask)) for d in data]
    fam, _ = run_family(items, "default", args, "crop", ledger)
    best = {}
    for r in fam.rows:
        if r["verdict"] == "better" and r["group"] != "keypoints-hybrid" and (r["group"] not in best or r["diff"] > best[r["group"]]["diff"]):
            best[r["group"]] = r
    cfg_by_name = {d["name"]: d["cfg"] for d in data}
    adopted_cfg, note = base_cfg, "no crop setting was clearly better than the default: keep the default"
    if best:
        combined = combine_cfg(base_cfg, [cfg_by_name[r["name"]] for r in best.values()])
        looks_c, gallery_c = prepare(args, work, model, combined, tune, per_track=args.sweep_looks, include_unknown=False)
        if looks_c is not None and aligned_with(looks_c, base["looks"]):
            gi_c = score(looks_c, gallery_c, recipe)
            mask2 = mask & (gi_c["valid"] | gi_c["impostor"])
            pair = [("default", "", L.make_scoreset(base["looks"], base["gi"], args.weighting, mask2)),
                    ("combined", "combined", L.make_scoreset(looks_c, gi_c, args.weighting, mask2))]
            fam2, _ = run_family(pair, "default", args, "crop/combined", ledger)
            r2 = fam2.rows[0]
            if r2["verdict"] == "better":
                adopted_cfg, note = combined, f"combined {', '.join(r['name'] for r in best.values())} (diff {r2['diff']:+.3f}, {r2['CI']})"
            else:
                top = max(best.values(), key=lambda r: r["diff"])
                adopted_cfg, note = cfg_by_name[top["name"]], f"{top['name']} (diff {top['diff']:+.3f}, {top['CI']}); the combination was not clearly better"
    ledger.note("crop: " + note)
    table = rows_with_metrics(fam, items, "default")
    for r in table:
        d = next((d for d in data if d["name"] == r["name"]), None)
        if d is not None and d.get("note"):
            r["name"] += f" ({d['note']})"
    return {"cfg": adopted_cfg, "note": note, "table": table}


def run_stage_b(args, work, model, cfg, tune, ledger):
    looks, gallery = prepare(args, work, model, cfg, tune, per_track=args.sweep_looks, include_unknown=False)
    recipes = [r for r in L.RECIPES if args.use_cctv or "cctv" not in r]
    combos = [(f"{r} / {a}", r, a) for r in recipes for a in ("max", "mean2", "mean3")]
    gis = {name: score(looks, gallery, recipe_for(args, r), a) for name, r, a in combos}
    shots = sorted(set(map(str, gallery["shot"])) - {""})
    for shot in shots:
        recipe = dict(recipe_for(args, "clean"))
        recipe["exclude_shots"] = {shot}
        gis[f"clean without '{shot}' photos"] = score(looks, gallery, recipe, "max")
    emb, names = L.apply_recipe(gallery, recipe_for(args, "clean"))
    zgi, applied, hub = L.znorm_gi(looks, emb, names, "max")
    if applied:
        gis["clean / max + Z-norm (per-student, cohort from other clips)"] = zgi
    mask = np.logical_and.reduce([g["valid"] | g["impostor"] for g in gis.values()])
    items = [(n, "recipe" if " / " in n and "Z-norm" not in n else "info", L.make_scoreset(looks, g, args.weighting, mask)) for n, g in gis.items()]
    fam, _ = run_family(items, "clean / max", args, "gallery", ledger)
    best = max((r for r in fam.rows if r["verdict"] == "better" and r["group"] == "recipe"), key=lambda r: r["diff"], default=None)
    recipe_name, agg, note = "clean", "max", "no gallery recipe / aggregator was clearly better than clean / max: keep it"
    if best:
        recipe_name, agg = best["name"].split(" / ")
        note = f"{best['name']} (diff {best['diff']:+.3f}, {best['CI']})"
    ledger.note("gallery: " + note)
    zrow = next((r for r in fam.rows if "Z-norm" in r["name"]), None)
    z_note = ""
    if zrow is not None:
        z_note = (f"Z-norm: diff {zrow['diff']:+.3f} ({zrow['CI']}), verdict **{zrow['verdict']}**; hub spread (sd across students of their mean impostor score) = {hub:.3f}. "
                  "Adopting it needs production code (a stored per-student mean / sd); it is reported, never adopted automatically.")
    return {"recipe": recipe_name, "aggregator": agg, "note": note, "z_note": z_note, "table": rows_with_metrics(fam, items, "clean / max")}


def pool_variants(args):
    v = [("production default (first 10 looks, top 5, quality-weighted)", {})]
    v += [(f"top_k {k}", {"top_k": k}) for k in (1, 3, 8)]
    v += [(f"n_looks {n}", {"n_looks": n}) for n in (3, 5, 20)]
    v += [(f"keep_fraction {f}", {"keep_fraction": f}) for f in (0.3, 0.8)]
    v += [(f"quality = {q}", {"quality": q}) for q in ("equal", "sharp", "size")]
    v += [(f"every {s}nd available look" if s == 2 else f"every {s}rd available look", {"stride": s}) for s in (2, 3)]
    return v


def quality_strata(looks, gi, args):
    """Look-level accuracy by quartile of the feature norm, sharpness and face width: where do the weak looks sit? (informs the gates)"""
    ss = L.make_scoreset(looks, gi, args.weighting)
    rows = []
    for name, values in (("feature norm", looks["norm"]), ("sharpness", looks["sharp"]), ("face width", looks["width"])):
        v = values[ss.idx_g]
        edges = np.quantile(v, [0.25, 0.5, 0.75])
        q = np.digitize(v, edges)
        for k, label in enumerate(("lowest quartile", "2nd", "3rd", "highest quartile")):
            sub = ss.subset_g(q == k)
            if sub.n_g >= 5:
                m = L.roc_metrics(sub)
                rows.append({"by": name, "quartile": label, "range": f"{v[q == k].min():.1f} to {v[q == k].max():.1f}", "n": m["n"],
                             "top1": m["top1"], "auc": m["auc"]})
    return rows


def run_stage_c(args, work, model, cfg, recipe_name, agg, quality, tune, ledger):
    looks, gallery = prepare(args, work, model, cfg, tune, per_track=None, include_unknown=True)
    labelled = np.array([l not in ("", "?", None) for l in looks["label"]])
    sub = {k: v[labelled] for k, v in looks.items()}
    emb, names = L.apply_recipe(gallery, recipe_for(args, recipe_name))
    pooled = {}
    for name, kw in pool_variants(args):
        pooled[name] = L.pool_tracks(sub, **{"quality": quality, **kw})
    gis = {n: L.genuine_impostor(p["emb"], p["label"], emb, names, agg) for n, p in pooled.items()}
    mask = np.logical_and.reduce([g["valid"] | g["impostor"] for g in gis.values()])
    default = pool_variants(args)[0][0]
    items = [(n, "pool", L.make_scoreset(pooled[n], gis[n], "balanced", mask)) for n in pooled]
    fam, _ = run_family(items, default, args, "pooling", ledger)
    best = max((r for r in fam.rows if r["verdict"] == "better"), key=lambda r: r["diff"], default=None)
    chosen = dict(pool_top_k=5, quality=quality, keep_fraction=0.6)
    note = "no pooling variant was clearly better than the production default: keep it"
    if best:
        kw = dict(dict(pool_variants(args))[best["name"]])
        note = f"{best['name']} (diff {best['diff']:+.3f}, {best['CI']}) - NOTE: only top_k is a production setting; others need code"
        if "top_k" in kw:
            chosen["pool_top_k"] = kw["top_k"]
    ledger.note("pooling: " + note)
    gi_looks = score({k: v[labelled] for k, v in looks.items()}, gallery, recipe_for(args, recipe_name), agg)
    return {"looks": looks, "gallery": gallery, "chosen": chosen, "note": note, "table": rows_with_metrics(fam, items, default),
            "strata": quality_strata(sub, gi_looks, args), "emb_names": (emb, names)}


class ReplayCtx:
    """Everything a replay needs, with results cached per (settings, clip)."""

    def __init__(self, args, frames_by_clip, fps, gallery_pair, identity, adjud):
        self.args, self.frames, self.fps = args, frames_by_clip, fps
        self.gallery, self.identity, self.adjud = gallery_pair, identity, adjud
        self.cache = {}

    def clip_totals(self, row, clips):
        out = {}
        for clip in clips:
            key = (json.dumps(row, sort_keys=True, default=str), clip)
            if key not in self.cache:
                r = dict(row)
                det = r.pop("_det", self.args.det_thresh)
                tp = tracker_params(self.args)
                for meta, name in (("_dist", "max_center_dist"), ("_assign", "assignment"), ("_iou", "iou_threshold"), ("_missed", "max_missed")):
                    if meta in r:
                        tp[name] = r.pop(meta)
                scan, mult = r.pop("_scan", self.args.scan_seconds), r.pop("_every", 1)
                frames = self.frames[clip][::mult]
                every = self.args.every * mult
                wf = max(2, int(round(scan * self.fps[clip] / every)))
                hf = max(1, int(round(self.args.window_hop * self.fps[clip] / every)))
                self.cache[key] = L.replay_clip_windows(frames, self.gallery, self.identity, L.settings_namespace(**r), tp, wf, hf, det, self.adjud, clip)
            out[clip] = self.cache[key]
        return out

    def totals(self, row, clips):
        return L.add_totals(list(self.clip_totals(row, clips).values()))


def totals_row(name, t, extra=None):
    return {"name": name, "windows": t["windows"], "present": t["present"], "recall": t["recall"], "wrong": t["wrong"], "false_accept": t["false_accept"],
            "unverified": t["unverified"], "bad_per_scan": t["bad_per_scan"], "median_attempt": t["median_attempt"], **(extra or {})}


T_COLS = [("name", "setting"), ("windows", "scans"), ("present", "student-scans"), ("recall", "recall"), ("wrong", "wrong"), ("false_accept", "false accepts"),
          ("unverified", "unverified"), ("bad_per_scan", "errors / scan"), ("median_attempt", "median attempt")]


def variant_space(args, tune_looks):
    """One-factor variants around the chosen decision row: name, factor, [(label, overrides)]. Gates come from the data's own quartiles."""
    lab = np.array([l not in ("", "?", None) for l in tune_looks["label"]])
    norm_q = np.quantile(tune_looks["norm"][lab], [0.10, 0.25]) if lab.any() else [0, 0]
    sharp_q = np.quantile(tune_looks["sharp"][lab], [0.10, 0.25]) if lab.any() else [0, 0]
    space = [("min_face", [(f"{v}px", {"min_face": v}) for v in (14, 16, 18, 20)]),
             ("min_norm", [(f"{q:.1f} (P{p})", {"min_norm": float(q)}) for p, q in zip((10, 25), norm_q)]),
             ("min_sharpness", [(f"{q:.1f} (P{p})", {"min_sharpness": float(q)}) for p, q in zip((10, 25), sharp_q)]),
             ("max_attempts", [(str(v), {"max_attempts": v}) for v in (5, 20)]),
             ("pool_gate", [(str(v), {"pool_gate": v}) for v in (0.1, 0.2)]),
             ("pool_top_k", [(str(v), {"pool_top_k": v}) for v in (1, 3, 8)]),
             ("aggregator", [(a, {"aggregator": a}) for a in ("mean2", "mean3")]),
             ("detector threshold", [(str(v), {"_det": v}) for v in (0.2, 0.25, 0.35, 0.4)]),
             ("tracker max_center_dist", [(str(v), {"_dist": v}) for v in (0.8, 1.25, 1.5)]),
             ("tracker assignment", [(a, {"_assign": a}) for a in ("greedy", "hungarian") if a != args.tracker_assignment])]
    if args.quick:
        space = [s for s in space if s[0] in ("min_face", "max_attempts", "detector threshold")]
    return space


def run_stage_d(args, work, model, cfg, recipe_name, agg, pool_chosen, c_result, tune, test, ledger):
    looks, gallery = c_result["looks"], c_result["gallery"]
    all_clips = tune + test
    full_all = get_looks(work, model, cfg, all_clips, args, per_track=None, include_unknown=True)
    frames = L.clip_frames(full_all)
    clips_meta = work.clips()
    emb, names = L.apply_recipe(gallery, recipe_for(args, recipe_name))
    identity = {n: {"student_id": n, "name": n} for n in set(names)}
    ctx = ReplayCtx(args, frames, {c: clips_meta[c]["fps"] for c in all_clips}, (emb, names), identity, work.adjudications())
    base = {"aggregator": agg, "pool_attempts": True, "pool_top_k": pool_chosen["pool_top_k"]}
    thresholds = np.round(np.arange(0.12, 0.46, 0.04) if args.quick else np.arange(0.10, 0.50, 0.02), 2)
    rows = L.decision_grid(base, thresholds, (0, 0.02), (0, 0.03, 0.06))
    t0 = time.time()
    per_clip = [ctx.clip_totals(r, tune) for r in rows]
    print(f"  decision grid: {len(rows)} settings x {len(tune)} tune clips replayed in {time.time() - t0:.0f}s")
    loco = L.loco_selection(per_clip, rows, tune, args.max_bad_per_scan) if len(tune) >= 2 else None
    totals = [L.add_totals(list(p.values())) for p in per_clip]
    pick, info = L.pick_operating_point(totals, rows, args.max_bad_per_scan)
    budget_met = pick is not None
    if pick is None:
        pick = info["closest"]
        ledger.note(f"decision: NO setting met the error budget of {args.max_bad_per_scan:g} errors per scan; the closest was taken")
    chosen = dict(rows[pick])
    adopted = [("grid", f"threshold {chosen['threshold']}, accept {chosen['accept_threshold']}, margin {chosen['margin']}")]
    cur = ctx.totals(chosen, tune)
    variant_rows = []
    for factor, options in variant_space(args, looks):
        best_opt, best_t = None, cur
        for label, over in options:
            t = ctx.totals({**chosen, **over}, tune)
            variant_rows.append(totals_row(f"{factor} = {label}", t, {"factor": factor}))
            ok = t["bad_per_scan"] <= max(cur["bad_per_scan"], args.max_bad_per_scan) and t["recall"] >= cur["recall"] + args.adopt_gain
            if ok and (best_opt is None or t["recall"] > best_t["recall"]):
                best_opt, best_t = (label, over), t
        ledger.add_family(f"decision/{factor}", len(options))
        if best_opt is not None:
            chosen.update(best_opt[1])
            cur = best_t
            adopted.append((factor, best_opt[0]))
    production = {**base, "threshold": 0.26, "accept_threshold": 0.28, "margin": 0.0}
    final = {"production defaults (0.26 / 0.28, no margin)": production, "CHOSEN": chosen}
    ev = {}
    for name, row in final.items():
        ev[name] = {"tune": ctx.clip_totals(row, tune), "test": ctx.clip_totals(row, test) if test else {}}
    # scan length and cadence curves, funnel, gallery size
    curves = [totals_row(f"scan {s}s", ctx.totals({**chosen, "_scan": s}, all_clips), {"factor": "scan"}) for s in args.scan_curve]
    curves += [totals_row(f"every {args.every * m} frames", ctx.totals({**chosen, "_every": m}, all_clips), {"factor": "cadence"}) for m in (1, 2, 3)]
    funnel = L.add_totals(list(ctx.clip_totals(chosen, all_clips).values()))["funnel"]
    imp = np.array([l in L.IMPOSTOR for l in full_all["label"]])
    sizes = [n for n in args.gallery_sizes if n <= len(set(names))] + ([len(set(names))] if len(set(names)) not in args.gallery_sizes else [])
    scaling = L.threshold_vs_gallery_size(full_all["emb"][imp], emb, names, sorted(set(sizes)), 0.01, seed=args.seed) if imp.sum() >= 20 else []
    return {"chosen": chosen, "adopted": adopted, "grid_best": totals_row("tune (chosen row)", ctx.totals(rows[pick], tune)), "loco": loco, "rows": rows,
            "variants": variant_rows, "eval": ev, "curves": curves, "budget_met": budget_met, "funnel": funnel, "scaling": scaling, "ctx": ctx, "plateau": info.get("plateau"),
            "n_impostor_looks": int(imp.sum())}


def cmd_sweep(args, work, ledger=None):
    ledger = ledger or L.Ledger()
    clips = sorted(work.clips())
    tune, test = split_clips(work.clips(), args.test_clips)
    if not tune:
        tune, test = clips, []
    model = MODEL_FACTORY(args, args.model)
    quality = quality_mode_for(args.model, args.models)
    base_cfg = model.recognizer.crop_config
    recipe = recipe_for(args, "clean")
    summary = data_summary(work, clips)
    text = [f"# Part 2 - settings sweep for {args.model}", "",
            f"Clips {len(clips)}. **Tune clips** ({len(tune)}): {', '.join(tune)}. **Held-out test clips** ({len(test)}): {', '.join(test) or 'none (fewer than 3 clips)'}.",
            "Every choice below is made on the tune clips only; the test clips are scored once at the end with the chosen settings. "
            f"{summary['n_students']} students, {summary['student_tracks']} student tracks, {summary['impostor_tracks']} impostor tracks. "
            f"Weighting {args.weighting}; {args.boot} bootstrap draws over clips x students; equivalence margin +-{args.equiv_margin}.", ""]
    print("Stage A: crop settings")
    a = run_stage_a(args, work, model, base_cfg, tune, recipe, ledger)
    text += ["## A. Crop settings (one factor at a time, vs the model's default; look level, Holm-corrected)", "", L.md_table(a["table"], A_COLS), "",
             f"**Chosen crop setting:** {a['note']}.", ""]
    print("Stage B: gallery")
    b = run_stage_b(args, work, model, a["cfg"], tune, ledger)
    text += ["## B. Gallery recipe, aggregator, enrolment poses, Z-norm (look level)", "", L.md_table(b["table"], A_COLS), "", f"**Chosen:** {b['note']}.", "", b["z_note"], ""]
    print("Stage C: pooling")
    c = run_stage_c(args, work, model, a["cfg"], b["recipe"], b["aggregator"], quality, tune, ledger)
    text += ["## C. Pooling the looks of one track (track level)", "", L.md_table(c["table"], A_COLS), "", f"**Chosen:** {c['note']}.", "",
             "### Where the weak looks sit (look level, by quartile of each quality measure)", "",
             L.md_table(c["strata"], [("by", "measure"), ("quartile", "quartile"), ("range", "range"), ("n", "n"), ("top1", "top-1"), ("auc", "AUC")]), "",
             "A steep drop in the lowest quartile is what the `min_face` / `min_norm` / `min_sharpness` gates act on (tested in D).", ""]
    print("Stage D: decision settings (production replay)")
    d = run_stage_d(args, work, model, a["cfg"], b["recipe"], b["aggregator"], c["chosen"], c, tune, test, ledger)
    text += decision_report(args, d, tune, test)
    text += ["## Comparisons made", "", f"{ledger.total} paired comparisons / variants were evaluated in total ({dict(ledger.families)}). "
             "Within each family the Holm correction was applied. Choices:", ""] + [f"- {n}" for n in ledger.configs]
    path = work.reports() / "sweep.md"
    path.write_text("\n".join(text), encoding="utf-8")
    profile = write_profile(args, work, d, a, b, c)
    print(f"Wrote {path}\nWrote {profile}")
    return {"a": a, "b": b, "c": c, "d": d, "tune": tune, "test": test, "profile": str(profile)}


def decision_report(args, d, tune, test):
    out = ["## D. Decision settings (production replay)", "",
           f"Replay = production cadence (every {args.every} frames), a {args.scan_seconds:g} s scan, start offsets every {args.window_hop:g} s, the tracker re-run at that "
           "cadence, ALL embedded faces (students, impostors, unlabelled) taking part. Errors = wrong student + false accept (a non-enrolled face named). "
           f"Budget used to choose: <= {args.max_bad_per_scan:g} errors per scan. Operating point = the middle of the best plateau, nudged to the safer side.", ""]
    loco = d["loco"]
    if loco and loco["held_out"]:
        t = loco["held_out"]
        picks = [rows_pick for _, rows_pick in loco["choices"] if rows_pick is not None]
        thr = [d["rows"][p]["threshold"] for p in picks]
        out += ["### Honest estimate: leave-one-clip-out on the tune clips", "",
                L.md_table([totals_row("held-out clips (each scored with settings chosen on the others)", t)], T_COLS), "",
                f"Threshold chosen in each fold: min {min(thr):.2f}, max {max(thr):.2f} (a wide spread = the choice is unstable with this much data).", ""]
    elif loco:
        out += ["**No setting met the error budget in any leave-one-clip-out fold, so there is no honest held-out estimate.** "
                "Look at the wrong / false-accept counts in the variants table: they say what limits the system (label noise, look-alikes, impostors).", ""]
    else:
        out += ["_Fewer than 2 tune clips: no leave-one-clip-out estimate._", ""]
    thr_all = [r["threshold"] for r in d["rows"]]
    if d["chosen"]["threshold"] >= max(thr_all) - 1e-9 or d["chosen"]["threshold"] <= min(thr_all) + 1e-9:
        out += [f"> **WARNING: the chosen threshold ({d['chosen']['threshold']}) is at the EDGE of the searched range ({min(thr_all)} to {max(thr_all)}).** "
                "The best value may lie outside it: widen the grid before trusting this.", ""]
    if not d["budget_met"]:
        out += [f"> **WARNING: no setting met the budget of {args.max_bad_per_scan:g} errors per scan on the tune clips.** The closest setting was taken. "
                "Do not deploy it as 'safe' without reading the error rows.", ""]
    out += ["### Chosen settings", "", "```", json.dumps({k: v for k, v in d["chosen"].items()}, indent=1), "```", "",
            "Adopted in order: " + "; ".join(f"{f} -> {v}" for f, v in d["adopted"]), "",
            f"Plateau of equally good thresholds (tune clips): {d['plateau'] if d['plateau'] else 'n/a'}", "",
            "### Variants tried around the chosen point (tune clips; adopted only if recall rises by >= "
            f"{args.adopt_gain:g} within the error budget)", "", L.md_table(d["variants"], T_COLS), ""]
    rows = []
    for name, parts in d["eval"].items():
        for split, per_clip in parts.items():
            if per_clip:
                t = L.add_totals(list(per_clip.values()))
                ci = L.clip_bootstrap_totals(per_clip, args.boot, args.seed)
                rows.append(totals_row(f"{name} - {split} clips", t, {"recall CI": f"{ci['recall'][0]:.3f}-{ci['recall'][1]:.3f}",
                                                                      "err CI": f"{ci['bad_per_scan'][0]:.3f}-{ci['bad_per_scan'][1]:.3f}"}))
    out += ["### Chosen vs the production defaults", "", L.md_table(rows, T_COLS + [("recall CI", "recall 95% CI (clips)"), ("err CI", "errors/scan 95% CI")]), "",
            "The **test** rows are the held-out result; nothing was chosen on them." if test else "No held-out test clips: these numbers are optimistic (chosen and scored on the same clips).", "",
            "### Recall vs scan length and vs frame cadence (chosen settings, all clips)", "", L.md_table(d["curves"], T_COLS), ""]
    f = d["funnel"]
    if f["visible"]:
        out += ["### Where present students are lost (funnel, all scans)", "",
                "| stage | student-scans | share of those present |", "|---|---|---|"] + [
            f"| {n} | {f[k]} | {f[k] / f['visible']:.0%} |" for n, k in (("present (labelled)", "visible"), ("detected at least once", "detected"),
                                                                           ("tracked (>= 2 sightings)", "tracked"), ("scored above the floor", "above_floor"),
                                                                           ("marked correctly", "correct"))] + [""]
    if d["scaling"]:
        out += [f"### Threshold needed for 1% open-set false accepts vs roster size ({d['n_impostor_looks']} impostor looks)", "",
                L.md_table(d["scaling"], [("size", "students in gallery"), ("mean", "threshold (mean)"), ("sd", "sd over random rosters")]), "",
                "If the thresholds climb with the roster, the value chosen above for THIS roster is the floor, not a constant.", ""]
    return out


PROFILE_KEYS = ("threshold", "accept_threshold", "margin", "aggregator", "pool_attempts", "pool_top_k", "max_attempts", "pool_gate", "min_face",
                "min_sharpness", "min_norm")


def write_profile(args, work, d, a, b, c):
    """settings.<model>.json = ONLY keys recognize.py's make_settings accepts. Everything else goes to study.<model>.json."""
    chosen = d["chosen"]
    settings = {k: chosen[k] for k in PROFILE_KEYS if k in chosen}
    stem = Path(args.model).stem
    path = work.root / f"settings.{stem}.json"
    path.write_text(json.dumps(settings, indent=1), encoding="utf-8")
    study = {"crop": a["cfg"].as_dict(), "crop_label": a["cfg"].label(), "gallery_recipe": b["recipe"], "gallery_aggregator": b["aggregator"],
             "pooling": c["chosen"], "detector_threshold": chosen.get("_det", args.det_thresh),
             "tracker": {**tracker_params(args), **{k[1:]: v for k, v in chosen.items() if k in ("_dist", "_assign", "_iou", "_missed")}},
             "scan_seconds": args.scan_seconds, "every": args.every, "note": "settings.<model>.json holds only decision settings; the rest must be applied in code / env"}
    (work.root / f"study.{stem}.json").write_text(json.dumps(study, indent=1, default=str), encoding="utf-8")
    return path


# ============================================================================================ detector, tracker, adjudicate
def reference_boxes(work, clip):
    """{frame position: [boxes]} of every face you labelled as a student or 'x' on the labelled frames, plus faces you added by hand."""
    ldata = work.labels(clip)
    if not ldata or not ldata.get("done"):
        return {}
    dets = work.dets(clip)
    keep = set(L.student_labels(ldata["labels"])) | set(L.impostor_labels(ldata["labels"]).keys())
    ref = {}
    for pos in [ldata["first_pos"]] + list(ldata["verify_pos"]):
        ref[pos] = [d["bbox"] for d in dets["frames"][pos]["dets"] if d["track"] in keep and ldata["labels"].get(d["track"]) != "n"]
    for m in ldata["manual"]:
        ref.setdefault(m["pos"], []).append(m["bbox"])
    return ref


def cmd_detector(args, work):
    """Detector size / threshold vs ALL labelled faces, hand-added ones included (so a face the prep detector missed still counts)."""
    model = MODEL_FACTORY(args, args.model)
    sizes = [recognize.parse_det_size(s) for s in args.det_sizes]
    low = min(args.det_threshes)
    rows = []
    for size in sizes:
        model.detector.det_thresh = low
        runs = []
        elapsed, count = 0.0, 0
        for clip in sorted(work.clips()):
            height = work.dets(clip)["size"][1]
            for pos, ref in reference_boxes(work, clip).items():
                if not ref:
                    continue
                image = cv2.imread(str(work.frame_path(clip, pos)))
                t0 = time.perf_counter()
                faces, _ = model.detect(image, det_size=size)
                elapsed += time.perf_counter() - t0
                count += 1
                runs.append((ref, [(list(map(float, f.bbox)), float(f.det_score)) for f in faces], height))
        for thresh in args.det_threshes:
            res = L.detection_recall([r[0] for r in runs], [[b for b, s in r[1] if s >= thresh] for r in runs], image_height=runs[0][2] if runs else 1080)
            rows.append({"det_size": f"{size[0]}x{size[1]}", "det_thresh": thresh, "faces": sum(len(r[0]) for r in runs), "recall": res["recall"],
                         "extra/frame": res["extra_per_frame"], "ms/frame": 1000 * elapsed / max(count, 1),
                         **{f"w {k}": v[0] / v[1] for k, v in res["by_width"].items()}, **{f"zone {k}": v[0] / v[1] for k, v in res["by_zone"].items()}})
    cols = [(k, k) for k in dict.fromkeys(k for r in rows for k in r)]
    path = work.reports() / "detector.md"
    path.write_text("# Detector settings vs labelled faces\n\nReference = every face you labelled as a student or 'x' on the labelled frames PLUS the faces you added by hand "
                    "(so faces the prep-time detector missed count against recall). 'extra/frame' = boxes matching no reference face (unlabelled people or false detections). "
                    "Width bins are in pixels; the zone is the face's vertical position (back rows are higher in the frame).\n\n" + L.md_table(rows, cols), encoding="utf-8")
    L.write_csv(work.reports() / "detector.csv", rows)
    print(f"Wrote {path}")
    return rows


def tracker_frames(work, clip, args):
    dets, ldata = work.dets(clip), work.labels(clip)
    labels = ldata["labels"] if ldata else {}
    stride = stride_of(args)
    out = []
    for fr in dets["frames"]:
        if fr["pos"] % stride:
            continue
        out.append((fr["pos"], [{"bbox": d["bbox"], "label": labels.get(d["track"]) or "", "dense": d["track"], "det": d["det"]}
                                for d in fr["dets"] if d["det"] >= args.det_thresh]))
    return out


def cmd_tracker(args, work):
    """Tracker settings at the PRODUCTION cadence over every scan window; judged on the per-detection labels of every labelled track."""
    clips = [c for c in sorted(work.clips()) if work.labels(c) and work.labels(c).get("done")]
    frames = {c: tracker_frames(work, c, args) for c in clips}
    fps = {c: work.clips()[c]["fps"] for c in clips}
    grid = []
    for assignment in ("greedy", "hungarian"):
        for iou_t in ((0.3,) if args.quick else (0.2, 0.3, 0.4)):
            for dist in ((0.8, 1.0, 1.25) if args.quick else (0.6, 0.8, 1.0, 1.25, 1.5)):
                for missed in (5, 15):
                    grid.append({"assignment": assignment, "iou": iou_t, "max_center_dist": dist, "max_missed": missed})
    rows = []
    for p in grid:
        tot = {"students": 0, "merged_ids": 0, "fragments": 0, "tracks": 0}
        for c in clips:
            r = L.tracker_eval(frames[c], window_frames_for(args, fps[c]), hop_frames_for(args, fps[c]), assignment=p["assignment"],
                               iou_threshold=p["iou"], max_center_dist=p["max_center_dist"], max_missed=p["max_missed"])
            for k in tot:
                tot[k] += r[k]
        rows.append({**p, **tot, "fragments/student": tot["fragments"] / max(tot["students"], 1)})
    rows.sort(key=lambda r: (r["merged_ids"], r["fragments"], r["max_center_dist"]))
    cols = [("assignment", "assignment"), ("iou", "iou"), ("max_center_dist", "max_center_dist"), ("max_missed", "max_missed"), ("students", "student-scans"),
            ("merged_ids", "merged ids"), ("fragments", "extra ids"), ("fragments/student", "extra ids / student"), ("tracks", "tracks")]
    best = rows[0] if rows else None
    path = work.reports() / "tracker.md"
    path.write_text("# Tracker settings at production cadence\n\nDetections are tracked again every "
                    f"{args.every} frames, scan window by scan window ({args.scan_seconds:g} s), as production does. Judged on every labelled track: "
                    "**merged ids** = one id covered two different labelled faces (the dangerous failure: two people pooled into one), **extra ids** = ids a student "
                    "received beyond one (their looks are split). Every setting is listed, best first.\n\n" + L.md_table(rows, cols) +
                    (f"\n\nBest: {best['assignment']}, iou {best['iou']}, max_center_dist {best['max_center_dist']}, max_missed {best['max_missed']}. "
                     "If several settings tie at zero merges, prefer the middle of that range, not its edge." if best else ""), encoding="utf-8")
    L.write_csv(work.reports() / "tracker.csv", rows)
    print(f"Wrote {path}")
    return rows


def cmd_adjudicate(args, work, ask=None, say=print):
    ask = ask or input
    """Show the faces the system NAMED that you never labelled; answer once (y = that is the student, n = it is not)."""
    clips = sorted(work.clips())
    stem = Path(args.model).stem
    settings_path, study_path = work.root / f"settings.{stem}.json", work.root / f"study.{stem}.json"
    chosen = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    study = json.loads(study_path.read_text()) if study_path.exists() else {}
    model = MODEL_FACTORY(args, args.model)
    cfg = crop_ops.CropConfig(**study["crop"]) if study.get("crop") else model.recognizer.crop_config
    looks = get_looks(work, model, cfg, clips, args, per_track=None, include_unknown=True)
    gallery = extract_gallery(work, model, cfg, args.gallery)
    emb, names = L.apply_recipe(gallery, recipe_for(args, study.get("gallery_recipe", "clean")))
    frames = L.clip_frames(looks)
    identity = {n: {"student_id": n, "name": n} for n in set(names)}
    adjud = work.adjudications()
    display = Display(work, gui=not args.no_gui)
    ctx = SimpleNamespace(settings=L.settings_namespace(**{k: v for k, v in chosen.items() if k in PROFILE_KEYS}), tp=tracker_params(args))
    todo = {}
    for clip in clips:
        fps = work.clips()[clip]["fps"]
        for lo, hi in L.scan_windows(len(frames[clip]), window_frames_for(args, fps), hop_frames_for(args, fps)):
            res = L.replay_window(frames[clip][lo:hi], (emb, names), identity, ctx.settings, ctx.tp, args.det_thresh, adjud, clip)
            for e in res["unverified"]:
                key = (clip, e["dense"], e["student"])
                if key not in adjud:
                    todo.setdefault(key, e)
    say(f"{len(todo)} unlabelled faces were named by the system and need a yes / no.")
    for n, ((clip, dense, student), e) in enumerate(sorted(todo.items()), 1):
        image = cv2.imread(str(work.frame_path(clip, e["pos"])))
        frame = {"dets": [{"bbox": e["bbox"]}]}
        display.show(image, frame, 0, {0: student})
        answer = ask(f"  {n}/{len(todo)} {clip}: is this {student} (score {e['score']:.2f})? [y/n/Enter skip/q] > ").strip().lower()
        if answer == "q":
            break
        if answer in ("y", "n"):
            adjud[(clip, dense, student)] = answer == "y"
            work.save_adjudications(adjud)
    if display.gui:
        cv2.destroyAllWindows()


# ============================================================================================ selftest, plan, manifest
def cmd_selftest(args, work=None):
    results = L.selftest_report(args.seed, quick=args.quick)
    lines = ["# Self-test of the statistics", "", "| check | result | detail |", "|---|---|---|"]
    ok = True
    for name, passed, detail in results:
        ok &= bool(passed)
        lines.append(f"| {name} | {'PASS' if passed else '**FAIL**'} | {str(detail)[:80]} |")
        print(f"  {'PASS' if passed else 'FAIL'}  {name}  ({str(detail)[:70]})")
    if work is not None:
        (work.reports() / "selftest.md").write_text("\n".join(lines), encoding="utf-8")
    print("Self-test: " + ("all checks passed" if ok else "FAILED - do not trust the reports until this is fixed"))
    return ok


def cmd_plan(args, work):
    """What would be embedded, and roughly how long it takes. Runs no model."""
    clips = sorted(work.clips())
    tune, test = split_clips(work.clips(), args.test_clips)
    counts = {"part1": 0, "sweepA": 0, "full": 0}
    for clip in clips:
        if not work.labels(clip):
            continue
        counts["part1"] += len(target_detections(work, clip, args, args.probe_looks, False))
        counts["sweepA"] += len(target_detections(work, clip, args, args.sweep_looks, False)) if clip in tune else 0
        counts["full"] += len(target_detections(work, clip, args, None, True))
    n_models = max(1, len(args.models_to_test))
    n_cfg = len(stage_a_configs(crop_ops.CropConfig(), args.quick, True))
    plan = [("Part 1: every model, first %d looks of each labelled track" % args.probe_looks, counts["part1"] * n_models),
            ("Part 2 stage A: %d crop settings, %d looks per track, tune clips" % (n_cfg, args.sweep_looks), counts["sweepA"] * n_cfg),
            ("Part 2 stages B-D: every face at production cadence (once)", counts["full"])]
    print(f"{len(clips)} clips ({len(tune)} tune / {len(test)} test); embedding at {args.ms_per_face:g} ms/face (set --ms-per-face from `models.md`).")
    total = 0
    for what, n in plan:
        total += n
        print(f"  {what}: {n:,} faces  ~ {n * args.ms_per_face / 60000:.0f} min")
    print(f"  total ~ {total * args.ms_per_face / 3600000:.1f} h of embedding, plus the decision replay (~ tens of minutes)")


def file_sha(path, limit=1 << 26):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            h.update(fh.read(limit))
        return h.hexdigest()[:16]
    except OSError:
        return None


def write_manifest(args, work, ledger=None, extra=None):
    import os
    versions = {"python": platform.python_version(), "numpy": np.__version__, "opencv": cv2.__version__}
    for mod in ("onnxruntime", "openvino", "insightface"):
        try:
            versions[mod] = __import__(mod).__version__
        except Exception:
            versions[mod] = None
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        commit = None
    manifest = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "git_commit": commit, "versions": versions,
                "env": {k: os.environ.get(k) for k in ("CCTV_BACKEND", "CCTV_DEVICE", "CCTV_PRECISION", "CCTV_KEYPOINTS", "CCTV_REC_MODEL")},
                "models": {m: file_sha(Path(args.models) / m) for m in list(getattr(args, "models_to_test", []) or [])},
                "args": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items() if not k.startswith("_")},
                "comparisons": ledger.total if ledger else None, **(extra or {})}
    (work.reports() / "run_manifest.json").write_text(json.dumps(manifest, indent=1, default=str), encoding="utf-8")


# ============================================================================================ FINAL report
def trust_checks(args, work, summary, models_res, sweep_res, selftest_ok):
    """[(status, text)] - status PASS / WARN / FAIL. These are the things that decide whether the numbers can be relied on."""
    import os
    checks = []

    def add(ok, text, severe=False):
        checks.append(("PASS" if ok else "FAIL" if severe else "WARN", text))

    add(selftest_ok, "statistics self-test passed", severe=True)
    add(summary["clips"] >= 5, f"{summary['clips']} clips (>= 5 recommended)")
    add(len(sweep_res["test"]) >= 2, f"{len(sweep_res['test'])} held-out test clips (>= 2 recommended)")
    add(summary["n_students"] >= 30, f"{summary['n_students']} distinct labelled students (>= 30 recommended)")
    add(summary["student_tracks"] >= 150, f"{summary['student_tracks']} student tracks (>= 150 recommended for 5-point differences)")
    add(summary["impostor_tracks"] >= 100, f"{summary['impostor_tracks']} impostor (x / n) tracks: open-set false accepts at 1% need >= 100, at 0.1% >= 1000")
    total_students = summary["student_tracks"] or 1
    add(summary["unverified_students"] / total_students <= 0.25, f"{summary['unverified_students']}/{total_students} student tracks were never confirmed on a later frame (<= 25%)")
    add(summary["swaps"] / total_students <= 0.05, f"{summary['swaps']} tracks dropped as swap suspects (<= 5% of student tracks)")
    typed = summary["typed"] / max(summary["typed"] + summary["suggested"], 1)
    add(typed >= 0.9, f"{typed:.0%} of labels were typed, not accepted from a suggestion (>= 90%; suggestions bias the ground truth toward the model that made them)")
    if summary["audit"]:
        kappa = float(np.nanmean([a["kappa"] for a in summary["audit"]]))
        add(kappa >= 0.9, f"label audit kappa {kappa:.2f} (>= 0.90)")
    else:
        add(False, "label audit not run (python bakeoff.py audit): label noise is unknown")
    add(os.environ.get("CCTV_PRECISION", "").lower() == "f32", f"CCTV_PRECISION={os.environ.get('CCTV_PRECISION')!r} (f32 recommended; f16 on the iGPU shifts embeddings)")
    add(not args.use_cctv, "gallery contains no CCTV crops (no leakage)" if not args.use_cctv else "--use-cctv: CCTV crops in the gallery may come from the tested clips")
    d = sweep_res["d"]
    add(d["budget_met"], f"a decision setting met the error budget of {args.max_bad_per_scan:g} errors per scan on the tune clips", severe=True)
    add(d["loco"] is not None and d["loco"]["held_out"] is not None, "leave-one-clip-out estimate available (>= 2 tune clips)")
    chosen_t = [e for n, e in d["eval"].items() if n == "CHOSEN"][0]
    if chosen_t["test"]:
        t = L.add_totals(list(chosen_t["test"].values()))
        add(t["windows"] >= 20, f"{t['windows']} test scans ({t['present']} student-scans): intervals on the test result are wide below ~20 scans")
    paired = models_res["paired"] if models_res else []
    wide = [p for p in paired if p["verdict"] == "inconclusive" and p["mde"] > args.equiv_margin]
    add(not wide, "every model comparison was either decided or has a minimum detectable difference within the margin"
        if not wide else f"{len(wide)} model comparison(s) inconclusive with MDE > margin: more clips needed to separate them")
    return checks


def write_final(args, work, models_res, sweep_res, detector_rows, tracker_rows, selftest_ok, ledger, summary):
    d = sweep_res["d"]
    checks = trust_checks(args, work, summary, models_res, sweep_res, selftest_ok)
    n_fail = sum(c[0] == "FAIL" for c in checks)
    n_warn = sum(c[0] == "WARN" for c in checks)
    chosen_test = d["eval"]["CHOSEN"]["test"]
    prod_test = d["eval"]["production defaults (0.26 / 0.28, no margin)"]["test"]
    lines = ["# Bakeoff - final report", "",
             f"**Verdict on trust:** {'DO NOT RELY ON THESE NUMBERS' if n_fail else 'usable with the caveats below' if n_warn else 'all trust checks passed'} "
             f"({n_fail} failed, {n_warn} warnings).", "",
             "## Decision", "",
             f"- **Model:** {args.model}" + (f" - {models_res['reason']}." if models_res else " (chosen by hand)."),
             f"- **Crop:** {sweep_res['a']['note']}.", f"- **Gallery:** {sweep_res['b']['note']}.", f"- **Pooling:** {sweep_res['c']['note']}.",
             f"- **Decision settings:** see `{Path(sweep_res['profile']).name}` (copy to `models/{Path(args.model).stem}.settings.json`). Adopted: "
             + "; ".join(f"{f} -> {v}" for f, v in d["adopted"]) + ".", ""]
    if chosen_test:
        t, p = L.add_totals(list(chosen_test.values())), L.add_totals(list(prod_test.values()))
        ci = L.clip_bootstrap_totals(chosen_test, args.boot, args.seed)
        lines += ["## Held-out test result (clips never used for any choice)", "",
                  f"- Chosen settings: recall **{t['recall']:.1%}** (95% CI {ci['recall'][0]:.1%}-{ci['recall'][1]:.1%}), {t['wrong']} wrong, {t['false_accept']} false accepts, "
                  f"{t['unverified']} unverified, over {t['windows']} scans ({t['present']} student-scans).",
                  f"- Old production defaults on the same clips: recall {p['recall']:.1%}, {p['wrong']} wrong, {p['false_accept']} false accepts.", ""]
    else:
        lines += ["## No held-out test result", "", "Fewer than 3 clips: nothing was held out, so the numbers are optimistic.", ""]
    lines += ["## Trust checks", ""] + [f"- **{s}** - {text}" for s, text in checks] + ["",
              f"{ledger.total} paired comparisons were made (Holm-corrected within each family). Details: `sweep.md`, `models.md`, `detector.md`, `tracker.md`, `selftest.md`, `run_manifest.json`.", "",
              "## Next actions", ""]
    actions = [text for s, text in checks if s != "PASS"]
    lines += [f"- {a}" for a in actions] or ["- none"]
    (work.reports() / "FINAL.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {work.reports() / 'FINAL.md'}")
    return checks


def cmd_all(args, work):
    ledger = L.Ledger()
    print("Self-test of the statistics")
    selftest_ok = cmd_selftest(args, work)
    print("Step 1/6: prep")
    cmd_prep(args, work)
    print("Step 2/6: label (every face you can; x / n faces are the false-accept measurement)")
    cmd_label(args, work)
    if args.audit:
        print("Step 2b: label audit")
        cmd_audit(args, work)
    summary = data_summary(work, sorted(work.clips()))
    models_res = None
    if len(args.models_to_test) >= 1:
        print("Step 3/6: models")
        models_res = cmd_models(args, work, ledger)
        args.model = args.model or models_res["winner"]
    print("Step 4/6: sweep")
    sweep_res = cmd_sweep(args, work, ledger)
    print("Step 5/6: detector")
    det = cmd_detector(args, work)
    print("Step 6/6: tracker")
    trk = cmd_tracker(args, work)
    write_manifest(args, work, ledger)
    write_final(args, work, models_res, sweep_res, det, trk, selftest_ok, ledger, summary)


# ============================================================================================ CLI
def build_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["prep", "label", "audit", "extract", "models", "sweep", "adjudicate", "detector", "tracker", "selftest", "plan", "all"])
    p.add_argument("--videos", nargs="*", default=[], help="clips (paths or globs)")
    p.add_argument("--work", default=str(HERE / "bakeoff_work"))
    p.add_argument("--gallery", default=str(HERE / "gallery"))
    p.add_argument("--models", default=str(HERE / "models"))
    p.add_argument("--models-to-test", nargs="*", default=[], help="recognizer files in --models; the FIRST is the control (usually the model in production)")
    p.add_argument("--model", default=None, help="the model for sweep / detector / adjudicate (default: the winner of `models`, else the first)")
    p.add_argument("--rec-model", default=recognize.DEFAULT_REC_FILENAME, help="recognizer loaded by prep (only its detector is used)")
    g = p.add_argument_group("frames and scans (production cadence)")
    g.add_argument("--step", type=int, default=6, help="prep samples every Nth native frame")
    g.add_argument("--every", type=int, default=18, help="PRODUCTION processes every Nth native frame (a multiple of --step)")
    g.add_argument("--seconds", type=float, default=30, help="seconds of each clip to prepare")
    g.add_argument("--scan-seconds", type=float, default=10, help="length of a simulated production scan")
    g.add_argument("--window-hop", type=float, default=5, help="seconds between the start offsets of simulated scans")
    g.add_argument("--scan-curve", type=float, nargs="*", default=[4, 6, 8, 10, 15, 20])
    d = p.add_argument_group("detection")
    d.add_argument("--det-size", default="1920x1080")
    d.add_argument("--det-thresh", type=float, default=0.3, help="production detector threshold (the replay ignores faces below it)")
    d.add_argument("--prep-thresh", type=float, default=0.15, help="permissive threshold at prep, so there is something to label")
    d.add_argument("--embed-thresh", type=float, default=0.2, help="faces below this are never embedded")
    d.add_argument("--det-sizes", nargs="*", default=["1920x1088", "2560x1440"])
    d.add_argument("--det-threshes", type=float, nargs="*", default=[0.15, 0.2, 0.3, 0.4])
    t = p.add_argument_group("tracker")
    t.add_argument("--assignment", default="hungarian", help="tracker used for the labelling pass")
    t.add_argument("--tracker-assignment", default="hungarian")
    t.add_argument("--tracker-iou", type=float, default=0.3)
    t.add_argument("--tracker-dist", type=float, default=1.0)
    t.add_argument("--tracker-missed", type=int, default=15)
    s = p.add_argument_group("statistics")
    s.add_argument("--metric", default="auc", choices=["auc", "top1", "dprime", "dir@far0.01", "odir@far0.01"])
    s.add_argument("--weighting", default="balanced", choices=["balanced", "look"], help="balanced: every track has equal weight")
    s.add_argument("--boot", type=int, default=2000, help="bootstrap draws (>= 20 x the number of comparisons per family for Holm)")
    s.add_argument("--equiv-margin", type=float, default=0.01, help="differences smaller than this do not matter ('equivalent')")
    s.add_argument("--max-bad-per-scan", type=float, default=0.02, help="error budget (wrong + false accepts per scan) when choosing thresholds")
    s.add_argument("--adopt-gain", type=float, default=0.01, help="a variant is adopted only if recall rises by at least this")
    s.add_argument("--seed", type=int, default=0)
    s.add_argument("--test-clips", nargs="*", default=None, help="clips held out for the final test (default: every third clip)")
    s.add_argument("--hybrid-widths", type=int, nargs="*", default=[20, 30])
    s.add_argument("--gallery-sizes", type=int, nargs="*", default=[10, 25, 50, 100])
    w = p.add_argument_group("work and labelling")
    w.add_argument("--probe-looks", type=int, default=12, help="looks per labelled track in Part 1")
    w.add_argument("--sweep-looks", type=int, default=6, help="looks per labelled track in the crop / gallery sweeps (cheaper)")
    w.add_argument("--verify-frames", type=int, default=2)
    w.add_argument("--audit", action="store_true", help="in `all`: also run the label audit")
    w.add_argument("--audit-fraction", type=float, default=0.1)
    w.add_argument("--use-cctv", action="store_true", help="allow saved CCTV crops in the gallery (leakage risk)")
    w.add_argument("--no-gui", action="store_true")
    w.add_argument("--redo", action="store_true")
    w.add_argument("--force", action="store_true")
    w.add_argument("--quick", action="store_true", help="smaller grids (smoke test, not for the final run)")
    w.add_argument("--ms-per-face", type=float, default=40.0)
    return p


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    videos = []
    for pattern in args.videos:
        matches = sorted(glob.glob(pattern))
        if glob.has_magic(pattern):
            if not matches:
                parser.error(f"--videos pattern matched no files: {pattern}")
            videos.extend(matches)
        else:
            videos.append(pattern)
    args.videos = videos
    work = Work(args.work)
    if args.command in ("sweep", "adjudicate", "detector") and not args.model:
        if not args.models_to_test:
            parser.error("--model (or --models-to-test) is required")
        args.model = args.models_to_test[0]
    if args.command == "extract":
        for model_file in args.models_to_test:
            model = MODEL_FACTORY(args, model_file)
            prepare(args, work, model, model.recognizer.crop_config, sorted(work.clips()), per_track=args.probe_looks, include_unknown=False)
        return
    if args.command == "selftest":
        sys.exit(0 if cmd_selftest(args, work) else 1)
    if args.command == "all" and not videos and not work.clips():
        parser.error("--videos is required for `all` on a new work folder")
    if args.command != "plan":
        write_manifest(args, work)
    {"prep": cmd_prep, "label": cmd_label, "audit": cmd_audit, "models": cmd_models, "sweep": cmd_sweep, "adjudicate": cmd_adjudicate,
     "detector": cmd_detector, "tracker": cmd_tracker, "plan": cmd_plan, "all": cmd_all}[args.command](args, work)


if __name__ == "__main__":
    main()