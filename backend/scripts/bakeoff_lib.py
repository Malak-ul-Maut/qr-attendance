"""
bakeoff_lib.py - the model-free logic behind scripts/bakeoff.py (numpy only; tested by tests/test_bakeoff_lib.py).

Nothing here loads a model or a video. It turns arrays of embeddings into answers:

  * metrics        genuine score g and hardest-impostor score h per look -> top-1, AUC, EER, DIR at a fixed false-accept
                   rate, d-prime; student-level (cluster) bootstrap confidence intervals, and PAIRED differences
  * recipes        which gallery rows a recipe uses (photo kinds, degraded copies, leave-one-shot-out)
  * pooling        a track's looks -> the pooled embedding production would use
  * labels         roster fuzzy-match, one label per track, a second "verify" frame that catches track swaps
  * replay         the production decision code (matching.decide_attempt) replayed on stored looks, with new settings
  * tracker eval   id switches / merges between two labelled frames for any tracker setting
  * detector eval  recall of a detector setting against the labelled boxes, by face width

Definitions that matter when reading the numbers
  look      one detection of a labelled face in one sampled frame
  g         the look's score against its OWN student (per-student score, see aggregator)
  h         the look's best score against any OTHER student = what an absent student could score
  top-1     g > h (the right student ranks first)
  DIR@FAR   share of looks that are accepted AND named correctly (g >= T and g > h) at the threshold T where only
            FAR of looks would be accepted as someone else (h >= T)
"""
import csv
import difflib
import re
import sys
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # recognize.py, matching.py ... live one folder up

from matching import RunState, TrackPool, decide_attempt, gate_track
from tracker import Tracker, iou

NON_STUDENT = {"?", "x", "", None}      # '?' unsure, 'x' not a student: never scored
FAR_TARGETS = (0.1, 0.01, 0.001)


# =============================================================================== scoring
def group_students(names):
    """(unique names, order, starts): gallery rows regrouped per student for per-student aggregation."""
    unique = list(dict.fromkeys(names))
    index = {n: i for i, n in enumerate(unique)}
    ids = np.array([index[n] for n in names])
    order = np.argsort(ids, kind="stable")
    starts = np.searchsorted(ids[order], np.arange(len(unique)))
    return unique, order, starts


def per_student_scores(probes, gallery, names, aggregator="max", chunk=2048):
    """(students, scores[n_probes, n_students]) - each probe's score against each student."""
    unique, order, starts = group_students(list(names))
    g = np.asarray(gallery, dtype=np.float32)[order]
    ends = list(starts[1:]) + [len(g)]
    out = np.empty((len(probes), len(unique)), dtype=np.float32)
    for lo in range(0, len(probes), chunk):
        s = probes[lo:lo + chunk] @ g.T
        if aggregator == "max":
            out[lo:lo + chunk] = np.maximum.reduceat(s, starts, axis=1)
        elif aggregator in ("mean2", "mean3"):
            k = int(aggregator[-1])
            for j, (a, b) in enumerate(zip(starts, ends)):
                top = np.sort(s[:, a:b], axis=1)[:, ::-1][:, :k]
                out[lo:lo + chunk, j] = top.mean(axis=1)
        else:
            raise ValueError(f"unknown aggregator '{aggregator}'")
    return unique, out


def genuine_impostor(probes, labels, gallery, names, aggregator="max"):
    """
    Per probe: g (own student), h (best other student), top (name of the best student), valid (own student is in the
    gallery and the label is a real student). Arrays have one entry per probe, valid or not.
    """
    labels = np.asarray(labels, dtype=object)
    students, scores = per_student_scores(np.asarray(probes, dtype=np.float32), gallery, names, aggregator)
    column = {s: i for i, s in enumerate(students)}
    own = np.array([column.get(l, -1) for l in labels])
    valid = own >= 0
    rows = np.arange(len(labels))
    g = np.where(valid, scores[rows, np.maximum(own, 0)], np.nan)
    masked = scores.copy()
    masked[rows[valid], own[valid]] = -np.inf
    h = masked.max(axis=1) if scores.shape[1] > 1 else np.full(len(labels), -1.0, dtype=np.float32)
    top = np.array(students, dtype=object)[scores.argmax(axis=1)]
    return {"g": g, "h": h, "top": top, "valid": valid}


# =============================================================================== metrics
def _auc(g, h):
    hs = np.sort(h)
    below = np.searchsorted(hs, g, side="left")
    equal = np.searchsorted(hs, g, side="right") - below
    return float((below + 0.5 * equal).mean() / len(hs))


def _curve(g, h):
    """Thresholds (descending), DIR(T), FAR(T)."""
    thresholds = np.unique(np.concatenate([g, h]))[::-1]
    n = len(g)
    ok = np.sort(g[g > h])
    far_sorted = np.sort(h)
    dir_t = (len(ok) - np.searchsorted(ok, thresholds, side="left")) / n
    far_t = (len(far_sorted) - np.searchsorted(far_sorted, thresholds, side="left")) / n
    return thresholds, dir_t, far_t


def _dir_at_far(g, h, far):
    thresholds, dir_t, far_t = _curve(g, h)
    allowed = far_t <= far
    if not allowed.any():
        return 0.0
    return float(dir_t[allowed].max())


def _threshold_at_far(g, h, far):
    thresholds, dir_t, far_t = _curve(g, h)
    allowed = far_t <= far
    return float(thresholds[allowed].min()) if allowed.any() else float(thresholds[0])


def _eer(g, h):
    thresholds, dir_t, far_t = _curve(g, h)
    frr = 1.0 - dir_t
    i = int(np.argmin(np.abs(frr - far_t)))
    return float((frr[i] + far_t[i]) / 2)


def _dprime(g, h):
    pooled = np.sqrt((g.var() + h.var()) / 2)
    return float((g.mean() - h.mean()) / pooled) if pooled > 1e-12 else 0.0


METRICS = {
    "top1": lambda g, h: float((g > h).mean()),
    "auc": _auc,
    "eer": _eer,
    "dprime": _dprime,
    "margin": lambda g, h: float((g - h).mean()),
    **{f"dir@far{far:g}": (lambda g, h, far=far: _dir_at_far(g, h, far)) for far in FAR_TARGETS},
}


def roc_metrics(g, h):
    """All metrics for one set of looks (arrays g, h, no NaN)."""
    g, h = np.asarray(g, dtype=np.float64), np.asarray(h, dtype=np.float64)
    if len(g) == 0:
        return {"n": 0}
    out = {"n": int(len(g)), "mean_g": float(g.mean()), "mean_h": float(h.mean())}
    out.update({name: fn(g, h) for name, fn in METRICS.items()})
    out.update({f"thr@far{far:g}": _threshold_at_far(g, h, far) for far in FAR_TARGETS})
    return out


def _cluster_index(clusters):
    clusters = np.asarray(clusters, dtype=object)
    groups = defaultdict(list)
    for i, c in enumerate(clusters):
        groups[c].append(i)
    return [np.array(v) for v in groups.values()]


def _resample(index, rng):
    pick = rng.integers(0, len(index), len(index))
    return np.concatenate([index[i] for i in pick])


def bootstrap_ci(g, h, clusters, key="auc", n_boot=200, seed=0):
    """95% interval of one metric when STUDENTS (clusters) are resampled, not looks: looks of one student are not independent."""
    g, h = np.asarray(g, dtype=np.float64), np.asarray(h, dtype=np.float64)
    index = _cluster_index(clusters)
    if len(index) < 2:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    fn = METRICS[key]
    values = [fn(g[s], h[s]) for s in (_resample(index, rng) for _ in range(n_boot))]
    return float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))


def bootstrap_diff(gA, hA, gB, hB, clusters, key="auc", n_boot=200, seed=0):
    """(difference A-B, low, high). A and B must be scored on the SAME looks in the same order (paired comparison)."""
    gA, hA, gB, hB = (np.asarray(x, dtype=np.float64) for x in (gA, hA, gB, hB))
    assert len(gA) == len(gB), "paired comparison needs the same looks"
    fn = METRICS[key]
    index = _cluster_index(clusters)
    diff = fn(gA, hA) - fn(gB, hB)
    if len(index) < 2:
        return diff, float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    values = []
    for _ in range(n_boot):
        s = _resample(index, rng)
        values.append(fn(gA[s], hA[s]) - fn(gB[s], hB[s]))
    return float(diff), float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))


def verdict(low, high):
    """Plain words for a paired difference interval."""
    if np.isnan(low):
        return "n/a"
    return "better" if low > 0 else "worse" if high < 0 else "no clear difference"


# =============================================================================== gallery recipes
def apply_recipe(gallery, recipe):
    """
    gallery: dict of arrays emb (n,d), student, kind ('self'|'reference'|'cctv'), tag ('photo'|'deg20'|...), shot ('' if none).
    recipe : {"kinds": {...}, "degrade": (20, 28), "exclude_shots": {...}, "exclude_sessions"...}
    Returns (embeddings, student names) for the rows the recipe uses.
    """
    kinds = set(recipe.get("kinds", {"self", "reference"}))
    degrade = {f"deg{w}" for w in recipe.get("degrade", ())}
    exclude_shots = set(recipe.get("exclude_shots", ()))
    keep = np.zeros(len(gallery["student"]), dtype=bool)
    for i, (kind, tag, shot) in enumerate(zip(gallery["kind"], gallery["tag"], gallery["shot"])):
        if kind not in kinds or shot in exclude_shots:
            continue
        keep[i] = tag == "photo" or tag in degrade
    emb = np.asarray(gallery["emb"])[keep]
    names = list(np.asarray(gallery["student"], dtype=object)[keep])
    return emb, names


RECIPES = {
    "clean": {"kinds": {"self", "reference"}},
    "+cctv": {"kinds": {"self", "reference", "cctv"}},
    "+degrade 20": {"kinds": {"self", "reference"}, "degrade": (20,)},
    "+degrade 20,28": {"kinds": {"self", "reference"}, "degrade": (20, 28)},
    "+degrade 20,28,36": {"kinds": {"self", "reference"}, "degrade": (20, 28, 36)},
    "+degrade 20,28 +cctv": {"kinds": {"self", "reference", "cctv"}, "degrade": (20, 28)},
}


# =============================================================================== pooling
def quality_values(looks, mode="norm"):
    return {"norm": looks["norm"], "equal": np.ones(len(looks["norm"])), "sharp": looks["sharp"], "size": looks["width"]}[mode]


def pool_tracks(looks, stride=1, n_looks=10, top_k=5, keep_fraction=0.6, quality="norm", start=0):
    """
    One pooled embedding per track, built like production does: the track's first `n_looks` attempts (every `stride`-th
    sampled frame), the best `top_k` by quality, those not much worse than the best, quality-weighted.
    Returns a looks-like dict with one row per track (label, clip, track, emb).
    """
    q = quality_values(looks, quality)
    by_track = defaultdict(list)
    for i in np.argsort(looks["frame"], kind="stable"):
        by_track[(looks["clip"][i], int(looks["track"][i]))].append(i)
    emb, label, clip_out, track_out, used = [], [], [], [], []
    for (clip, track), idx in by_track.items():
        idx = [i for i in idx if int(looks["frame"][i]) % stride == start % stride][:n_looks]   # the clip's every-Nth-frame grid
        if not idx:
            continue
        pool = TrackPool(top_k=top_k, keep_fraction=keep_fraction)
        for i in idx:
            pool.add(looks["emb"][i], float(q[i]))
        pooled = pool.pooled()
        if pooled is None:
            continue
        emb.append(pooled)
        label.append(looks["label"][idx[0]])
        clip_out.append(clip)
        track_out.append(track)
        used.append(len(idx))
    return {"emb": np.stack(emb) if emb else np.zeros((0, looks["emb"].shape[1]), np.float32),
            "label": np.array(label, dtype=object), "clip": np.array(clip_out, dtype=object),
            "track": np.array(track_out), "used": np.array(used)}


# =============================================================================== labels
class Roster:
    """Gallery folder names, with a forgiving search (roll number, part of a name, typos)."""

    def __init__(self, folders):
        self.folders = sorted(folders)

    def search(self, query, limit=6):
        query = query.strip().lower()
        if not query:
            return []
        if query in self.folders:
            return [query]
        tokens = [t for t in re.split(r"[\s_\-]+", query) if t]
        hits = [f for f in self.folders if all(t in f.lower() for t in tokens)]
        starts = [f for f in self.folders if f.lower().startswith(query + "_") or f.lower() == query]
        close = difflib.get_close_matches(query, [f.lower() for f in self.folders], n=limit, cutoff=0.5)
        lower = {f.lower(): f for f in self.folders}
        out = list(dict.fromkeys(starts + hits + [lower[c] for c in close]))
        return out[:limit]


def track_lengths(frames):
    """{track id: number of sampled frames it appears in}. frames = [{'dets': [{'track': id, ...}]}]"""
    lengths = defaultdict(int)
    for frame in frames:
        for det in frame["dets"]:
            lengths[det["track"]] += 1
    return dict(lengths)


def choose_label_frames(frames, min_fraction=0.4):
    """(label position, verify position): the frame with the most long-lived tracks in the first half, and in the last quarter."""
    lengths = track_lengths(frames)
    long_tracks = {t for t, n in lengths.items() if n >= min_fraction * len(frames)}
    if not long_tracks:
        long_tracks = set(lengths)

    def best(lo, hi):
        if hi <= lo:
            return lo
        mid = (lo + hi) // 2
        return max(range(lo, hi), key=lambda i: (sum(d["track"] in long_tracks for d in frames[i]["dets"]), -abs(i - mid)))

    n = len(frames)
    return best(0, max(1, n // 2)), best(min(n - 1, (3 * n) // 4), n) if n > 1 else 0


def apply_first_labels(labels, frame, answers):
    """answers: {detection index in frame['dets']: label or None(skip)}. Sets labels[track] (a label for a student
    already used by ANOTHER track in the same frame is allowed - a student can be detected twice - but returned as a note)."""
    notes = []
    for i, answer in answers.items():
        if answer is None:
            continue
        labels[frame["dets"][i]["track"]] = answer
    seen = defaultdict(list)
    for i, answer in answers.items():
        if answer not in NON_STUDENT:
            seen[answer].append(frame["dets"][i]["track"])
    for student, tracks in seen.items():
        if len(tracks) > 1:
            notes.append(f"{student} was given to tracks {tracks} in the same frame")
    return notes


def apply_verify_labels(labels, frame, answers):
    """
    Second look at a later frame. A track whose verify label differs from its first label is a swap suspect: it is set
    to '?' (excluded) and reported. A track with no label yet simply gets the new one.
    Returns {"checked", "agree", "swaps": [{track, first, verify}], "added"}.
    """
    report = {"checked": 0, "agree": 0, "swaps": [], "added": 0}
    for i, answer in answers.items():
        if answer is None:
            continue
        track = frame["dets"][i]["track"]
        first = labels.get(track)
        if first is None:
            labels[track] = answer
            report["added"] += 1
            continue
        report["checked"] += 1
        if first == answer:
            report["agree"] += 1
        else:
            report["swaps"].append({"track": track, "first": first, "verify": answer})
            labels[track] = "?"
    return report


def student_labels(labels):
    return {t: l for t, l in labels.items() if l not in NON_STUDENT}


# =============================================================================== looks -> replay
def looks_by_clip(looks):
    """{clip: {frame position: [look dict]}} from the arrays, in the order production would see them."""
    out = defaultdict(lambda: defaultdict(list))
    for i in range(len(looks["track"])):
        out[looks["clip"][i]][int(looks["frame"][i])].append({
            "track": int(looks["track"][i]), "emb": looks["emb"][i], "norm": float(looks["norm"][i]),
            "sharp": float(looks["sharp"][i]), "width": float(looks["width"][i]), "height": float(looks["height"][i]),
            "label": looks["label"][i]})
    return out


def settings_namespace(**overrides):
    """The decision settings (matching.decide_attempt / gate_track read these), production defaults + overrides."""
    base = dict(threshold=0.26, accept_threshold=0.28, max_attempts=10, min_face=0, min_sharpness=0.0, min_norm=0.0,
                pool_attempts=True, pool_top_k=5, aggregator="max", margin=0.0, pool_gate=0.0, trace=False)
    unknown = set(overrides) - set(base)
    if unknown:
        raise ValueError(f"unknown decision settings: {sorted(unknown)}")
    base.update(overrides)
    return SimpleNamespace(**base)


def replay_clip(clip_frames, gallery, identity_map, args, stride=1, start=0, max_frames=None):
    """
    Run the production decision code over one clip's stored looks. `clip_frames` = {frame position: [look]}.
    Every `stride`-th sampled frame is processed (production's --every), beginning at `start`.
    Returns (state, events) with events = [{student, track, frame_index, attempt, score}].
    """
    state = RunState()
    events = []
    positions = sorted(clip_frames)[start::stride]
    if max_frames is not None:
        positions = positions[:max_frames]
    for n, pos in enumerate(positions):
        state.frames_processed += 1
        state.frame_faces = {}
        for look in clip_frames[pos]:
            tid = look["track"]
            state.track_sightings[tid] = state.track_sightings.get(tid, 0) + 1
            state.track_last_seen[tid] = state.frames_processed
            info = {"status": "queued", "score": None, "quality": None}
            state.frame_faces[tid] = info
            if not gate_track(state, tid, info, args,
                              big_enough=lambda look=look: min(look["width"], look["height"]) >= args.min_face,
                              sharp_enough=lambda look=look: look["sharp"] >= args.min_sharpness):
                continue
            face = SimpleNamespace(normed_embedding=look["emb"], quality=look["norm"], aligned_bgr=None)
            record = decide_attempt(state, tid, face, gallery, identity_map, args, pos)
            if record is not None:
                events.append({"student": record["student_id"], "track": tid, "frame_index": n, "pos": pos,
                               "attempt": record["attempt"], "score": record["best_score"]})
    return state, events


def score_events(events, labels, adjudications=None, clip=""):
    """
    Judge one clip's events against the labels.
      correct     the track was labelled with the student the system named
      wrong       the track was labelled with a DIFFERENT student (a wrong identification)
      unverified  the track has no student label ('?', 'x' or never labelled); `adjudications[(clip, track, student)]`
                  (True = yes that is them, False = no) settles it, else it stays unverified
    Returns {"correct": set(students), "wrong": [..], "false_accept": [..], "unverified": [..]}
    """
    adjudications = adjudications or {}
    out = {"correct": set(), "wrong": [], "false_accept": [], "unverified": []}
    for event in events:
        label = labels.get(event["track"])
        if label not in NON_STUDENT:
            if label == event["student"]:
                out["correct"].add(event["student"])
            else:
                out["wrong"].append({**event, "label": label})
            continue
        verdict_ = adjudications.get((clip, event["track"], event["student"]))
        if verdict_ is True:
            out["correct"].add(event["student"])
        elif verdict_ is False:
            out["false_accept"].append(event)
        else:
            out["unverified"].append(event)
    return out


def replay_all(clip_looks, clip_labels, gallery, identity_map, args, stride=1, max_frames=None, adjudications=None,
               clips=None):
    """Replay every (or the chosen) clip and total the outcome. Truth = students with at least one labelled track."""
    totals = {"present": 0, "correct": 0, "wrong": 0, "false_accept": 0, "unverified": 0, "first_attempt": [], "clips": 0}
    for clip, frames in clip_looks.items():
        if clips is not None and clip not in clips:
            continue
        labels = clip_labels.get(clip, {})
        truth = set(student_labels(labels).values()) & {s for s in identity_map}
        _, events = replay_clip(frames, gallery, identity_map, args, stride=stride, max_frames=max_frames)
        result = score_events(events, labels, adjudications, clip)
        totals["clips"] += 1
        totals["present"] += len(truth)
        totals["correct"] += len(result["correct"] & truth) + len(result["correct"] - truth)
        totals["wrong"] += len(result["wrong"])
        totals["false_accept"] += len(result["false_accept"])
        totals["unverified"] += len(result["unverified"])
        totals["first_attempt"] += [e["attempt"] for e in events if e["student"] in result["correct"]]
    totals["recall"] = totals["correct"] / totals["present"] if totals["present"] else float("nan")
    totals["bad"] = totals["wrong"] + totals["false_accept"]
    totals["median_attempt"] = float(np.median(totals["first_attempt"])) if totals["first_attempt"] else float("nan")
    return totals


def pick_operating_point(rows, max_bad=0, tolerance=0.005):
    """
    Among the rows with bad (wrong + adjudicated false accepts) <= max_bad, keep those whose recall is within `tolerance`
    of the best and that need the fewest unverified guesses, then take the MIDDLE of them (by threshold). The middle of a
    plateau survives a small shift between today's clips and next month's; the edge of it (the strictest threshold that
    still works) is where over-fitting to these clips shows up. Returns the row (with "plateau": (low, high, n)) or None.
    """
    ok = [r for r in rows if r["bad"] <= max_bad and not np.isnan(r["recall"])]
    if not ok:
        return None
    best = max(r["recall"] for r in ok)
    top = [r for r in ok if r["recall"] >= best - tolerance]
    fewest = min(r["unverified"] for r in top)
    top = sorted((r for r in top if r["unverified"] == fewest),
                 key=lambda r: (r.get("threshold", 0), r.get("accept_threshold", 0), r.get("margin", 0)))
    chosen = dict(top[len(top) // 2])
    chosen["plateau"] = (top[0].get("threshold"), top[-1].get("threshold"), len(top))
    return chosen


def decision_grid(base, thresholds, accepts_above, margins):
    """The coordinated (threshold x accept x margin) grid around `base`; accept = threshold + offset (0 offset = off)."""
    rows = []
    for t in thresholds:
        for a in accepts_above:
            for m in margins:
                rows.append({**base, "threshold": round(float(t), 4), "accept_threshold": 0.0 if a == 0 else round(float(t + a), 4),
                             "margin": float(m)})
    return rows


# =============================================================================== tracker evaluation
def run_tracker(frames, **params):
    """Re-track stored detections with other tracker settings. Returns [[track id per detection] per frame]."""
    tracker = Tracker(**params)
    return [tracker.update([d["bbox"] for d in frame["dets"]]) for frame in frames]


def tracker_eval(frames, first_pos, first_answers, verify_pos, verify_answers, **params):
    """
    Uses the two hand-confirmed frames. For every student labelled in BOTH: did the tracker keep one id from the first
    frame to the verify frame (consistent), or not (id switch / fragmented)? And did any id cover two different students
    (merge) in either frame? Returns counts.
    """
    ids = run_tracker(frames, **params)
    first = {a: ids[first_pos][i] for i, a in first_answers.items() if a not in NON_STUDENT}
    verify = {a: ids[verify_pos][i] for i, a in verify_answers.items() if a not in NON_STUDENT}
    both = set(first) & set(verify)
    consistent = sum(first[s] == verify[s] for s in both)

    def merges(mapping):
        by_id = defaultdict(set)
        for student, tid in mapping.items():
            by_id[tid].add(student)
        return sum(len(v) > 1 for v in by_id.values())

    return {"students": len(both), "consistent": consistent, "switched": len(both) - consistent,
            "merged_ids": merges(first) + merges(verify), "tracks": len({t for row in ids for t in row})}


# =============================================================================== detector evaluation
def width_bin(width, edges=(20, 30, 50, 80)):
    for i, edge in enumerate(edges):
        if width < edge:
            return f"<{edge}px" if i == 0 else f"{edges[i - 1]}-{edge}px"
    return f"{edges[-1]}+px"


def detection_recall(reference, detections, iou_threshold=0.3):
    """
    reference: [[bbox,...] per frame] labelled boxes; detections: [[bbox,...] per frame] from another detector setting.
    Returns {"recall": overall, "by_width": {bin: (found, total)}, "extra_per_frame": mean boxes matching nothing}.
    """
    found = total = extra = 0
    by_bin = defaultdict(lambda: [0, 0])
    for ref_boxes, det_boxes in zip(reference, detections):
        used = set()
        for box in ref_boxes:
            total += 1
            b = width_bin(box[2] - box[0])
            by_bin[b][1] += 1
            best, best_i = 0.0, None
            for j, d in enumerate(det_boxes):
                if j in used:
                    continue
                value = iou(box, d)
                if value > best:
                    best, best_i = value, j
            if best >= iou_threshold:
                found += 1
                by_bin[b][0] += 1
                used.add(best_i)
        extra += len(det_boxes) - len(used)
    frames = max(1, len(reference))
    return {"recall": found / total if total else float("nan"),
            "by_width": {k: tuple(v) for k, v in sorted(by_bin.items())}, "extra_per_frame": extra / frames}


# =============================================================================== reporting helpers
def fmt(value, digits=3):
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "-"
    return f"{value:.{digits}f}" if isinstance(value, (float, np.floating)) else str(value)


def md_table(rows, columns, header=None):
    """rows: list of dicts; columns: [(key, title)]. A GitHub-style markdown table."""
    header = header or [title for _, title in columns]
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    for row in rows:
        lines.append("| " + " | ".join(fmt(row.get(key)) for key, _ in columns) + " |")
    return "\n".join(lines)


def write_csv(path, rows):
    if not rows:
        return
    keys = list(dict.fromkeys(k for row in rows for k in row))
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)
