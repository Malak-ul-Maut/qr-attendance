"""
enroll_qa.py - checks a student's enrolment photos with the SAME models that read the CCTV (SCRFD + AdaFace).

The phone only has a small model, so it cannot say how good a photo will be for CCTV. This runs on the server
right after a student saves their photos (and on demand for photos an admin added) and produces a short report
for the admin who approves them:

  * is there exactly one clear face in each photo, big enough, sharp enough?
  * do the photos look like the SAME person? (an outlier photo is flagged)
  * do they look like the reference photo (the I-Card or any photo an admin added)? A low score is the best
    automatic hint that someone else enrolled in this account.

The thresholds below are starting values: look at a few real reports and adjust.
"""
import json
import re
from pathlib import Path

import cv2
import numpy as np

from gallery_extras import is_cctv_crop

SELF_PHOTO = re.compile(r"^self_\d+\.(jpg|jpeg|png|webp)$", re.I)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

QA = {
    "min_face_px": 90,          # a face narrower than this in the saved photo is too small to be useful
    "min_sharpness": 25.0,      # Laplacian variance of the 112x112 aligned face; below this the photo is blurry
    "min_norm": 12.0,           # AdaFace quality norm of the aligned face; below this the model itself says "poor"
    "outlier_similarity": 0.30,  # a photo whose average similarity to the others is below this is flagged
    "min_consistency": 0.40,    # average similarity between the photos; below this they may not be one person
    "reference_min_similarity": 0.25,  # the photos vs the reference photo; below this, ask the admin to compare
    "min_good_photos": 4,       # fewer usable photos than this -> review
}


def is_reference_photo(path):
    """An admin-added photo (I-Card, camera photo): any image that is neither a self-enrolment photo nor a CCTV crop."""
    path = Path(path)
    return path.suffix.lower() in IMAGE_SUFFIXES and not SELF_PHOTO.match(path.name) and not is_cctv_crop(path)


def sharpness_of(aligned_bgr):
    """Laplacian variance of the grey 112x112 face: high = sharp, low = blurry."""
    grey = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def judge(photos, consistency, outliers, reference_similarity, has_reference, limits=QA):
    """
    Turns the measurements into {"status": "ok" | "review", "reasons": [plain sentences]}.
    `photos` is a list of per-photo dicts with a "problems" list; the rest are numbers (or None when unknown).
    """
    reasons = []
    good = [p for p in photos if not p["problems"]]
    if len(good) < limits["min_good_photos"]:
        reasons.append(f"Only {len(good)} of {len(photos)} photos are clear enough (one clear face, sharp, big).")
    for photo in photos:
        if photo["problems"]:
            reasons.append(f"{photo['file']}: {', '.join(photo['problems'])}.")
    if consistency is not None and consistency < limits["min_consistency"]:
        reasons.append(f"The photos look unlike each other (similarity {consistency:.2f}). They may not be one person.")
    for name in outliers:
        reasons.append(f"{name} does not look like the other photos.")
    if has_reference and reference_similarity is not None and reference_similarity < limits["reference_min_similarity"]:
        reasons.append(f"The photos do not look like the reference photo (similarity {reference_similarity:.2f}). Compare them by eye.")
    return {"status": "review" if reasons else "ok", "reasons": reasons}


def check_enrolment(model, folder, lock=None, limits=QA):
    """
    Runs the checks on every photo in a student's gallery folder. `model` is recognize.FaceModel; `lock` (optional,
    a context manager) is taken around each model call so a scan in progress is not slowed for long.
    Returns a JSON-ready dict: {"status", "reasons", "consistency", "reference_similarity", "photos": [...]}.
    """
    from contextlib import nullcontext
    import recognize   # imported here so this module can be tested without insightface

    lock = lock if lock is not None else nullcontext()
    folder = Path(folder)
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES) if folder.is_dir() else []
    selfs = [p for p in files if SELF_PHOTO.match(p.name)]
    references = [p for p in files if is_reference_photo(p)]

    meta = {}
    meta_path = folder / "self_meta.dat"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8")).get("files", {})
        except (OSError, ValueError):
            meta = {}

    def analyse(path):
        info = {"file": path.name, "problems": [], "face_px": None, "norm": None, "sharpness": None}
        try:
            image = recognize.load_image(path)
            with lock:
                faces, _, _ = model.find_faces(image, det_size=recognize.GALLERY_DET_SIZE)
        except Exception as error:   # an unreadable file is a finding, not a crash
            info["problems"].append(f"cannot be read ({type(error).__name__})")
            return info, None
        if not faces:
            info["problems"].append("no face found")
            return info, None
        areas = sorted((float(np.prod(recognize.face_size(f))) for f in faces), reverse=True)
        if len(faces) > 1 and areas[1] > 0.4 * areas[0]:
            info["problems"].append("more than one face")
        biggest = max(faces, key=lambda f: np.prod(recognize.face_size(f)))
        info["face_px"] = round(recognize.face_size(biggest)[0])
        if info["face_px"] < limits["min_face_px"]:
            info["problems"].append("face too small")
        embedding = biggest.normed_embedding
        info["norm"] = round(float(biggest.quality), 2)
        aligned = getattr(biggest, "aligned_bgr", None)
        if aligned is not None:
            info["sharpness"] = round(sharpness_of(aligned), 1)
            if info["sharpness"] < limits["min_sharpness"]:
                info["problems"].append("blurry")
        if info["norm"] < limits["min_norm"]:
            info["problems"].append("low quality for recognition")
        info.update({k: v for k, v in meta.get(path.name, {}).items() if k in ("shot", "rank")})
        return info, embedding

    photos, embeddings = [], []
    for path in selfs:
        info, embedding = analyse(path)
        photos.append(info)
        embeddings.append(embedding)

    usable = [(info, emb) for info, emb in zip(photos, embeddings) if emb is not None]
    consistency, outliers = None, []
    if len(usable) >= 3:
        matrix = np.stack([emb for _, emb in usable])
        sims = matrix @ matrix.T
        count = len(usable)
        mean_to_others = (sims.sum(axis=1) - 1.0) / (count - 1)
        consistency = float((sims.sum() - count) / (count * (count - 1)))
        outliers = [info["file"] for (info, _), mean in zip(usable, mean_to_others) if mean < limits["outlier_similarity"]]

    reference_similarity = None
    if references and usable:
        ref_embeddings = []
        for path in references:
            _, embedding = analyse(path)
            if embedding is not None:
                ref_embeddings.append(embedding)
        if ref_embeddings:
            self_mean = np.mean([emb for _, emb in usable], axis=0)
            self_mean /= max(np.linalg.norm(self_mean), 1e-9)
            reference_similarity = float(max(ref @ self_mean for ref in ref_embeddings))

    if not selfs:
        # No app photos at all (a student whose folder was filled by hand): nothing to judge, and not a problem.
        return {"status": "ok", "reasons": [], "consistency": None, "reference_similarity": None,
                "photo_count": 0, "reference_count": len(references), "photos": []}
    verdict = judge(photos, consistency, outliers, reference_similarity, bool(references), limits)
    return {**verdict,
            "consistency": None if consistency is None else round(consistency, 3),
            "reference_similarity": None if reference_similarity is None else round(reference_similarity, 3),
            "photo_count": len(selfs), "reference_count": len(references),
            "photos": photos}
