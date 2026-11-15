"""
gallery_extras.py - helpers that make the gallery match CCTV footage better. Needs only numpy + OpenCV, so it
can be tested without the face models.

Three things live here:

1. CCTV crops. When a faculty member confirms a CCTV session, the face crops the camera matched are saved into the
   student's gallery folder as `cctv_<time>_<n>.png`. They are stored ALREADY ALIGNED (112x112, exactly what the
   recognizer sees), so building the gallery embeds them directly and never has to find a 14 px face again.

2. Degraded copies ("what this photo would look like from the CCTV camera"). A phone selfie has a 400 px face; the
   camera sees an 18 px one. For each photo we can add smaller, blurred, compressed copies to the gallery so the
   comparison is like for like. Off by default: turn it on after measuring (bakeoff.py), because it also raises
   the scores of look-alikes, so thresholds may need re-checking.

3. A per-photo embedding cache on disk. Embedding one gallery photo costs ~0.3 s on CPU. Without this, every new
   CCTV crop would force the whole class gallery (hundreds of photos) to be embedded again.

Cache keys: callers pass the recognizer's cache_tag (model name + file fingerprint + crop settings) as an extra
part, so a re-exported model or a changed crop setting never reuses old embeddings.
"""
import hashlib
from pathlib import Path

import cv2
import numpy as np

CCTV_CROP_PREFIX = "cctv_"
CACHE_VERSION = "2"     # bump to throw away every cached embedding (e.g. after changing how photos are prepared)


def is_cctv_crop(path):
    """True for a pre-aligned crop saved from a confirmed CCTV scan."""
    return Path(path).name.lower().startswith(CCTV_CROP_PREFIX)


def parse_widths(text):
    """'20, 28' -> (20, 28). Anything that is not a sensible face width is ignored; '' / None -> ()."""
    widths = []
    for part in str(text or "").replace(";", ",").split(","):
        part = part.strip()
        if part.isdigit() and 8 <= int(part) <= 120:
            widths.append(int(part))
    return tuple(widths)


def degrade_photo(image, kps, face_width, target_width, blur_sigma=0.6, jpeg_quality=40):
    """
    Makes a copy of `image` in which the face is `target_width` px wide, lightly blurred and JPEG-compressed, the
    way a small face looks on CCTV. `kps` are the five face landmarks (x, y) in the original image and are scaled
    along. Returns (small_image, small_kps), or None when the face is already that small or smaller.
    """
    if face_width <= 0 or target_width >= face_width:
        return None
    factor = target_width / float(face_width)
    small = cv2.resize(image, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
    if blur_sigma > 0:
        small = cv2.GaussianBlur(small, (0, 0), blur_sigma)
    ok, encoded = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, int(jpeg_quality)])
    if ok:
        small = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    small_kps = np.asarray(kps, dtype=np.float32) * factor
    return small, small_kps


class EmbeddingFileCache:
    """
    One small .npy file per gallery photo, named after a fingerprint of (the photo's path, size and modified
    time, the recognizer's name, and the settings that change what is embedded). A photo that has not changed is
    never embedded twice, even after a restart. A photo with no usable face is cached too (as an empty array), so
    it is not searched again either.
    """

    def __init__(self, folder):
        self.folder = Path(folder)

    def key_for(self, photo_path, *extra):
        photo_path = Path(photo_path)
        stat = photo_path.stat()
        text = "|".join([CACHE_VERSION, str(photo_path.resolve()), str(stat.st_size), str(stat.st_mtime_ns)]
                        + [str(part) for part in extra])
        return hashlib.sha1(text.encode("utf-8")).hexdigest()

    def _path(self, key, group=None):
        # `group` = the student's gallery folder name: one sub-folder per student, so the cache is as tidy as the gallery
        folder = self.folder / str(group) if group else self.folder
        return folder / f"{key}.npy"

    def get(self, key, group=None):
        """The saved (rows x 512) array, or None when this photo has not been embedded yet."""
        path = self._path(key, group)
        if not path.exists():
            return None
        try:
            return np.load(path)
        except (OSError, ValueError):
            return None   # a half-written file is simply recomputed

    def put(self, key, embeddings, group=None):
        self._path(key, group).parent.mkdir(parents=True, exist_ok=True)
        # any embedding length (512 for every model so far); an empty entry means "no usable face in this photo"
        array = (np.stack([np.asarray(e, dtype=np.float32).ravel() for e in embeddings]) if len(embeddings)
                 else np.zeros((0, 512), np.float32))
        temporary = self._path(key, group).with_suffix(".tmp.npy")
        np.save(temporary, array)
        temporary.replace(self._path(key, group))   # swap in at the end, so a crash never leaves a broken file
