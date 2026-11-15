"""
crop_ops.py - how a face is turned into the 112x112 picture the recognizer sees, with every knob in one place.

Needs only numpy + OpenCV (no insightface), so it can be tested - and swept by scripts/bakeoff.py - on its own.

What can be varied (all off / identical to insightface's norm_crop by default):
  interp   how the face is resampled when it is warped into the 112x112 crop:
           linear (insightface's default), cubic, lanczos, or 'area' (area-average first when the face is much
           bigger than 112 px, which avoids aliasing on large gallery photos)
  enhance  photometric clean-up of the aligned crop, e.g. 'clahe:2:4', 'gamma:0.7', 'autogamma', 'histeq',
           'unsharp', 'gauss:0.7', 'nlm:5'. Several can be chained with '+': 'gamma:0.8+clahe:2:4'
  enhance_side  'both' = every crop; 'cctv' = only crops from the camera side (probes, saved CCTV crops, degraded
           gallery copies), leaving clean phone photos alone
  flip     embed the crop AND its mirror image, average the two (flip test-time augmentation)
  jitter   CCTV probes only: also embed k slightly shifted/scaled alignments and average them (the five landmarks
           of a 20 px face are noisy; averaging a few alignments cancels part of that noise)
  keypoints  KP-RPE models only (they take the face's 5 landmarks as a second input): 'detected' = where the detector's
           landmarks land inside the aligned crop (how CVLface itself uses the model), 'template' = the fixed ideal
           positions. Landmarks always follow the crop: shifted for a jittered alignment, mirrored for a flipped one.

Gallery photos and probes must be prepared the same way, so CropConfig.signature() goes into every embedding
cache key (see recognize.FaceModel.cache_tag).
"""
import re
from dataclasses import dataclass

import cv2
import numpy as np

CROP_OPS_VERSION = "1"   # bump when any behaviour here changes, so cached embeddings are not reused

ARCFACE_112 = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                        [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float64)
SIZE = 112

INTERP_FLAGS = {"linear": cv2.INTER_LINEAR, "cubic": cv2.INTER_CUBIC, "lanczos": cv2.INTER_LANCZOS4, "area": cv2.INTER_LINEAR}

# (dx, dy, scale) in crop pixels, applied after the normal alignment
JITTER_PATTERNS = {
    0: [],
    4: [(1.5, 0, 1.0), (-1.5, 0, 1.0), (0, 1.5, 1.0), (0, -1.5, 1.0)],
    8: [(1.5, 0, 1.0), (-1.5, 0, 1.0), (0, 1.5, 1.0), (0, -1.5, 1.0),
        (0, 0, 1.05), (0, 0, 0.95), (1.5, 1.5, 1.0), (-1.5, -1.5, 1.0)],
}

# Presets worth sweeping (bakeoff.py uses these names)
ENHANCE_PRESETS = ["none", "gamma:0.7", "gamma:1.4", "autogamma", "clahe:2:4", "clahe:3:2", "histeq", "unsharp",
                   "gauss:0.7", "gauss:1.2", "nlm:5"]


# ----------------------------------------------------------------------------- alignment
def similarity_matrix(kps, size=SIZE):
    """2x3 matrix mapping the 5 detected landmarks onto the ArcFace template (least-squares similarity transform;
    the same fit insightface's estimate_norm does, without needing insightface or scikit-image)."""
    src = np.asarray(kps, dtype=np.float64).reshape(5, 2)
    dst = ARCFACE_112 * (size / 112.0)
    src_mean, dst_mean = src.mean(axis=0), dst.mean(axis=0)
    src_c, dst_c = src - src_mean, dst - dst_mean
    cov = dst_c.T @ src_c / len(src)
    u, s, vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[-1] = -1
    rot = u @ np.diag(d) @ vt
    var = (src_c ** 2).sum() / len(src)
    scale = (s * d).sum() / var if var > 1e-12 else 1.0
    matrix = np.zeros((2, 3))
    matrix[:, :2] = scale * rot
    matrix[:, 2] = dst_mean - scale * rot @ src_mean
    return matrix


def face_scale(kps):
    """How much the face is magnified by the alignment (>1 = a small face is blown up, <1 = a big photo shrunk)."""
    matrix = similarity_matrix(kps)
    return float(np.sqrt(abs(np.linalg.det(matrix[:, :2]))))


def align(image, kps, interp="linear", shift=(0.0, 0.0), scale=1.0):
    """The aligned 112x112 BGR crop. With defaults this equals insightface's norm_crop (INTER_LINEAR, black border)."""
    matrix = similarity_matrix(kps)
    if interp == "area":
        factor = face_scale(kps)
        if factor < 0.67:   # a big photo is being shrunk a lot: average-pool it first so the warp does not alias
            pre = max(factor * 1.5, 0.05)
            image = cv2.resize(image, None, fx=pre, fy=pre, interpolation=cv2.INTER_AREA)
            matrix = similarity_matrix(np.asarray(kps, dtype=np.float64) * pre)
    if scale != 1.0 or shift != (0.0, 0.0):
        centre = SIZE / 2.0
        adjust = np.array([[scale, 0.0, centre * (1 - scale) + shift[0]],
                           [0.0, scale, centre * (1 - scale) + shift[1]]])
        matrix = adjust @ np.vstack([matrix, [0.0, 0.0, 1.0]])
    return cv2.warpAffine(image, matrix, (SIZE, SIZE), flags=INTERP_FLAGS.get(interp, cv2.INTER_LINEAR), borderValue=0.0)


# ----------------------------------------------------------------------------- photometric ops
def _luma(image):
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def _gamma(image, gamma):
    table = (255.0 * (np.arange(256) / 255.0) ** gamma).clip(0, 255).astype(np.uint8)
    return cv2.LUT(image, table)


def _autogamma(image):
    mean = float(np.clip(_luma(image).mean() / 255.0, 0.05, 0.95))
    gamma = float(np.clip(np.log(0.5) / np.log(mean), 0.5, 2.0))   # pulls the mean brightness towards mid-grey
    return _gamma(image, gamma)


def _on_lightness(image, fn):
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = fn(lab[:, :, 0])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def _clahe(image, clip, tiles):
    engine = cv2.createCLAHE(clipLimit=float(clip), tileGridSize=(int(tiles), int(tiles)))
    return _on_lightness(image, engine.apply)


def _histeq(image):
    return _on_lightness(image, cv2.equalizeHist)


def _unsharp(image, sigma=1.0, amount=0.8):
    blurred = cv2.GaussianBlur(image, (0, 0), sigma)
    return cv2.addWeighted(image, 1.0 + amount, blurred, -amount, 0)


def _gauss(image, sigma):
    return cv2.GaussianBlur(image, (0, 0), float(sigma))


def _nlm(image, h):
    return cv2.fastNlMeansDenoisingColored(image, None, float(h), float(h), 7, 21)


OPS = {
    "none": lambda image: image,
    "gamma": lambda image, g=1.0: _gamma(image, float(g)),
    "autogamma": _autogamma,
    "clahe": lambda image, clip=2.0, tiles=4: _clahe(image, clip, tiles),
    "histeq": _histeq,
    "unsharp": lambda image, sigma=1.0, amount=0.8: _unsharp(image, float(sigma), float(amount)),
    "gauss": lambda image, sigma=0.7: _gauss(image, sigma),
    "nlm": lambda image, h=5: _nlm(image, h),
}
_SPEC = re.compile(r"^[a-z]+(:[0-9.]+)*$")


def parse_enhance(spec):
    """'gamma:0.8+clahe:2:4' -> [('gamma', ['0.8']), ('clahe', ['2', '4'])]. 'none'/''/None -> []. Raises ValueError."""
    spec = (spec or "none").strip().lower()
    if spec in ("", "none"):
        return []
    steps = []
    for token in spec.split("+"):
        token = token.strip()
        if not _SPEC.match(token):
            raise ValueError(f"bad enhance step '{token}' in '{spec}'")
        name, *params = token.split(":")
        if name not in OPS or name == "none":
            raise ValueError(f"unknown enhance op '{name}' (known: {', '.join(k for k in OPS if k != 'none')})")
        steps.append((name, params))
    return steps


def apply_enhance(image, spec):
    """Run the chain of photometric ops on an aligned BGR uint8 crop."""
    for name, params in parse_enhance(spec):
        image = OPS[name](image, *params)
    return image


def flip(image):
    return cv2.flip(image, 1)


TEMPLATE_KEYPOINTS = (ARCFACE_112 / SIZE).astype(np.float32)   # the five landmarks of a perfectly aligned crop, (x, y) / 112
_MIRROR_ORDER = [1, 0, 2, 4, 3]                                # left eye <-> right eye, left <-> right mouth corner


def crop_keypoints(kps, shift=(0.0, 0.0), scale=1.0):
    """The five detected landmarks as they land INSIDE the aligned crop, (x, y) / 112, shape [5, 2]. Uses the same
    transform `align` applies (including a jitter shift / scale), so a crop and its landmarks always agree."""
    kps = np.asarray(kps, dtype=np.float64).reshape(5, 2)
    matrix = similarity_matrix(kps)
    if scale != 1.0 or shift != (0.0, 0.0):
        centre = SIZE / 2.0
        adjust = np.array([[scale, 0.0, centre * (1 - scale) + shift[0]], [0.0, scale, centre * (1 - scale) + shift[1]]])
        matrix = adjust @ np.vstack([matrix, [0.0, 0.0, 1.0]])
    return ((kps @ matrix[:, :2].T + matrix[:, 2]) / SIZE).astype(np.float32)


def flip_keypoints(keypoints):
    """Landmarks of the mirrored crop: x -> 1 - x, and the left/right points swap places."""
    mirrored = np.asarray(keypoints, dtype=np.float32).copy()
    mirrored[:, 0] = 1.0 - mirrored[:, 0]
    return mirrored[_MIRROR_ORDER]


# ----------------------------------------------------------------------------- the config
@dataclass(frozen=True)
class CropConfig:
    interp: str = "linear"
    enhance: str = "none"
    enhance_side: str = "both"     # 'both' | 'cctv'
    flip: bool = False
    jitter: int = 0                # 0, 4 or 8 extra alignments for CCTV probes
    keypoints: str = "detected"    # KP-RPE models only: 'detected' | 'template' (see the module docstring)

    def __post_init__(self):
        if self.interp not in INTERP_FLAGS:
            raise ValueError(f"interp must be one of {sorted(INTERP_FLAGS)}")
        if self.enhance_side not in ("both", "cctv"):
            raise ValueError("enhance_side must be 'both' or 'cctv'")
        if self.jitter not in JITTER_PATTERNS:
            raise ValueError(f"jitter must be one of {sorted(JITTER_PATTERNS)}")
        if self.keypoints not in ("detected", "template"):
            raise ValueError("keypoints must be 'detected' or 'template'")
        parse_enhance(self.enhance)   # validates

    @classmethod
    def from_dict(cls, data):
        data = dict(data or {})
        return cls(**{k: data[k] for k in ("interp", "enhance", "enhance_side", "flip", "jitter", "keypoints") if k in data})

    def as_dict(self):
        return {"interp": self.interp, "enhance": self.enhance, "enhance_side": self.enhance_side,
                "flip": self.flip, "jitter": self.jitter, "keypoints": self.keypoints}

    def enhances(self, role):
        """role is 'photo' (a clean phone/ID photo) or 'cctv' (a probe, a saved CCTV crop, a degraded copy)."""
        return parse_enhance(self.enhance) != [] and (self.enhance_side == "both" or role == "cctv")

    def jitters(self, role):
        return self.jitter if role == "cctv" else 0

    def signature(self):
        return (f"crop{CROP_OPS_VERSION}|{self.interp}|{self.enhance}|{self.enhance_side}|"
                f"flip{int(self.flip)}|jit{self.jitter}|kp-{self.keypoints}")

    def label(self):
        """Short human name for reports: 'cubic + clahe:2:4 + flip'."""
        parts = [self.interp] if self.interp != "linear" else []
        if self.enhance != "none":
            parts.append(self.enhance + ("" if self.enhance_side == "both" else " (cctv only)"))
        if self.flip:
            parts.append("flip")
        if self.jitter:
            parts.append(f"jitter{self.jitter}")
        if self.keypoints != "detected":
            parts.append(f"{self.keypoints} keypoints")
        return " + ".join(parts) or "default"


def crops_for(image, kps, config, role):
    """The aligned crop(s) to embed for one face: [primary] + the jittered alignments (CCTV probes only)."""
    primary = align(image, kps, config.interp)
    crops = [primary]
    for dx, dy, scale in JITTER_PATTERNS[config.jitters(role)]:
        crops.append(align(image, kps, config.interp, shift=(dx, dy), scale=scale))
    return crops


def variants_for(image, kps, config, role):
    """[(aligned crop, landmarks inside that crop)] for one face: the primary alignment, then the jittered ones (CCTV
    probes only). With keypoints='template' every landmark set is the ideal template instead of the detected one."""
    pairs = []
    shifts = [((0.0, 0.0), 1.0)] + [((dx, dy), s) for dx, dy, s in JITTER_PATTERNS[config.jitters(role)]]
    for shift, scale in shifts:
        crop = align(image, kps, config.interp, shift=shift, scale=scale)
        keypoints = TEMPLATE_KEYPOINTS if config.keypoints == "template" else crop_keypoints(kps, shift, scale)
        pairs.append((crop, keypoints))
    return pairs


def finalize_pairs(pairs, config, role):
    """Like finalize() for (crop, landmarks) pairs: the photometric ops apply to the crop, and a mirrored crop gets mirrored
    landmarks. A landmark of None (an already-aligned crop with no detection) means the template. -> [(crop, [5,2])]"""
    out = []
    for crop, keypoints in pairs:
        keypoints = TEMPLATE_KEYPOINTS if keypoints is None else keypoints
        if config.enhances(role):
            crop = apply_enhance(crop, config.enhance)
        out.append((crop, keypoints))
        if config.flip:
            out.append((flip(crop), flip_keypoints(keypoints)))
    return out


def finalize(crops, config, role):
    """Photometric ops and flip on already-aligned crops -> list of crops that are actually fed to the network."""
    out = []
    for crop in crops:
        if config.enhances(role):
            crop = apply_enhance(crop, config.enhance)
        out.append(crop)
        if config.flip:
            out.append(flip(crop))
    return out


def combine(embeddings, norms):
    """Average several unit embeddings of the same face (and the mean of their norms) -> (unit embedding, quality)."""
    embeddings = np.asarray(embeddings, dtype=np.float32)
    embeddings = embeddings / np.maximum(np.linalg.norm(embeddings, axis=1, keepdims=True), 1e-9)
    mean = embeddings.mean(axis=0)
    return (mean / max(float(np.linalg.norm(mean)), 1e-9)).astype(np.float32), float(np.mean(norms))
