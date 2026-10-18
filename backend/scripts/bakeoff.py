#!/usr/bin/env python3
"""
bakeoff.py - which recognizer, and which settings, work best on YOUR cameras and YOUR students? Measure, don't guess.

You label each clip once (about 4 minutes); everything else runs by itself and ends in written reports.

    python scripts/bakeoff.py all --videos ./*.avi --models-to-test adaface_ir101_webface4m.onnx adaface_ir101_webface12m.onnx adaface_vit_kprpe_webface12m.onnx

or step by step (each step resumes where it stopped and reuses what it already computed):

  prep       sample frames from each clip, detect + track every face once          (work/<clip>/dets.json)
  label      ask you who each face is, ONCE per clip (frame A), then ONE more check at a later frame (frame B).
             Labels follow the tracker, so a student you name once is named in every frame of the clip. Frame B
             shows the propagated names: Enter = right. It measures how often the tracker swapped neighbours, and
             any track whose two labels disagree is dropped ('?') instead of poisoning the results.
  extract    embed every labelled face and the whole gallery with each model / crop setting   (work/emb/...)
  models     PART 1: which recognizer separates your students best?  -> work/reports/models.md
  sweep      PART 2: on the chosen model, which crop / TTA / gallery / pooling / decision settings help?
             -> work/reports/sweep.md and work/settings.<model>.json (recognize.py reads <model>.settings.json)
  adjudicate show the few faces the system named that you never labelled; answer y/n once, results are reused
  detector   detector settings (det_size, det_thresh): how many labelled faces they find, by face width
  tracker    tracker settings: how often neighbours are swapped (needs the two labelled frames)

Honesty rules built in: confidence intervals resample STUDENTS, not frames; settings are chosen on the dev clips and
reported on the held-out test clips; saved CCTV crops are NOT used in the gallery unless you pass --use-cctv (they can
come from the very clips being tested). Read work/reports/*.md for what was measured and how.
"""
import argparse
import glob
import hashlib
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import bakeoff_lib as L
import crop_ops
import recognize
from enroll_qa import SELF_PHOTO
from gallery_extras import degrade_photo, is_cctv_crop
from tracker import Tracker

HERE = Path(__file__).resolve().parent.parent
DEGRADE_WIDTHS = (20, 28, 36)
GALLERY_EXTRACT_VERSION = "1"


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
        return self._json(self.clip_dir(clip) / "dets.json")

    def labels(self, clip):
        data = self._json(self.clip_dir(clip) / "labels.json")
        if data:
            data["labels"] = {int(k): v for k, v in data.get("labels", {}).items()}
            for key in ("first_answers", "verify_answers"):
                data[key] = {int(k): v for k, v in data.get(key, {}).items()}
        return data

    def save_labels(self, clip, data):
        (self.clip_dir(clip) / "labels.json").write_text(json.dumps(data, indent=1), encoding="utf-8")

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


def make_model(args, rec_filename, crop_config=None):
    return recognize.FaceModel(args.models, recognize.parse_det_size(args.det_size), args.det_thresh, rec_filename,
                               crop_config=crop_config)


MODEL_FACTORY = make_model   # tests replace this with a fake


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
    """(dev clips, test clips). Default: the last third of the clips (by name) are held out."""
    names = sorted(clips)
    if test_clips:
        test = [c for c in names if c in set(test_clips)]
    else:
        test = names[len(names) - max(1, len(names) // 3):] if len(names) > 1 else []
    dev = [c for c in names if c not in test]
    return dev, test


# ============================================================================================ prep
def cmd_prep(args, work):
    model = MODEL_FACTORY(args, args.rec_model)
    clips = work.clips()
    for video in args.videos:
        clip = Path(video).stem
        if work.dets(clip) and not args.force:
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
        data = {"video": str(Path(video).resolve()), "fps": fps, "step": args.step, "size": size, "frames": frames,
                "det_size": args.det_size, "det_thresh": args.det_thresh}
        (work.clip_dir(clip) / "dets.json").write_text(json.dumps(data), encoding="utf-8")
        clips[clip] = {"video": data["video"], "fps": fps, "step": args.step, "n_frames": len(frames)}
        n_tracks = len({d["track"] for fr in frames for d in fr["dets"]})
        print(f"  {clip}: {len(frames)} frames sampled, {n_tracks} tracks")
    work.save_clips(clips)


# ============================================================================================ labelling
def prompt_for_label(roster, ask=input, say=print, current=None, suggestion=None):
    """
    Ask about ONE face. Returns ('label', value) | ('skip', None) | ('quit', None).
      type part of a name or the roll number   -> a search; pick from the list if there are several
      ?  unsure (face is never scored)    x  not a student / ignore    Enter  skip (or keep `current`)    q  save and stop
    """
    hint = []
    if current not in (None, ""):
        hint.append(f"Enter = keep '{current}'")
    elif suggestion:
        hint.append(f"Enter = accept suggestion {suggestion[0]} ({suggestion[1]:.2f})")
    else:
        hint.append("Enter = skip")
    while True:
        text = ask(f"   who? [{'; '.join(hint)}; ? unsure; x not a student; q quit] > ").strip()
        if text == "":
            if current not in (None, ""):
                return "label", current
            if suggestion:
                return "label", suggestion[0]
            return "skip", None
        if text.lower() == "q":
            return "quit", None
        if text in ("?", "x"):
            return "label", text
        matches = roster.search(text)
        if not matches:
            say("   no student matches that, try again")
        elif len(matches) == 1:
            return "label", matches[0]
        else:
            for i, m in enumerate(matches, 1):
                say(f"     {i}. {m}")
            pick = ask("   number (or Enter to search again) > ").strip()
            if pick.isdigit() and 1 <= int(pick) <= len(matches):
                return "label", matches[int(pick) - 1]


class Display:
    """Shows the frame with numbered boxes and a zoomed view of the face being asked about. Falls back to a jpg file."""

    def __init__(self, work, gui=True):
        self.path = work.root / "label_view.jpg"
        self.gui = gui

    def show(self, image, frame, highlight, names):
        out = image.copy()
        scale = max(1.0, image.shape[1] / 1600)
        for i, det in enumerate(frame["dets"]):
            x1, y1, x2, y2 = (int(v) for v in det["bbox"])
            color = (0, 255, 255) if i == highlight else (0, 200, 0)
            cv2.rectangle(out, (x1, y1), (x2, y2), color, max(1, int(scale)) + (1 if i == highlight else 0))
            tag = str(i + 1) + (f" {names.get(i)}" if names.get(i) else "")
            cv2.putText(out, tag[:22], (x1, max(12, y1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.45 * scale, color, 1, cv2.LINE_AA)
        if highlight is not None:
            x1, y1, x2, y2 = (int(v) for v in frame["dets"][highlight]["bbox"])
            pad = int(0.4 * max(x2 - x1, y2 - y1))
            zoom = image[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
            if zoom.size:
                zoom = cv2.resize(zoom, (240, 240), interpolation=cv2.INTER_CUBIC)
                out[0:240, 0:240] = zoom
        if self.gui:
            try:
                cv2.imshow("bakeoff label", out)
                cv2.waitKey(1)
                return
            except cv2.error:
                self.gui = False
        cv2.imwrite(str(self.path), out)


def ask_about_frame(frame, image, roster, display, ask, say, current_labels=None, suggestions=None, title=""):
    """Walk through every box of one frame. Returns ({detection index: label or None}, quit?)."""
    answers, quit_ = {}, False
    shown = {i: current_labels.get(d["track"]) if current_labels else None for i, d in enumerate(frame["dets"])}
    say(f"\n{title}: {len(frame['dets'])} faces. Look at the window (or {display.path}).")
    for i, det in enumerate(frame["dets"]):
        display.show(image, frame, i, {k: v for k, v in {**shown, **{k: v for k, v in answers.items() if v}}.items()})
        say(f" face {i + 1}/{len(frame['dets'])} (width {det['bbox'][2] - det['bbox'][0]:.0f}px)")
        kind, value = prompt_for_label(roster, ask, say, current=shown.get(i) if current_labels else None,
                                       suggestion=(suggestions or {}).get(i))
        if kind == "quit":
            quit_ = True
            break
        answers[i] = value if kind == "label" else None
    return answers, quit_


def cmd_label(args, work, ask=input, say=print):
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
        first_pos, verify_pos = L.choose_label_frames(frames)
        data = data or {"labels": {}, "first_answers": {}, "verify_answers": {}, "swaps": []}
        data.update({"first_pos": first_pos, "verify_pos": verify_pos, "done": False})
        # --- frame A: name every face once
        if not data["first_answers"]:
            image = cv2.imread(str(work.frame_path(clip, first_pos)))
            suggestions = args._suggestions(clip, first_pos) if getattr(args, "_suggestions", None) else None
            answers, quit_ = ask_about_frame(frames[first_pos], image, roster, display, ask, say, suggestions=suggestions,
                                             title=f"{clip} - frame A (position {first_pos})")
            for note in L.apply_first_labels(data["labels"], frames[first_pos], answers):
                say("   note: " + note)
            data["first_answers"] = {i: a for i, a in answers.items() if a is not None}
            work.save_labels(clip, data)
            if quit_:
                return
        # --- frame B: confirm the propagated names later in the clip (swap check)
        if verify_pos != first_pos and not data["verify_answers"]:
            image = cv2.imread(str(work.frame_path(clip, verify_pos)))
            answers, quit_ = ask_about_frame(frames[verify_pos], image, roster, display, ask, say,
                                             current_labels=data["labels"], title=f"{clip} - frame B (position {verify_pos}); Enter keeps the name shown")
            report = L.apply_verify_labels(data["labels"], frames[verify_pos], answers)
            data["verify_answers"] = {i: a for i, a in answers.items() if a is not None}
            data["swaps"] = report["swaps"]
            say(f"   check: {report['agree']}/{report['checked']} names agreed, {len(report['swaps'])} tracks dropped as swap suspects, "
                f"{report['added']} faces added")
            work.save_labels(clip, data)
            if quit_:
                return
        data["done"] = True
        work.save_labels(clip, data)
        n = len(L.student_labels(data["labels"]))
        say(f"  {clip}: {n} tracks labelled with a student")
    cv2.destroyAllWindows() if display.gui else None


# ============================================================================================ extraction
def _unit(v):
    return v / max(float(np.linalg.norm(v)), 1e-9)


def extract_probes(work, model, cfg, clips, force=False):
    """Embed every labelled face (every sampled frame) with `cfg`. One .npz per clip."""
    model.recognizer.crop_config = cfg
    folder = work.root / "emb" / model_dirname(model) / cfg_dirname(cfg)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "config.json").write_text(json.dumps({"crop": cfg.as_dict(), "label": cfg.label(), "tag": model.cache_tag}), encoding="utf-8")
    for clip in clips:
        path = folder / f"{clip}.npz"
        if path.exists() and not force:
            continue
        dets, label_data = work.dets(clip), work.labels(clip)
        labels = L.student_labels(label_data["labels"]) if label_data else {}
        rows = {k: [] for k in ("track", "frame", "emb", "norm", "sharp", "width", "height", "det", "label")}
        for frame in dets["frames"]:
            todo = [d for d in frame["dets"] if d["track"] in labels]
            if not todo:
                continue
            image = cv2.imread(str(work.frame_path(clip, frame["pos"])))
            faces = [SimpleNamespace(bbox=np.asarray(d["bbox"]), kps=np.asarray(d["kps"], dtype=np.float32)) for d in todo]
            model.recognizer.get_batch(image, faces, role="cctv")
            for d, f in zip(todo, faces):
                rows["track"].append(d["track"]); rows["frame"].append(frame["pos"])
                rows["emb"].append(_unit(np.asarray(f.embedding, dtype=np.float32))); rows["norm"].append(float(f.quality))
                rows["sharp"].append(sharpness(image, d["bbox"])); rows["width"].append(d["bbox"][2] - d["bbox"][0])
                rows["height"].append(d["bbox"][3] - d["bbox"][1]); rows["det"].append(d["det"]); rows["label"].append(labels[d["track"]])
        dim = model.recognizer.dim
        np.savez(path, **{k: (np.stack(v) if k == "emb" and v else np.zeros((0, dim), np.float32) if k == "emb"
                              else np.array(v, dtype=object if k == "label" else float if k != "track" and k != "frame" else int))
                          for k, v in rows.items()})
    return folder


def load_probes(folder, clips):
    parts = []
    for clip in clips:
        path = folder / f"{clip}.npz"
        if not path.exists():
            continue
        z = np.load(path, allow_pickle=True)
        if len(z["track"]):
            parts.append({k: z[k] for k in z.files} | {"clip": np.array([clip] * len(z["track"]), dtype=object)})
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
    done = 0
    for name, photo in photos:
        key = hashlib.sha1(f"{GALLERY_EXTRACT_VERSION}|{photo.resolve()}|{photo.stat().st_size}|{photo.stat().st_mtime_ns}".encode()).hexdigest()
        cache = folder / "photos" / name / f"{key}.npz"
        if cache.exists():
            z = np.load(cache, allow_pickle=True)
            rows = list(zip(z["emb"], [str(t) for t in z["tags"]])) if len(z["tags"]) else []
        else:
            try:
                rows = photo_rows(model, photo, DEGRADE_WIDTHS)
            except Exception as error:   # a damaged picture is skipped, never fatal
                log(f"  gallery: skipped {name}/{photo.name} ({type(error).__name__}: {error})")
                continue
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.savez(cache, emb=np.stack([r[0] for r in rows]) if rows else np.zeros((0, model.recognizer.dim), np.float32),
                     tags=np.array([r[1] for r in rows], dtype=object))
            done += 1
        for e, t in rows:
            emb.append(e); student.append(name); kind.append(photo_kind(photo)); tag.append(t); shot.append(shot_of(photo))
    log(f"  gallery [{cfg.label()}]: {len(emb)} rows ({done} photos embedded now)")
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


def prepare(args, work, model, cfg, clips, use_cctv=False):
    """Probes + gallery for one (model, crop setting): (looks, gallery) ready for scoring."""
    folder = extract_probes(work, model, cfg, clips)
    looks = load_probes(folder, clips)
    gallery = extract_gallery(work, model, cfg, args.gallery)
    return looks, gallery


def recipe_for(args, name="clean"):
    recipe = dict(L.RECIPES[name])
    if not args.use_cctv:
        recipe["kinds"] = set(recipe["kinds"]) - {"cctv"}
    return recipe


def score(looks, gallery, recipe, aggregator="max"):
    emb, names = L.apply_recipe(gallery, recipe)
    gi = L.genuine_impostor(looks["emb"], looks["label"], emb, names, aggregator)
    return gi


# ============================================================================================ reports: models (part 1)
def metrics_row(name, gi, clusters, with_ci=True, n_boot=200):
    v = gi["valid"]
    g, h = gi["g"][v], gi["h"][v]
    row = {"name": name, **L.roc_metrics(g, h)}
    if with_ci and len(g) > 5:
        for key in ("auc", "top1", "dir@far0.01"):
            lo, hi = L.bootstrap_ci(g, h, np.asarray(clusters)[v], key, n_boot)
            row[f"{key} CI"] = f"{lo:.3f}-{hi:.3f}"
    return row


def cmd_models(args, work):
    clips = sorted(work.clips())
    dev, test = split_clips(work.clips(), args.test_clips)
    use = clips                                    # Part 1 uses every labelled clip: no tuning happens here
    results = []
    for model_file in args.models_to_test:
        model = MODEL_FACTORY(args, model_file)
        cfg = model.recognizer.crop_config
        looks, gallery = prepare(args, work, model, cfg, use)
        if looks is None:
            print(f"  ! no labelled faces for {model_file}")
            continue
        results.append({"file": model_file, "model": model, "looks": looks, "gallery": gallery, "cfg": cfg,
                        "quality": quality_mode_for(model_file, args.models)})
        print(f"  {model_file}: {len(looks['track'])} looks embedded")
    if not results:
        sys.exit("nothing to compare")
    control = results[0]
    rows, track_rows, strata = [], [], []
    for r in results:
        gi = score(r["looks"], r["gallery"], recipe_for(args))
        r["gi"] = gi
        row = metrics_row(r["file"], gi, r["looks"]["label"])
        rows.append(row)
        pooled = L.pool_tracks(r["looks"], quality=r["quality"])
        gi_t = L.genuine_impostor(pooled["emb"], pooled["label"], *L.apply_recipe(r["gallery"], recipe_for(args)))
        r["gi_track"], r["pooled"] = gi_t, pooled
        track_rows.append(metrics_row(r["file"], gi_t, pooled["label"]))
        for lo, hi in ((0, 20), (20, 30), (30, 50), (50, 1e9)):
            sel = (r["looks"]["width"] >= lo) & (r["looks"]["width"] < hi) & gi["valid"]
            if sel.sum() >= 5:
                strata.append({"name": r["file"], "width": f"{lo}-{hi:g}px" if hi < 1e8 else f"{lo}+px", **{k: v for k, v in
                               L.roc_metrics(gi["g"][sel], gi["h"][sel]).items() if k in ("n", "top1", "auc", "dir@far0.01")}})
    paired = []
    for r in results[1:]:
        common = control["gi"]["valid"] & r["gi"]["valid"]
        for level, a, b, clusters in (("look", r["gi"], control["gi"], r["looks"]["label"]),
                                      ("track", r["gi_track"], control["gi_track"], r["pooled"]["label"])):
            valid = a["valid"] & b["valid"]
            diff, lo, hi = L.bootstrap_diff(a["g"][valid], a["h"][valid], b["g"][valid], b["h"][valid],
                                            np.asarray(clusters)[valid], args.metric, args.boot)
            paired.append({"model": r["file"], "level": level, "vs": control["file"], "metric": args.metric,
                           "difference": diff, "CI": f"{lo:.3f} to {hi:.3f}", "verdict": L.verdict(lo, hi)})
    cols = [("name", "model"), ("n", "n"), ("top1", "top-1"), ("top1 CI", "top-1 95% CI"), ("auc", "AUC"), ("auc CI", "AUC 95% CI"),
            ("eer", "EER"), ("dir@far0.01", "DIR@FAR 1%"), ("dir@far0.01 CI", "DIR@FAR 1% CI"), ("dprime", "d'"), ("margin", "mean margin"),
            ("thr@far0.01", "threshold @FAR 1%")]
    text = ["# Part 1 - model bakeoff", "",
            f"Clips: {len(use)}; {len(set(control['looks']['label']))} students, "
            f"{len(set(zip(control['looks']['clip'], control['looks']['track'])))} labelled tracks, {len(control['looks']['track'])} looks. "
            f"Gallery recipe: clean phone photos{' + CCTV crops (LEAKAGE RISK)' if args.use_cctv else ''}. Each model with its own default crop settings.",
            f"Control for paired comparisons: **{control['file']}**. Intervals resample *students*, so they are wider than frame-level ones, on purpose.",
            "", "## Per look (one detection of a labelled face in one sampled frame)", "", L.md_table(rows, cols), "",
            "## Per track (pooled quality-weighted looks, like production)", "", L.md_table(track_rows, cols), "",
            "## Paired differences vs the control (same faces, student-level bootstrap)", "",
            L.md_table(paired, [("model", "model"), ("level", "level"), ("metric", "metric"), ("difference", "difference"), ("CI", "95% CI"), ("verdict", "verdict")]),
            "", "## By face width (looks)", "", L.md_table(strata, [("name", "model"), ("width", "width"), ("n", "n"), ("top1", "top-1"), ("auc", "AUC"), ("dir@far0.01", "DIR@FAR 1%")]),
            "", "How to read it: AUC and DIR@FAR do not depend on a model's score scale, so models can be compared. "
            "'threshold @FAR 1%' is where to start tuning that model's threshold. Pick the model whose paired verdict is 'better' "
            "on the TRACK table; if nothing is clearly better, prefer the simpler / faster one."]
    path = work.reports() / "models.md"
    path.write_text("\n".join(text), encoding="utf-8")
    L.write_csv(work.reports() / "models_look.csv", rows)
    L.write_csv(work.reports() / "models_track.csv", track_rows)
    print(f"Wrote {path}")
    best = max(track_rows, key=lambda r: (r.get("auc", 0), r.get("top1", 0)))
    print(f"Best by track AUC: {best['name']}")
    return best["name"]


# ============================================================================================ part 2: sweep
def stage_a_configs(base, quick=False, uses_keypoints=False):
    """Crop settings to try, one factor at a time. Every one is the model's own base config with ONE thing changed
    (so a profile or CCTV_KEYPOINTS is never silently reset)."""
    def with_(**changes):
        return crop_ops.CropConfig(**{**base.as_dict(), **changes})

    configs = [("default", base)]
    configs += [(f"interp {i}", with_(interp=i)) for i in ("cubic", "lanczos", "area") if i != base.interp]
    enhances = crop_ops.ENHANCE_PRESETS[1:]
    if quick:
        enhances = ["gamma:0.7", "clahe:2:4", "histeq"]
    for e in enhances:
        configs.append((f"enhance {e} (all crops)", with_(enhance=e, enhance_side="both")))
        configs.append((f"enhance {e} (CCTV only)", with_(enhance=e, enhance_side="cctv")))
    if not base.flip:
        configs.append(("flip", with_(flip=True)))
    configs += [(f"jitter {k}", with_(jitter=k)) for k in ((4,) if quick else (4, 8)) if k != base.jitter]
    if uses_keypoints:   # KP-RPE models only: the landmarks the model is fed
        other = "template" if base.keypoints == "detected" else "detected"
        configs.append((f"{other} keypoints", with_(keypoints=other)))
    return configs


def compare_row(name, gi, base_gi, clusters, metric, boot):
    valid = gi["valid"] & base_gi["valid"]
    g, h = gi["g"][valid], gi["h"][valid]
    row = {"name": name, **{k: v for k, v in L.roc_metrics(g, h).items() if k in ("n", "top1", "auc", "eer", "dir@far0.01", "dprime")}}
    diff, lo, hi = L.bootstrap_diff(g, h, base_gi["g"][valid], base_gi["h"][valid], np.asarray(clusters)[valid], metric, boot)
    row.update({"diff": diff, "CI": f"{lo:.3f} to {hi:.3f}", "verdict": L.verdict(lo, hi), "_lo": lo})
    return row


def decision_rows(clip_looks, clip_labels, gallery_pair, identity, rows, clips, adjud, stride_base=1):
    out = []
    for row in rows:
        row = dict(row)
        stride = row.pop("stride", stride_base)
        args = L.settings_namespace(**row)
        totals = L.replay_all(clip_looks, clip_labels, gallery_pair, identity, args, stride=stride, adjudications=adjud, clips=clips)
        out.append({**row, "stride": stride, **{k: v for k, v in totals.items() if k != "first_attempt"}})
    return out


def fmt_range(low, high):
    return "-" if low is None else f"{low:.2f} to {high:.2f}"


def cmd_sweep(args, work):
    clips = sorted(work.clips())
    dev, test = split_clips(work.clips(), args.test_clips)
    model = MODEL_FACTORY(args, args.model)
    quality = quality_mode_for(args.model, args.models)
    base_cfg = model.recognizer.crop_config
    text = [f"# Part 2 - settings sweep for {args.model}", "",
            f"Clips: {len(clips)} (dev: {', '.join(dev) or '-'}; held-out test: {', '.join(test) or '-'}). "
            f"Crop settings, TTA, gallery and pooling are compared on ALL clips (nothing is tuned there); decision settings are chosen on dev and checked on test.", ""]

    # ---- A: crop settings
    print("Stage A: crop settings")
    base_looks, base_gallery = prepare(args, work, model, base_cfg, clips)
    base_gi = score(base_looks, base_gallery, recipe_for(args))
    rows_a, evals = [], {}
    for name, cfg in stage_a_configs(base_cfg, args.quick, model.recognizer.uses_keypoints):
        looks, gallery = (base_looks, base_gallery) if cfg == base_cfg else prepare(args, work, model, cfg, clips)
        gi = score(looks, gallery, recipe_for(args))
        evals[name] = (cfg, looks, gallery, gi)
        rows_a.append(compare_row(name, gi, base_gi, looks["label"], args.metric, args.boot))
        print(f"  {name}: {args.metric} diff {rows_a[-1]['diff']:+.4f} ({rows_a[-1]['verdict']})")
    winners = {}
    for r in rows_a:
        cfg = evals[r["name"]][0]
        factor = ("interp" if cfg.interp != base_cfg.interp else "enhance" if (cfg.enhance, cfg.enhance_side) != (base_cfg.enhance, base_cfg.enhance_side)
                  else "flip" if cfg.flip != base_cfg.flip else "jitter" if cfg.jitter != base_cfg.jitter
                  else "keypoints" if cfg.keypoints != base_cfg.keypoints else None)
        if factor and r["verdict"] == "better" and (factor not in winners or r["diff"] > winners[factor][0]["diff"]):
            winners[factor] = (r, cfg)
    text += ["## A. Crop settings (one factor at a time, vs the model's default)", "",
             L.md_table(rows_a, [("name", "setting"), ("top1", "top-1"), ("auc", "AUC"), ("dir@far0.01", "DIR@FAR 1%"), ("diff", f"{args.metric} diff"), ("CI", "95% CI"), ("verdict", "verdict")]), ""]
    best_cfg, best_name = base_cfg, "default"
    if winners:
        merged = {}
        for factor, (_, cfg) in winners.items():
            merged.update({"interp": cfg.interp} if factor == "interp" else {"enhance": cfg.enhance, "enhance_side": cfg.enhance_side} if factor == "enhance"
                          else {"flip": cfg.flip} if factor == "flip" else {"jitter": cfg.jitter} if factor == "jitter" else {"keypoints": cfg.keypoints})
        combo = crop_ops.CropConfig(**{**base_cfg.as_dict(), **merged})
        looks, gallery = prepare(args, work, model, combo, clips)
        gi = score(looks, gallery, recipe_for(args))
        row = compare_row("COMBINED winners: " + combo.label(), gi, base_gi, looks["label"], args.metric, args.boot)
        text += ["Winning single factors (clearly better than default): " + ", ".join(f"{f}: {w[1].label()}" for f, w in winners.items()) + ".", "",
                 L.md_table([row], [("name", "setting"), ("top1", "top-1"), ("auc", "AUC"), ("dir@far0.01", "DIR@FAR 1%"), ("diff", f"{args.metric} diff"), ("CI", "95% CI"), ("verdict", "verdict")]), ""]
        evals["combo"] = (combo, looks, gallery, gi)
        singles = max(winners.values(), key=lambda w: w[0]["diff"])
        pick = ("combo", combo) if row["verdict"] == "better" and row["diff"] >= singles[0]["diff"] else (singles[0]["name"], singles[1])
        best_name, best_cfg = pick
    else:
        text += ["No crop setting was clearly better than the default.", ""]
    cfg, looks, gallery, gi = evals.get(best_name, (base_cfg, base_looks, base_gallery, base_gi))
    text += [f"**Chosen crop setting: {cfg.label()}** (used below).", ""]

    # ---- B: gallery recipes and aggregators
    print("Stage B: gallery recipes")
    rows_b = []
    for rname in L.RECIPES:
        if "cctv" in rname and not args.use_cctv:
            continue
        for agg in ("max", "mean2", "mean3"):
            g2 = score(looks, gallery, recipe_for(args, rname), agg)
            rows_b.append(compare_row(f"{rname} / {agg}", g2, gi, looks["label"], args.metric, args.boot))
    shots = sorted({s for s in gallery["shot"] if s})
    for s in shots:
        r = dict(recipe_for(args)); r["exclude_shots"] = {s}
        rows_b.append(compare_row(f"clean without '{s}' photos", score(looks, gallery, r), gi, looks["label"], args.metric, args.boot))
    text += ["## B. Gallery recipe, photo aggregator, and which enrolment photos matter", "",
             "Rows 'clean without X' show what is LOST when a pose is left out (a negative difference = that pose helps).", "",
             L.md_table(rows_b, [("name", "recipe / aggregator"), ("top1", "top-1"), ("auc", "AUC"), ("dir@far0.01", "DIR@FAR 1%"), ("diff", f"{args.metric} diff vs clean/max"), ("CI", "95% CI"), ("verdict", "verdict")]), ""]
    best_b = max([r for r in rows_b if "without" not in r["name"] and r["verdict"] == "better"], key=lambda r: r["diff"], default=None)
    recipe_name, aggregator = "clean", "max"
    if best_b:
        recipe_name, aggregator = best_b["name"].split(" / ")
        text += [f"**Chosen gallery: {recipe_name}, aggregator {aggregator}.**", ""]
    final_recipe = recipe_for(args, recipe_name)

    # ---- C: pooling
    print("Stage C: pooling")
    rows_c = []
    emb_g, names_g = L.apply_recipe(gallery, final_recipe)
    base_pool = L.pool_tracks(looks, quality=quality)
    base_pool_gi = L.genuine_impostor(base_pool["emb"], base_pool["label"], emb_g, names_g, aggregator)
    variants = [("production default (first 10 looks, top 5, weighted by " + quality + ")", {})]
    variants += [(f"top_k {k}", {"top_k": k}) for k in (1, 3, 8)]
    variants += [(f"n_looks {n}", {"n_looks": n}) for n in (3, 5, 20)]
    variants += [(f"quality = {q}", {"quality": q}) for q in ("equal", "sharp", "size", "norm") if q != quality]
    variants += [("every 2nd frame", {"stride": 2}), ("every 3rd frame", {"stride": 3})]
    for name, kw in variants:
        pooled = L.pool_tracks(looks, **{"quality": quality, **kw})
        pgi = L.genuine_impostor(pooled["emb"], pooled["label"], emb_g, names_g, aggregator)
        if len(pooled["label"]) == len(base_pool["label"]):
            rows_c.append(compare_row(name, pgi, base_pool_gi, pooled["label"], args.metric, args.boot))
        else:
            rows_c.append({"name": name, **{k: v for k, v in L.roc_metrics(pgi["g"][pgi["valid"]], pgi["h"][pgi["valid"]]).items() if k in ("n", "top1", "auc", "dir@far0.01")}, "verdict": "(different tracks, not paired)"})
    gi_single = score(looks, gallery, final_recipe, aggregator)
    ok_single = gi_single["valid"]
    single = {"name": "single look (no pooling)", **{k: v for k, v in L.roc_metrics(gi_single["g"][ok_single], gi_single["h"][ok_single]).items()
                                                      if k in ("n", "top1", "auc", "dir@far0.01")}, "verdict": "(per look, for reference)"}
    rows_c.append(single)
    text += ["## C. Pooling the looks of one track (track level)", "",
             L.md_table(rows_c, [("name", "pooling"), ("n", "tracks"), ("top1", "top-1"), ("auc", "AUC"), ("dir@far0.01", "DIR@FAR 1%"), ("diff", f"{args.metric} diff"), ("CI", "95% CI"), ("verdict", "verdict")]), ""]

    # ---- D: decision settings by replaying the production decision code
    print("Stage D: decision replay")
    clip_looks = L.looks_by_clip(looks)
    clip_labels = {c: (work.labels(c) or {"labels": {}})["labels"] for c in clips}
    identity = {n: {"student_id": n, "name": n} for n in dict.fromkeys(gallery["student"])}
    adjud = work.adjudications()
    pair = (emb_g, names_g)
    thresholds = np.arange(0.10, 0.50, 0.02) if not args.quick else np.arange(0.12, 0.46, 0.04)
    base = {"aggregator": aggregator, "pool_attempts": True, "pool_top_k": 5, "max_attempts": 10}
    grid = L.decision_grid(base, thresholds, (0, 0.02, 0.05), (0.0, 0.03, 0.06))
    dev_rows = decision_rows(clip_looks, clip_labels, pair, identity, grid, dev or clips, adjud)
    pick = L.pick_operating_point(dev_rows, args.max_bad)
    text += ["## D. Decision settings (replaying recognize.py's own decision code on the stored looks)", "",
             f"Chosen on the dev clips so that wrong identifications + rejected false accepts <= {args.max_bad}; best recall wins. "
             "'unverified' = the system named someone on a face you never labelled (run `adjudicate` to settle those).", ""]
    if pick is None:
        text += [f"No setting reached <= {args.max_bad} wrong identifications on the dev clips: the model/gallery cannot do that safely here. "
                 "Raise --max-bad only if a wrong identification costs little (a teacher reviews every result).", ""]
        final = None
    else:
        around = []
        current = {**{k: pick[k] for k in ("aggregator", "pool_attempts", "pool_top_k", "max_attempts", "threshold", "accept_threshold", "margin")},
                   "pool_gate": 0.0, "stride": 1}
        for key, values in (("aggregator", ("max", "mean2")), ("pool_attempts", (True, False)), ("pool_top_k", (3, 8)),
                            ("pool_gate", (0.1, 0.2)), ("max_attempts", (5, 20)), ("stride", (2, 3, 4))):
            for v in values:
                if v != current[key]:      # the chosen value itself is already row one of the grid
                    around.append({**current, key: v})
        around_rows = decision_rows(clip_looks, clip_labels, pair, identity, around, dev or clips, adjud)
        better = [r for r in around_rows if r["bad"] <= args.max_bad and r["recall"] > pick["recall"] + 1e-9]
        final = max([pick] + better, key=lambda r: (round(r["recall"], 6), -r["unverified"]))
        shown = sorted(dev_rows, key=lambda r: (-(r["bad"] <= args.max_bad), -r["recall"]))[:12]
        text += ["Best grid rows on dev:", "", L.md_table(shown, [("threshold", "threshold"), ("accept_threshold", "accept"), ("margin", "margin"), ("recall", "recall"), ("wrong", "wrong"), ("false_accept", "false acc."), ("unverified", "unverified"), ("median_attempt", "median attempt")]), "",
                 "One-factor changes around the chosen point (dev):", "", L.md_table(around_rows, [("aggregator", "aggregator"), ("pool_attempts", "pool"), ("pool_top_k", "top_k"), ("pool_gate", "pool_gate"), ("max_attempts", "max attempts"), ("stride", "every Nth sampled frame"), ("recall", "recall"), ("wrong", "wrong"), ("false_accept", "false acc."), ("unverified", "unverified")]), ""]
        final_args = {k: final[k] for k in ("aggregator", "pool_attempts", "pool_top_k", "max_attempts", "threshold", "accept_threshold", "margin", "pool_gate") if k in final}
        test_rows = decision_rows(clip_looks, clip_labels, pair, identity, [{**final_args, "stride": final["stride"]}], test, adjud) if test else []
        dev_final = decision_rows(clip_looks, clip_labels, pair, identity, [{**final_args, "stride": final["stride"]}], dev or clips, adjud)
        step = work.clips()[clips[0]]["step"]
        low, high, n_plateau = pick.get("plateau", (None, None, 1))
        text += ["### Chosen decision settings", "",
                 f"`{json.dumps(final_args)}`", "",
                 f"Processing one sampled frame in {final['stride']} = production `--every {final['stride'] * step}` (clips were sampled every {step} native frames). "
                 f"{n_plateau} grid settings tied for the best dev result (thresholds {fmt_range(low, high)}); the middle one was taken, "
                 "because the edge of a plateau is where over-fitting to these clips hides.", "",
                 L.md_table([{**r, "split": s} for s, rs in (("dev", dev_final), ("TEST (held out)", test_rows)) for r in rs],
                            [("split", "clips"), ("clips", "n clips"), ("present", "students present"), ("recall", "recall"), ("wrong", "wrong"), ("false_accept", "false accepts"), ("unverified", "unverified"), ("median_attempt", "median attempt")]), ""]
        settings = {"crop": cfg.as_dict(), "settings": {k: v for k, v in final_args.items() if k in recognize.DEFAULT_SETTINGS}}
        out = work.root / f"settings.{Path(args.model).stem}.json"
        out.write_text(json.dumps(settings, indent=1), encoding="utf-8")
        text += [f"Wrote `{out}`. Copy it to `models/{Path(args.model).stem}.settings.json` and recognize.py picks it up "
                 "(explicit command-line / request settings still win). `every` is not part of the profile: set it on the scan.", ""]
        if args.write_profile:
            target = Path(args.models) / f"{Path(args.model).stem}.settings.json"
            target.write_text(json.dumps(settings, indent=1), encoding="utf-8")
            text += [f"Also written to `{target}`.", ""]
    path = work.reports() / "sweep.md"
    path.write_text("\n".join(text), encoding="utf-8")
    L.write_csv(work.reports() / "sweep_crop.csv", [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows_a])
    L.write_csv(work.reports() / "sweep_decision_dev.csv", dev_rows)
    print(f"Wrote {path}")


# ============================================================================================ adjudicate / detector / tracker
def cmd_adjudicate(args, work, ask=input, say=print):
    """Show faces the system named that nobody labelled; the answers are stored and reused by every later replay."""
    settings = json.loads((work.root / f"settings.{Path(args.model).stem}.json").read_text()) if (work.root / f"settings.{Path(args.model).stem}.json").exists() else {"settings": {}}
    model = MODEL_FACTORY(args, args.model)
    clips = sorted(work.clips())
    looks, gallery = prepare(args, work, model, model.recognizer.crop_config, clips)
    emb, names = L.apply_recipe(gallery, recipe_for(args))
    identity = {n: {"student_id": n, "name": n} for n in dict.fromkeys(gallery["student"])}
    clip_looks = L.looks_by_clip(looks)
    adjud = work.adjudications()
    run_args = L.settings_namespace(**{k: v for k, v in settings["settings"].items() if k in L.settings_namespace().__dict__})
    queue = []
    for clip, frames in clip_looks.items():
        labels = (work.labels(clip) or {"labels": {}})["labels"]
        _, events = L.replay_clip(frames, (emb, names), identity, run_args)
        for e in events:
            if labels.get(e["track"]) in L.NON_STUDENT and (clip, e["track"], e["student"]) not in adjud:
                queue.append((clip, e))
    say(f"{len(queue)} named faces to check.")
    folder = work.root / "adjudicate"
    folder.mkdir(exist_ok=True)
    for n, (clip, e) in enumerate(queue, 1):
        dets = work.dets(clip)["frames"][e["pos"]]["dets"]
        det = next(d for d in dets if d["track"] == e["track"])
        image = cv2.imread(str(work.frame_path(clip, e["pos"])))
        x1, y1, x2, y2 = (max(0, int(v)) for v in det["bbox"])
        pad = int(0.3 * (x2 - x1))
        seen = cv2.resize(image[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad], (260, 260), interpolation=cv2.INTER_CUBIC)
        photos = [p for f, p in recognize.gallery_photos(args.gallery) if f == e["student"]]
        ref = cv2.resize(recognize.load_image(photos[0]), (260, 260)) if photos else np.zeros((260, 260, 3), np.uint8)
        sheet = np.hstack([seen, ref])
        cv2.imwrite(str(folder / f"{n:03d}.jpg"), sheet)
        try:
            cv2.imshow("adjudicate (left: CCTV face, right: gallery photo)", sheet)
            cv2.waitKey(1)
        except cv2.error:
            pass
        answer = ask(f" {n}/{len(queue)}  {clip} track {e['track']} was named {e['student']} (score {e['score']:.2f}). Same person? [y/n/Enter=skip/q] > ").strip().lower()
        if answer == "q":
            break
        if answer in ("y", "n"):
            adjud[(clip, e["track"], e["student"])] = answer == "y"
            work.save_adjudications(adjud)
    say("Saved. Re-run `sweep` to use the answers.")


def cmd_detector(args, work):
    """Detector settings against the labelled boxes: recall by face width and extra boxes per frame."""
    model = MODEL_FACTORY(args, args.model)
    rows = []
    sizes = [recognize.parse_det_size(s) for s in args.det_sizes]
    for size in sizes:
        for thresh in args.det_threshes:
            model.detector.det_thresh = thresh
            ref_all, det_all, elapsed, count = [], [], 0.0, 0
            for clip in sorted(work.clips()):
                data, labels = work.dets(clip), work.labels(clip)
                if not labels:
                    continue
                keep = set(L.student_labels(labels["labels"]))
                for frame in data["frames"][::args.every]:
                    ref = [d["bbox"] for d in frame["dets"] if d["track"] in keep]
                    if not ref:
                        continue
                    image = cv2.imread(str(work.frame_path(clip, frame["pos"])))
                    t0 = time.perf_counter()
                    faces, _ = model.detect(image, det_size=size)
                    elapsed += time.perf_counter() - t0
                    count += 1
                    ref_all.append(ref)
                    det_all.append([list(map(float, f.bbox)) for f in faces])
            res = L.detection_recall(ref_all, det_all)
            rows.append({"det_size": f"{size[0]}x{size[1]}", "det_thresh": thresh, "recall": res["recall"], "extra/frame": res["extra_per_frame"],
                         "ms/frame": 1000 * elapsed / max(count, 1), **{f"recall {k}": v[0] / v[1] for k, v in res["by_width"].items()}})
    cols = [(k, k) for k in rows[0]] if rows else []
    path = work.reports() / "detector.md"
    path.write_text("# Detector settings vs labelled faces\n\nReference = the labelled boxes found by the prep-time detector, "
                    "so a setting that finds MORE faces than prep did cannot score above 100%. 'extra/frame' counts boxes matching no labelled face "
                    "(other people, or false detections).\n\n" + L.md_table(rows, cols), encoding="utf-8")
    print(f"Wrote {path}")


def cmd_tracker(args, work):
    rows = []
    for assignment in ("greedy", "hungarian"):
        for iou_t in (0.2, 0.3, 0.4):
            for dist in (0.4, 0.6, 0.8, 1.0):
                for missed in (5, 15):
                    tot = {"students": 0, "switched": 0, "merged_ids": 0}
                    for clip in sorted(work.clips()):
                        lab, data = work.labels(clip), work.dets(clip)
                        if not lab or not lab.get("verify_answers") or lab["first_pos"] == lab["verify_pos"]:
                            continue
                        res = L.tracker_eval(data["frames"], lab["first_pos"], lab["first_answers"], lab["verify_pos"], lab["verify_answers"],
                                             iou_threshold=iou_t, max_center_dist=dist, max_missed=missed, assignment=assignment)
                        for k in tot:
                            tot[k] += res[k]
                    rows.append({"assignment": assignment, "iou": iou_t, "max_center_dist": dist, "max_missed": missed, **tot})
    rows.sort(key=lambda r: (r["switched"] + r["merged_ids"], -r["students"]))
    path = work.reports() / "tracker.md"
    path.write_text("# Tracker settings\n\nUses the two hand-checked frames of every clip: a student labelled in both frames must keep one track id "
                    "(`switched` counts the ones that did not), and one id must never cover two students (`merged_ids`). Lower is better. "
                    "With two frames per clip this measures swaps over the whole clip but cannot see short-lived ones.\n\n"
                    + L.md_table(rows[:20], [(k, k) for k in rows[0]]) if rows else "no labelled clips", encoding="utf-8")
    print(f"Wrote {path}")


def cmd_all(args, work):
    print("== prep ==")
    cmd_prep(args, work)
    print("== label ==")
    cmd_label(args, work)
    print("== part 1: models ==")
    best = cmd_models(args, work)
    args.model = args.model or best
    print(f"== part 2: sweep on {args.model} ==")
    cmd_sweep(args, work)
    print("== tracker ==")
    cmd_tracker(args, work)
    print(f"\nDone. Read {work.reports()} (models.md, sweep.md, tracker.md). "
          f"Run `adjudicate --model {args.model}` to settle unlabelled faces, then `sweep` again.")


# ============================================================================================ command line
def build_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["prep", "label", "extract", "models", "sweep", "adjudicate", "detector", "tracker", "all"])
    p.add_argument("--work", default=str(HERE / "bakeoff_work"), help="folder for everything this script writes")
    p.add_argument("--gallery", default=str(HERE / "gallery"))
    p.add_argument("--models", default=str(HERE / "models"), help="folder with the .onnx files")
    p.add_argument("--videos", nargs="*", default=[], help="prep / all: CCTV clips (wildcards supported; main stream, not a low-bitrate substream)")
    p.add_argument("--models-to-test", nargs="*", default=[recognize.DEFAULT_REC_FILENAME], help="models / all: .onnx file names; the first is the control")
    p.add_argument("--model", default=None, help="sweep / adjudicate / detector: the model to tune (all: the winner of part 1)")
    p.add_argument("--rec-model", default=recognize.DEFAULT_REC_FILENAME, help="prep: recognizer to load alongside the detector")
    p.add_argument("--det-size", default="1920x1080")
    p.add_argument("--det-thresh", type=float, default=0.3)
    p.add_argument("--det-sizes", nargs="*", default=["1280x720", "1920x1080", "2560x1440"], help="detector: sizes to try")
    p.add_argument("--det-threshes", nargs="*", type=float, default=[0.2, 0.3, 0.5], help="detector: thresholds to try")
    p.add_argument("--every", type=int, default=3, help="detector: use every Nth sampled frame")
    p.add_argument("--step", type=int, default=6, help="prep: sample every Nth native frame (production's --every must be a multiple)")
    p.add_argument("--seconds", type=float, default=30.0, help="prep: scan this many seconds of each clip (0 = all)")
    p.add_argument("--assignment", choices=["greedy", "hungarian"], default="hungarian", help="prep: tracker assignment")
    p.add_argument("--test-clips", nargs="*", default=None, help="clip names held out for the final check (default: the last third)")
    p.add_argument("--use-cctv", action="store_true", help="allow saved CCTV crops in the gallery (leaks if they come from the test clips)")
    p.add_argument("--metric", default="auc", choices=sorted(L.METRICS), help="the metric a setting must clearly improve")
    p.add_argument("--boot", type=int, default=200, help="bootstrap resamples")
    p.add_argument("--max-bad", type=int, default=0, help="sweep: wrong identifications allowed on the dev clips when choosing settings")
    p.add_argument("--quick", action="store_true", help="sweep: fewer crop settings and a coarser grid (much faster)")
    p.add_argument("--write-profile", action="store_true", help="sweep: also write models/<model>.settings.json")
    p.add_argument("--no-gui", action="store_true", help="label: do not open a window, write work/label_view.jpg instead")
    p.add_argument("--redo", action="store_true", help="label: label clips again")
    p.add_argument("--force", action="store_true", help="prep: redo clips already prepared")
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
        args.model = args.models_to_test[0]
    if args.command == "extract":
        for model_file in args.models_to_test:
            model = MODEL_FACTORY(args, model_file)
            prepare(args, work, model, model.recognizer.crop_config, sorted(work.clips()))
        return
    {"prep": cmd_prep, "label": cmd_label, "models": cmd_models, "sweep": cmd_sweep, "adjudicate": cmd_adjudicate,
     "detector": cmd_detector, "tracker": cmd_tracker, "all": cmd_all}[args.command](args, work)


if __name__ == "__main__":
    main()
