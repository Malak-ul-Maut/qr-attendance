#!/usr/bin/env python3
"""
bakeoff.py - which way of building the gallery recognises YOUR students best on YOUR camera? Measure, don't guess.

Step 1 - make a label sheet from one real CCTV frame:
    python scripts/bakeoff.py dump frame.jpg
  writes frame_numbered.jpg (every face boxed and numbered) and frame_labels.csv. Open both, and in the csv type the
  student's gallery folder name (e.g. 12_amy_2402920100145) next to each face you can identify. Delete the other rows.
  Do this for several frames / classes; the more faces, the more trustworthy the result.

Step 2 - compare the recipes on every labelled frame:
    python scripts/bakeoff.py run frame_labels.csv [more_labels.csv ...]

For each labelled face and each recipe it asks: is the true student the best match among everyone in the gallery
(top-1), how high is their score, and by how much do they beat the best look-alike (margin)? The recipe with the
best top-1 AND margin wins. Whatever wins, re-check the recognition thresholds with a few absent students.
Recipes: clean = phone photos only; +cctv = also saved CCTV crops; +degrade = also CCTV-quality copies of each photo;
mean2 = a student's score is the average of their two best photos instead of the single best.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # the scripts live in scripts/; recognize.py is one folder up
import argparse
import csv
import sys
from pathlib import Path

import cv2
import numpy as np

import recognize
from enroll_qa import is_reference_photo, SELF_PHOTO
from gallery_extras import EmbeddingFileCache, is_cctv_crop

RECIPES = {   # name: (photo kinds used, degrade widths, aggregator)
    "clean":              ({"self", "reference"}, (), "max"),
    "clean mean2":        ({"self", "reference"}, (), "mean2"),
    "+cctv":              ({"self", "reference", "cctv"}, (), "max"),
    "+degrade 20":        ({"self", "reference"}, (20,), "max"),
    "+degrade 20,28":     ({"self", "reference"}, (20, 28), "max"),
    "+degrade 20,28 +cctv": ({"self", "reference", "cctv"}, (20, 28), "max"),
    "+degrade 20,28 mean2": ({"self", "reference"}, (20, 28), "mean2"),
}


def kind_of(photo):
    return "cctv" if is_cctv_crop(photo) else "self" if SELF_PHOTO.match(photo.name) else "reference"


def dump(frame_path, model):
    image = recognize.load_image(frame_path)
    faces, _ = model.detect(image)
    faces.sort(key=lambda f: (round(f.bbox[1] / 80), f.bbox[0]))   # roughly row by row
    out = image.copy()
    stem = Path(frame_path).with_suffix("")
    rows = []
    for number, face in enumerate(faces, 1):
        x1, y1, x2, y2 = (int(v) for v in face.bbox)
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 255, 0), 1)
        cv2.putText(out, str(number), (x1, max(10, y1 - 2)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)
        rows.append([Path(frame_path).name, number, "", int((x1 + x2) / 2), int((y1 + y2) / 2)])
    recognize.save_image(f"{stem}_numbered.jpg", out)
    with open(f"{stem}_labels.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["frame", "face_number", "student_folder", "x", "y"])
        writer.writerows(rows)
    print(f"{len(faces)} faces. Wrote {stem}_numbered.jpg and {stem}_labels.csv - fill in student_folder, delete unknown rows.")


def student_scores(scores, names, aggregator):
    """{folder: score} from per-entry scores."""
    by_folder = {}
    for folder, score in zip(names, scores):
        by_folder.setdefault(folder, []).append(float(score))
    out = {}
    for folder, values in by_folder.items():
        values.sort(reverse=True)
        out[folder] = values[0] if aggregator == "max" or len(values) == 1 else (values[0] + values[1]) / 2
    return out


def run(label_files, gallery_dir, model, recipes):
    labels = []
    for path in label_files:
        base = Path(path).parent
        with open(path, newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                if row["student_folder"].strip():
                    labels.append((base / row["frame"], row["student_folder"].strip(), int(row["x"]), int(row["y"])))
    if not labels:
        sys.exit("No labelled faces found: fill in student_folder in the csv.")

    # embed each labelled face once (the CCTV side does not depend on the recipe)
    probes, frames = [], {}
    for frame_path, folder, x, y in labels:
        if frame_path not in frames:
            image = recognize.load_image(frame_path)
            faces, _ = model.detect(image)
            model.recognize_batch(image, faces)
            frames[frame_path] = faces
        faces = frames[frame_path]
        containing = [f for f in faces if f.bbox[0] <= x <= f.bbox[2] and f.bbox[1] <= y <= f.bbox[3]]
        if not containing:
            print(f"  ! no detected face at ({x},{y}) in {frame_path.name}: skipped")
            continue
        probes.append((folder, min(containing, key=lambda f: np.prod(recognize.face_size(f))), recognize.face_size(containing[0])[0]))
    print(f"{len(probes)} labelled faces, median width {np.median([w for _, _, w in probes]):.0f} px\n")

    cache = EmbeddingFileCache(recognize.HERE / "cache" / "photos")
    photos = recognize.gallery_photos(gallery_dir)
    print(f"{'recipe':<24}{'top-1':>8}{'mean score':>12}{'mean margin':>13}{'look-alike max':>16}")
    for name, (kinds, widths, aggregator) in recipes.items():
        entries, entry_names = [], []
        for folder, photo in photos:
            if kind_of(photo) not in kinds:
                continue
            key = cache.key_for(photo, model.rec_name, widths)
            rows = cache.get(key, folder)
            if rows is None:
                rows = recognize.embed_gallery_photo(model, photo, widths, log=lambda *_: None)
                cache.put(key, rows, folder)
            entries.extend(rows)
            entry_names.extend([folder] * len(rows))
        if not entries:
            continue
        matrix = np.stack(entries)
        hits, genuine, margins, impostors = 0, [], [], []
        for folder, face, _ in probes:
            per_student = student_scores(matrix @ face.normed_embedding, entry_names, aggregator)
            if folder not in per_student:
                continue
            others = [v for k, v in per_student.items() if k != folder]
            best_other = max(others) if others else -1.0
            hits += per_student[folder] > best_other
            genuine.append(per_student[folder])
            margins.append(per_student[folder] - best_other)
            impostors.append(best_other)
        n = len(genuine)
        print(f"{name:<24}{100 * hits / n:>7.0f}%{np.mean(genuine):>12.3f}{np.mean(margins):>13.3f}{max(impostors):>16.3f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["dump", "run"])
    parser.add_argument("files", nargs="+", help="dump: one CCTV frame. run: one or more *_labels.csv")
    parser.add_argument("--gallery", default=str(recognize.HERE / "gallery"))
    parser.add_argument("--models", default=str(recognize.HERE / "models"))
    parser.add_argument("--det-size", default="1920x1080")
    parser.add_argument("--det-thresh", type=float, default=0.3)
    args = parser.parse_args()
    model = recognize.FaceModel(args.models, recognize.parse_det_size(args.det_size), args.det_thresh)
    if args.command == "dump":
        dump(args.files[0], model)
    else:
        run(args.files, args.gallery, model, RECIPES)


if __name__ == "__main__":
    main()
