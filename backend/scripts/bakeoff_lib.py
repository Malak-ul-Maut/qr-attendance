"""
bakeoff_lib.py (v2) - the model-free logic behind scripts/bakeoff.py (numpy only; tested by tests/test_bakeoff_lib.py).

Nothing here loads a model or a video. It turns arrays of embeddings into answers.

What changed from v1, and why (each item closes a way the old numbers could mislead):

* IMPOSTORS    faces labelled 'x' (a real face, but not an enrolled student) and 'n' (not a face at all) are scored against the WHOLE
               gallery. They give the open-set false-accept rate (what production meets: ~60 faces, only some enrolled). v1 only
               scored enrolled students against each other, so a stranger matching a student could never show up.
* WEIGHTS      every metric accepts weights; the default ('balanced') gives each track equal say, so students who sit still in the
               front row (many looks) no longer outvote the back row.
* BOOTSTRAP    resamples CLIPS and STUDENTS (genuine looks) / TRACKS (impostor looks) together - a crossed bootstrap - and every
               comparison reuses the same draws (paired). Verdicts use Holm-adjusted p-values, an equivalence margin and print the
               minimum detectable difference, so 'no clear difference' is split into 'equivalent' and 'inconclusive'.
* REPLAY       decisions are replayed the way production runs: only every Nth frame, for a 10 s scan, from several start offsets,
               with the tracker RE-RUN at that cadence (not the dense prep tracker), judged per look. Every embedded face takes
               part - labelled students, 'x', unlabelled - so false accepts can actually happen.
* SELECTION    leave-one-clip-out: settings are chosen on the other clips and scored on the held-out one.
* SELF-TESTS   known-answer checks on the metric code (selftest_report), run by `bakeoff.py selftest`.

Definitions that matter when reading the numbers

look      one detection of a face in one embedded frame
g         the look's score against its OWN student (per-student score, see aggregator)
h         the look's best score against any OTHER student = what an absent student could score
top-1     g > h (the right student ranks first)
DIR@FAR   share of genuine looks accepted AND named correctly (g >= T and g > h) at the threshold T where only FAR of the
          comparison faces are accepted. 'closed' FAR counts the other students' looks (h >= T); 'open' (odir) counts impostor
          faces ('x'/'n') whose best score against the whole gallery reaches T.
"""
import csv
import difflib
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # recognize.py, matching.py ... live one folder up

from matching import RunState, TrackPool, decide_attempt, gate_track  # noqa: E402
from tracker import Tracker, iou  # noqa: E402

IMPOSTOR = {"x", "n"}                       # x = a face of someone NOT enrolled, n = not a face (false detection)
NON_STUDENT = {"?", "x", "n", "", None}     # never scored as a student ('?' = unsure, left out of everything but replay)
FAR_TARGETS = (0.1, 0.01, 0.001)


def is_student_label(label):
    return label not in NON_STUDENT


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
    Per probe: g (own student), h (best OTHER student), top (best student's name), best_all (best score over ALL students -
    what an impostor face gets), valid (label is an enrolled student with gallery photos), impostor (label 'x' or 'n').
    """
    labels = np.asarray(labels, dtype=object)
    if len(labels) == 0 or len(names) == 0:
        n = len(labels)
        return {"g": np.full(n, np.nan), "h": np.full(n, -1.0), "top": np.array([""] * n, dtype=object),
                "valid": np.zeros(n, bool), "impostor": np.array([l in IMPOSTOR for l in labels], bool),
                "best_all": np.full(n, -1.0)}
    students, scores = per_student_scores(np.asarray(probes, dtype=np.float32), gallery, names, aggregator)
    return gi_from_scores(scores, students, labels)


def gi_from_scores(scores, students, labels):
    """genuine_impostor() from an already computed score matrix [looks x students]."""
    labels = np.asarray(labels, dtype=object)
    column = {s: i for i, s in enumerate(students)}
    own = np.array([column.get(l, -1) for l in labels])
    valid = own >= 0
    rows = np.arange(len(labels))
    g = np.where(valid, scores[rows, np.maximum(own, 0)], np.nan)
    masked = scores.copy()
    masked[rows[valid], own[valid]] = -np.inf
    h = masked.max(axis=1) if scores.shape[1] > 1 else np.full(len(labels), -1.0, dtype=np.float32)
    top = np.array(students, dtype=object)[scores.argmax(axis=1)]
    return {"g": g, "h": h, "top": top, "valid": valid, "best_all": scores.max(axis=1),
            "impostor": np.array([l in IMPOSTOR for l in labels], bool)}


def fuse_scores(matrices, labels, students):
    """
    Score-level fusion of several models: each model's score matrix [probes x students] is standardised with its own impostor entries
    (every probe-student pair that is not the probe's own student), then the matrices are averaged. Models have different score scales,
    so raw averaging would let one model dominate. Returns the genuine_impostor dict of the fused scores.
    """
    labels = np.asarray(labels, dtype=object)
    own = np.array([[l == s for s in students] for l in labels])
    fused = np.zeros(matrices[0].shape, dtype=np.float64)
    for m in matrices:
        impostor_entries = m[~own]
        fused += (m - impostor_entries.mean()) / max(float(impostor_entries.std()), 1e-6)
    return gi_from_scores((fused / len(matrices)).astype(np.float32), students, labels)


def znorm_gi(looks, gallery, names, aggregator="max", min_cohort=20):
    """
    Per-student score normalisation (Z-norm). Some students' gallery photos score high against EVERYONE ('hubs'); subtracting each
    student's typical impostor score and dividing by its spread evens that out. The statistics for the looks of a clip come from the
    OTHER clips only (the other students' looks and the 'x'/'n' faces), so nothing is learned from the data being scored.
    Returns (gi, applied: bool, hub_spread) - scores are then in z units (thresholds change; AUC / top-1 / DIR are comparable).
    hub_spread = standard deviation across students of their mean impostor score (large = hubness matters).
    """
    students, scores = per_student_scores(np.asarray(looks["emb"], dtype=np.float32), gallery, names, aggregator)
    labels = np.asarray(looks["label"], dtype=object)
    clip = np.asarray(looks["clip"], dtype=object)
    column = {s: i for i, s in enumerate(students)}
    own = np.array([column.get(l, -1) for l in labels])
    cohort_all = np.array([(l in IMPOSTOR) or (l in column) for l in labels])
    out, applied = scores.copy(), False
    means = []
    for c in np.unique(clip):
        ev = clip == c
        co = (~ev) & cohort_all
        if co.sum() < min_cohort:
            continue
        mu, sd = np.empty(len(students)), np.empty(len(students))
        for j in range(len(students)):
            vals = scores[co & (own != j), j]
            mu[j], sd[j] = (vals.mean(), max(float(vals.std()), 1e-3)) if len(vals) else (0.0, 1.0)
        out[ev] = (scores[ev] - mu) / sd
        means.append(mu)
        applied = True
    spread = float(np.mean([m.std() for m in means])) if means else float("nan")
    return gi_from_scores(out, students, labels), applied, spread


def clip_bootstrap_totals(per_clip, n_boot=2000, seed=0):
    """95% intervals for recall and wrong+false-accepts per scan from per-clip replay totals, resampling whole clips."""
    rng = np.random.default_rng(seed)
    clips = list(per_clip)
    if len(clips) < 2:
        return {"recall": (float("nan"), float("nan")), "bad_per_scan": (float("nan"), float("nan"))}
    recalls, bads = [], []
    for _ in range(n_boot):
        pick = rng.integers(0, len(clips), len(clips))
        t = add_totals([per_clip[clips[i]] for i in pick])
        recalls.append(t["recall"])
        bads.append(t["bad_per_scan"])
    return {"recall": (float(np.nanpercentile(recalls, 2.5)), float(np.nanpercentile(recalls, 97.5))),
            "bad_per_scan": (float(np.nanpercentile(bads, 2.5)), float(np.nanpercentile(bads, 97.5)))}


# =============================================================================== weighted metrics
def unit_keys(clip, track):
    """One string per (clip, track): the unit that 'one face' means (looks of a track are not independent)."""
    return np.array([f"{c}|{int(t)}" for c, t in zip(clip, track)], dtype=object)


def balance_weights(units):
    """Weight 1/(looks in the unit), scaled to mean 1: every unit (track) gets equal say."""
    units = np.asarray(units, dtype=object)
    if len(units) == 0:
        return np.zeros(0)
    _, inverse, counts = np.unique(units.astype(str), return_inverse=True, return_counts=True)
    w = 1.0 / counts[inverse]
    return w * (len(w) / w.sum())


class ScoreSet:
    """
    Genuine scores (g, h per look of an enrolled student) and impostor scores (ho per look of an 'x'/'n' face) with the keys the
    bootstrap resamples: clip, student (genuine) / track (impostor). `idx_g` / `idx_o` = row numbers in the looks arrays, so two
    ScoreSets built from the same looks can be checked to be PAIRED.
    """

    def __init__(self, g, h, clip_g, student_g, w_g, ho=None, clip_o=None, unit_o=None, w_o=None, idx_g=None, idx_o=None):
        self.g, self.h = np.asarray(g, float), np.asarray(h, float)
        self.clip_g, self.student_g, self.w_g = np.asarray(clip_g, dtype=object), np.asarray(student_g, dtype=object), np.asarray(w_g, float)
        n_o = 0 if ho is None else len(ho)
        self.ho = np.zeros(0) if ho is None else np.asarray(ho, float)
        self.clip_o = np.zeros(0, dtype=object) if clip_o is None else np.asarray(clip_o, dtype=object)
        self.unit_o = np.zeros(0, dtype=object) if unit_o is None else np.asarray(unit_o, dtype=object)
        self.w_o = np.zeros(n_o) if w_o is None else np.asarray(w_o, float)
        self.idx_g = np.arange(len(self.g)) if idx_g is None else np.asarray(idx_g)
        self.idx_o = np.arange(n_o) if idx_o is None else np.asarray(idx_o)
        self._auc_kernel = None

    @property
    def n_g(self):
        return len(self.g)

    @property
    def n_o(self):
        return len(self.ho)

    def subset_g(self, mask):
        """A ScoreSet with only the genuine looks where mask is True (impostors kept)."""
        mask = np.asarray(mask, bool)
        return ScoreSet(self.g[mask], self.h[mask], self.clip_g[mask], self.student_g[mask], self.w_g[mask], self.ho, self.clip_o,
                        self.unit_o, self.w_o, self.idx_g[mask], self.idx_o)

    def auc_kernel(self):
        if self._auc_kernel is None:
            self._auc_kernel = AucKernel(self.g, self.h)
        return self._auc_kernel


def make_scoreset(looks, gi, weighting="balanced", mask=None):
    """ScoreSet from a looks dict (needs clip, track, label) and the genuine_impostor() result for those looks."""
    n = len(looks["label"])
    keep = np.ones(n, bool) if mask is None else np.asarray(mask, bool)
    valid, imp = gi["valid"] & keep, gi["impostor"] & keep
    units = unit_keys(looks["clip"], looks["track"])
    wb = balance_weights(units) if weighting == "balanced" else np.ones(n)
    ig, io = np.where(valid)[0], np.where(imp)[0]
    # weights re-normalised inside each group so the genuine and impostor sides each average 1
    def norm(w):
        return w * (len(w) / w.sum()) if len(w) and w.sum() > 0 else w
    wg = norm(unit_weights(units[ig], weighting)) if len(ig) else np.zeros(0)
    wo = norm(unit_weights(units[io], weighting)) if len(io) else np.zeros(0)
    _ = wb
    return ScoreSet(gi["g"][ig], gi["h"][ig], np.asarray(looks["clip"], dtype=object)[ig], np.asarray(looks["label"], dtype=object)[ig], wg,
                    gi["best_all"][io], np.asarray(looks["clip"], dtype=object)[io], units[io], wo, ig, io)


def unit_weights(units, weighting):
    return balance_weights(units) if weighting == "balanced" else np.ones(len(units))


class AucKernel:
    """Weighted AUC = P(g_i > h_j) (ties half) over all pairs of looks, with the sort done ONCE so each bootstrap draw is O(n)."""

    def __init__(self, g, h):
        self.order = np.argsort(h, kind="stable")
        hs = np.asarray(h)[self.order]
        self.lo = np.searchsorted(hs, g, side="left")
        self.hi = np.searchsorted(hs, g, side="right")

    def __call__(self, w):
        total = float(w.sum())
        if total <= 0:
            return float("nan")
        cum = np.concatenate([[0.0], np.cumsum(w[self.order])])
        below, equal = cum[self.lo], cum[self.hi] - cum[self.lo]
        return float((w * (below + 0.5 * equal)).sum() / (total * total))


def _curve(correct_scores, correct_w, far_scores, far_w, norm_correct, norm_far):
    """Thresholds (descending), DIR(T), FAR(T) with weights."""
    thresholds = np.unique(np.concatenate([correct_scores, far_scores]))[::-1]
    oc = np.argsort(correct_scores)
    cs, cw = correct_scores[oc], np.concatenate([[0.0], np.cumsum(correct_w[oc])])
    of = np.argsort(far_scores)
    fs, fw = far_scores[of], np.concatenate([[0.0], np.cumsum(far_w[of])])
    dir_t = (cw[-1] - cw[np.searchsorted(cs, thresholds, side="left")]) / max(norm_correct, 1e-12)
    far_t = (fw[-1] - fw[np.searchsorted(fs, thresholds, side="left")]) / max(norm_far, 1e-12)
    return thresholds, dir_t, far_t


def _closed_curve(g, h, w):
    ok = g > h
    return _curve(g[ok], w[ok], h, w, w.sum(), w.sum())


def _open_curve(ss, w_g, w_o):
    ok = ss.g > ss.h
    return _curve(ss.g[ok], w_g[ok], ss.ho, w_o, w_g.sum(), w_o.sum())


def _at_far(curve, far):
    thresholds, dir_t, far_t = curve
    allowed = far_t <= far
    return (float(dir_t[allowed].max()) if allowed.any() else 0.0,
            float(thresholds[allowed].min()) if allowed.any() else float(thresholds[0]))


def _wmean_var(x, w):
    m = float((x * w).sum() / w.sum())
    return m, float((w * (x - m) ** 2).sum() / w.sum())


def _m_top1(ss, wg, wo):
    return float((wg * (ss.g > ss.h)).sum() / wg.sum()) if wg.sum() > 0 else float("nan")


def _m_auc(ss, wg, wo):
    return ss.auc_kernel()(wg)


def _m_margin(ss, wg, wo):
    return float((wg * (ss.g - ss.h)).sum() / wg.sum()) if wg.sum() > 0 else float("nan")


def _m_dprime(ss, wg, wo):
    mg, vg = _wmean_var(ss.g, wg)
    mh, vh = _wmean_var(ss.h, wg)
    pooled = math.sqrt((vg + vh) / 2)
    return (mg - mh) / pooled if pooled > 1e-12 else 0.0


def _m_eer(ss, wg, wo):
    thresholds, dir_t, far_t = _closed_curve(ss.g, ss.h, wg)
    frr = 1.0 - dir_t
    i = int(np.argmin(np.abs(frr - far_t)))
    return float((frr[i] + far_t[i]) / 2)


def _closed_dir(far):
    return lambda ss, wg, wo: _at_far(_closed_curve(ss.g, ss.h, wg), far)[0] if wg.sum() > 0 else float("nan")


def _open_dir(far):
    def fn(ss, wg, wo):
        if ss.n_o == 0 or wo.sum() <= 0 or wg.sum() <= 0:
            return float("nan")
        return _at_far(_open_curve(ss, wg, wo), far)[0]
    return fn


METRICS = {"top1": _m_top1, "auc": _m_auc, "eer": _m_eer, "dprime": _m_dprime, "margin": _m_margin,
           **{f"dir@far{far:g}": _closed_dir(far) for far in FAR_TARGETS},
           **{f"odir@far{far:g}": _open_dir(far) for far in FAR_TARGETS}}


def roc_metrics(ss):
    """All metrics (point estimates, with the set's own weights) plus the thresholds at each FAR."""
    if ss.n_g == 0:
        return {"n": 0}
    wg, wo = ss.w_g, ss.w_o
    out = {"n": int(ss.n_g), "n_impostor": int(ss.n_o), "mean_g": float((ss.g * wg).sum() / wg.sum()), "mean_h": float((ss.h * wg).sum() / wg.sum())}
    out.update({name: fn(ss, wg, wo) for name, fn in METRICS.items()})
    closed = _closed_curve(ss.g, ss.h, wg)
    out.update({f"thr@far{far:g}": _at_far(closed, far)[1] for far in FAR_TARGETS})
    if ss.n_o:
        opened = _open_curve(ss, wg, wo)
        out.update({f"othr@far{far:g}": _at_far(opened, far)[1] for far in FAR_TARGETS})
        out["open_trials"] = float(wo.sum() ** 2 / max((wo ** 2).sum(), 1e-12))     # effective number of impostor looks
    return out


# =============================================================================== crossed bootstrap
class Resampler:
    """
    The bootstrap draws for one set of looks, made ONCE and reused by every comparison (so differences are paired).
    Clips are resampled; genuine looks by student; impostor looks by track. A look's multiplicity is clip count x unit count.
    """

    def __init__(self, ss, n_boot=1000, seed=0):
        self.n_boot = int(n_boot)
        rng = np.random.default_rng(seed)

        def counts(keys, extra=None):
            uniq, inverse = np.unique(np.asarray(keys, dtype=object).astype(str), return_inverse=True)
            n = len(uniq)
            if n < 2:
                return np.ones((self.n_boot, max(n, 1)), np.float32), inverse
            return rng.multinomial(n, np.ones(n) / n, size=self.n_boot).astype(np.float32), inverse

        clips = np.concatenate([ss.clip_g.astype(str), ss.clip_o.astype(str)]) if ss.n_o else ss.clip_g.astype(str)
        c_counts, c_inv = counts(clips)
        s_counts, s_inv = counts(ss.student_g)
        self.mult_g = c_counts[:, c_inv[:ss.n_g]] * s_counts[:, s_inv]
        if ss.n_o:
            t_counts, t_inv = counts(ss.unit_o)
            self.mult_o = c_counts[:, c_inv[ss.n_g:]] * t_counts[:, t_inv]
        else:
            self.mult_o = np.zeros((self.n_boot, 0), np.float32)
        self.n_clips = len(np.unique(clips))
        self.n_students = len(np.unique(ss.student_g.astype(str)))

    def values(self, ss, metric):
        fn = METRICS[metric]
        out = np.empty(self.n_boot)
        for b in range(self.n_boot):
            out[b] = fn(ss, ss.w_g * self.mult_g[b], ss.w_o * self.mult_o[b])
        return out


def bootstrap_ci(ss, metric="auc", resampler=None, n_boot=1000, seed=0):
    resampler = resampler or Resampler(ss, n_boot, seed)
    v = resampler.values(ss, metric)
    v = v[~np.isnan(v)]
    if len(v) < 10:
        return float("nan"), float("nan")
    return float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))


def paired_diff(a, b, metric="auc", resampler=None, n_boot=1000, seed=0):
    """
    A - B on the SAME looks. Returns dict(diff, lo, hi, p, mde, n_clips, n_students). p = two-sided bootstrap p-value;
    mde = 2.8 x the bootstrap standard deviation = the smallest true difference this data could detect 80% of the time.
    """
    assert a.n_g == b.n_g and np.array_equal(a.idx_g, b.idx_g), "paired comparison needs the same looks"
    resampler = resampler or Resampler(a, n_boot, seed)
    va, vb = resampler.values(a, metric), resampler.values(b, metric)
    d = va - vb
    ok = ~np.isnan(d)
    d = d[ok]
    fn = METRICS[metric]
    point = fn(a, a.w_g, a.w_o) - fn(b, b.w_g, b.w_o)
    if len(d) < 10:
        return {"diff": float(point), "lo": float("nan"), "hi": float("nan"), "p": float("nan"), "mde": float("nan"),
                "n_clips": resampler.n_clips, "n_students": resampler.n_students}
    p = 2 * min((np.sum(d <= 0) + 1) / (len(d) + 1), (np.sum(d >= 0) + 1) / (len(d) + 1))
    return {"diff": float(point), "lo": float(np.percentile(d, 2.5)), "hi": float(np.percentile(d, 97.5)), "p": float(min(p, 1.0)),
            "mde": float(2.8 * d.std()), "n_clips": resampler.n_clips, "n_students": resampler.n_students}


def holm_adjust(pvalues):
    """Holm step-down adjusted p-values (same order as the input)."""
    p = np.asarray(pvalues, float)
    order = np.argsort(p)
    adjusted = np.empty_like(p)
    running = 0.0
    m = len(p)
    for rank, i in enumerate(order):
        running = max(running, (m - rank) * p[i])
        adjusted[i] = min(1.0, running)
    return adjusted


def verdict(lo, hi, margin=0.0, p_adj=None):
    """
    better / worse    the interval excludes 0 (and, when given, the Holm-adjusted p < 0.05)
    equivalent        the whole interval lies inside +-margin
    inconclusive      none of the above: the data cannot tell (look at the MDE before concluding 'no difference')
    """
    if np.isnan(lo):
        return "n/a"
    significant = p_adj is None or p_adj < 0.05
    if lo > 0 and significant:
        return "better"
    if hi < 0 and significant:
        return "worse"
    if margin > 0 and lo > -margin and hi < margin:
        return "equivalent"
    return "inconclusive"


class Ledger:
    """Counts every comparison and configuration tried, so the final report can say how many chances there were to get lucky."""

    def __init__(self):
        self.families = defaultdict(int)
        self.configs = []

    def add_family(self, name, n):
        self.families[name] += n

    def note(self, text):
        self.configs.append(text)

    @property
    def total(self):
        return sum(self.families.values())


class Family:
    """Rows compared with one control; closing it applies the Holm correction across the family."""

    def __init__(self, name, margin=0.0, ledger=None):
        self.name, self.margin, self.rows, self.ledger = name, margin, [], ledger

    def add(self, name, a, b, metric, resampler, **extra):
        res = paired_diff(a, b, metric, resampler)
        self.rows.append({"name": name, **extra, **res})
        return self.rows[-1]

    def close(self):
        if not self.rows:
            return self.rows
        adj = holm_adjust([r["p"] if not np.isnan(r["p"]) else 1.0 for r in self.rows])
        for r, pa in zip(self.rows, adj):
            r["p_holm"] = float(pa)
            r["CI"] = f"{r['lo']:.3f} to {r['hi']:.3f}"
            r["verdict"] = verdict(r["lo"], r["hi"], self.margin, pa)
        if self.ledger is not None:
            self.ledger.add_family(self.name, len(self.rows))
        return self.rows


# =============================================================================== gallery recipes
def apply_recipe(gallery, recipe):
    """
    gallery: dict of arrays emb (n,d), student, kind ('self'|'reference'|'cctv'), tag ('photo'|'deg20'|...), shot ('' if none).
    recipe : {"kinds": {...}, "degrade": (20, 28), "exclude_shots": {...}, "students": optional allow-list}
    Returns (embeddings, student names) for the rows the recipe uses.
    """
    kinds = set(recipe.get("kinds", {"self", "reference"}))
    degrade = {f"deg{w}" for w in recipe.get("degrade", ())}
    exclude_shots = set(recipe.get("exclude_shots", ()))
    allow = recipe.get("students")
    keep = np.zeros(len(gallery["student"]), dtype=bool)
    for i, (kind, tag, shot, student) in enumerate(zip(gallery["kind"], gallery["tag"], gallery["shot"], gallery["student"])):
        if kind not in kinds or shot in exclude_shots or (allow is not None and student not in allow):
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
    One pooled embedding per (clip, dense track), built like production: the track's first `n_looks` attempts (every `stride`-th
    AVAILABLE look in time order), the best `top_k` by quality, those not much worse than the best, quality-weighted.
    Returns a looks-like dict with one row per track.
    """
    q = quality_values(looks, quality)
    by_track = defaultdict(list)
    for i in np.argsort(looks["frame"], kind="stable"):
        by_track[(looks["clip"][i], int(looks["track"][i]))].append(i)
    emb, label, clip_out, track_out, used = [], [], [], [], []
    for (clip, track), idx in by_track.items():
        idx = idx[start::stride][:n_looks] or idx[:1]     # a track with too few looks for the stride still keeps its first look
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
    """{track id: number of sampled frames it appears in}."""
    lengths = defaultdict(int)
    for frame in frames:
        for det in frame["dets"]:
            lengths[det["track"]] += 1
    return dict(lengths)


def choose_label_frames(frames, n_verify=2, min_fraction=0.4):
    """(label position, [verify positions]): frame A = most long-lived tracks in the first half; the verify frames are spread over
    the rest of the clip (the later, the more informative about swaps)."""
    lengths = track_lengths(frames)
    long_tracks = {t for t, n in lengths.items() if n >= min_fraction * len(frames)} or set(lengths)
    n = len(frames)

    def best(lo, hi):
        if hi <= lo:
            return lo
        mid = (lo + hi) // 2
        return max(range(lo, hi), key=lambda i: (sum(d["track"] in long_tracks for d in frames[i]["dets"]), -abs(i - mid)))

    first = best(0, max(1, n // 2))
    verify = []
    if n > 1 and n_verify > 0:
        span = list(range(max(first + 1, n // 2), n))
        edges = np.linspace(0, len(span), n_verify + 1).astype(int) if span else []
        for a, b in zip(edges[:-1], edges[1:]):
            if b > a:
                verify.append(span[a] + best(0, 1) * 0 + (best(span[a], span[b - 1] + 1) - span[a]))
    return first, [v for i, v in enumerate(verify) if v not in verify[:i] and v != first]


def apply_first_labels(labels, frame, answers, sources=None, kinds=None):
    """answers: {detection index: label or None(skip)}. Sets labels[track]. A label given to two tracks of one frame is allowed
    (a student can be detected twice) but returned as a note. `kinds` = {detection index: 'typed'|'suggested'} -> sources[track]."""
    notes = []
    for i, answer in answers.items():
        if answer is None:
            continue
        track = frame["dets"][i]["track"]
        labels[track] = answer
        if sources is not None:
            sources[track] = (kinds or {}).get(i, "typed")
    seen = defaultdict(list)
    for i, answer in answers.items():
        if is_student_label(answer):
            seen[answer].append(frame["dets"][i]["track"])
    for student, tracks in seen.items():
        if len(tracks) > 1:
            notes.append(f"{student} was given to tracks {tracks} in the same frame")
    return notes


def apply_verify_labels(labels, frame, answers, verified=None):
    """
    A later look at the clip. A track whose verify label differs from its first label is a swap suspect: it is set to '?'
    (excluded) and reported. A track with no label yet simply gets the new one. `verified` collects tracks confirmed at least once.
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
            if verified is not None:
                verified.add(track)
        else:
            report["swaps"].append({"track": track, "first": first, "verify": answer})
            labels[track] = "?"
    return report


def student_labels(labels):
    return {t: l for t, l in labels.items() if is_student_label(l)}


def impostor_labels(labels):
    return {t: l for t, l in labels.items() if l in IMPOSTOR}


def label_agreement(first, second):
    """(agreement, cohen's kappa, n) between two label dicts over the tracks both labelled."""
    common = [t for t in first if t in second and first[t] not in (None, "") and second[t] not in (None, "")]
    if not common:
        return float("nan"), float("nan"), 0
    a = [str(first[t]) for t in common]
    b = [str(second[t]) for t in common]
    po = float(np.mean([x == y for x, y in zip(a, b)]))
    cats = set(a) | set(b)
    pe = sum((a.count(c) / len(a)) * (b.count(c) / len(b)) for c in cats)
    kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0
    return po, float(kappa), len(common)


def outlier_looks(looks, z=3.5, min_looks=5, floor=0.15):
    """
    Boolean mask of looks that do not look like the rest of their (clip, dense track): cosine to the track's median direction far
    below the track's own typical value. A track that swapped students halfway shows up here. Needs no labels.
    """
    mask = np.zeros(len(looks["track"]), bool)
    groups = defaultdict(list)
    for i, key in enumerate(unit_keys(looks["clip"], looks["track"])):
        groups[key].append(i)
    for idx in groups.values():
        if len(idx) < min_looks:
            continue
        e = looks["emb"][idx]
        centre = np.median(e, axis=0)
        centre = centre / max(float(np.linalg.norm(centre)), 1e-9)
        cos = e @ centre
        med = float(np.median(cos))
        mad = float(np.median(np.abs(cos - med))) * 1.4826
        cutoff = med - max(z * mad, floor)
        mask[np.array(idx)[cos < cutoff]] = True
    return mask


# =============================================================================== frames, windows and replay
def clip_frames(looks, positions=None):
    """{clip: [(frame position, [look dict])]} in time order. Every embedded face is a look (students, 'x', 'n', unlabelled)."""
    out = defaultdict(lambda: defaultdict(list))
    for i in range(len(looks["track"])):
        out[looks["clip"][i]][int(looks["frame"][i])].append({
            "dense": int(looks["track"][i]), "emb": looks["emb"][i], "norm": float(looks["norm"][i]), "sharp": float(looks["sharp"][i]),
            "width": float(looks["width"][i]), "height": float(looks["height"][i]), "det": float(looks["det"][i]),
            "bbox": [float(v) for v in looks["bbox"][i]], "label": looks["label"][i]})
    return {clip: [(pos, frames[pos]) for pos in sorted(frames)] for clip, frames in out.items()}


def settings_namespace(**overrides):
    """The decision settings (matching.decide_attempt / gate_track read these): production defaults + overrides."""
    base = dict(threshold=0.26, accept_threshold=0.28, max_attempts=10, min_face=0, min_sharpness=0.0, min_norm=0.0,
                pool_attempts=True, pool_top_k=5, aggregator="max", margin=0.0, pool_gate=0.0, trace=False)
    unknown = set(overrides) - set(base)
    if unknown:
        raise ValueError(f"unknown decision settings: {sorted(unknown)}")
    base.update(overrides)
    return SimpleNamespace(**base)


def scan_windows(n_frames, window_frames, hop_frames):
    """[(start, stop)] over n_frames sampled frames; always at least one window, never a window longer than the clip."""
    window_frames = max(1, min(window_frames, n_frames))
    last = max(0, n_frames - window_frames)
    starts = list(range(0, last + 1, max(1, hop_frames)))
    if starts[-1] != last and last - starts[-1] >= max(1, hop_frames) // 2:
        starts.append(last)
    return [(s, s + window_frames) for s in starts]


def judge(look_label, student):
    """Outcome of naming `student` on a look whose true label is look_label."""
    if look_label == student:
        return "correct"
    if is_student_label(look_label):
        return "wrong"
    if look_label in IMPOSTOR:
        return "false_accept"
    return "unverified"


def replay_window(frames, gallery, identity_map, args, tracker_params, det_thresh=0.3, adjudications=None, clip=""):
    """
    One simulated scan over `frames` ([(pos, [look])], already at production cadence): the tracker is RE-RUN here, faces below
    det_thresh are ignored, and the production decision code (matching.decide_attempt) decides. Events are judged by the true label of
    the look that triggered them. Returns a dict of counts plus per-student funnel flags.
    """
    adjudications = adjudications or {}
    state = RunState()
    tracker = Tracker(**tracker_params)
    args = SimpleNamespace(**{**vars(args), "trace": True})
    seen_dense = defaultdict(set)          # student -> coarse tracks that held a look of them
    sightings = defaultdict(int)
    present_truth, detected = set(), set()
    events = []
    by_pos = {}
    for n, (pos, looks) in enumerate(frames):
        looks = [lk for lk in looks if lk["det"] >= det_thresh]
        for lk in looks:
            if is_student_label(lk["label"]):
                present_truth.add(lk["label"])
                detected.add(lk["label"])
        ids = tracker.update([lk["bbox"] for lk in looks])
        state.frames_processed += 1
        state.frame_faces = {}
        pending = []
        for tid, lk in zip(ids, looks):
            by_pos[(tid, pos)] = lk
            state.track_sightings[tid] = state.track_sightings.get(tid, 0) + 1
            state.track_last_seen[tid] = state.frames_processed
            if is_student_label(lk["label"]):
                seen_dense[lk["label"]].add(tid)
                sightings[tid] += 1
            info = {"status": "queued", "score": None, "quality": None}
            state.frame_faces[tid] = info
            if gate_track(state, tid, info, args, big_enough=lambda lk=lk: min(lk["width"], lk["height"]) >= args.min_face,
                          sharp_enough=lambda lk=lk: lk["sharp"] >= args.min_sharpness):
                pending.append((tid, lk))
        for tid, lk in pending:
            face = SimpleNamespace(normed_embedding=lk["emb"], quality=lk["norm"], aligned_bgr=None)
            record = decide_attempt(state, tid, face, gallery, identity_map, args, pos)
            if record is not None:
                events.append({"student": record["student_id"], "track": tid, "pos": pos, "attempt": record["attempt"],
                               "score": record["best_score"], "look": lk})
    out = {"present": set(present_truth), "correct": set(), "wrong": [], "false_accept": [], "unverified": [], "first_attempt": [],
           "frames": len(frames)}
    for e in events:
        outcome = judge(e["look"]["label"], e["student"])
        if outcome == "unverified":
            verdict_ = adjudications.get((clip, e["look"]["dense"], e["student"]))
            outcome = "correct" if verdict_ is True else "false_accept" if verdict_ is False else "unverified"
            if outcome == "correct":
                out["present"].add(e["student"])
        if outcome == "correct":
            out["correct"].add(e["student"])
            out["first_attempt"].append(e["attempt"])
        else:
            out[outcome].append({k: e[k] for k in ("student", "track", "pos", "score")} | {"label": e["look"]["label"], "dense": e["look"]["dense"],
                                                                                    "bbox": e["look"]["bbox"]})
    # funnel per present student: detected -> tracked (>= 2 sightings of a coarse track) -> above floor -> correct
    attempts = defaultdict(set)
    for entry in state.attempt_log:
        look = by_pos.get((entry["track"], entry["frame"]))
        if look is not None and is_student_label(look["label"]) and entry["name"] == look["label"] \
                and entry["score"] is not None and entry["score"] >= args.threshold:
            attempts[look["label"]].add(entry["track"])
    out["funnel"] = {s: {"detected": s in detected,
                         "tracked": any(sightings[t] >= 2 for t in seen_dense.get(s, ())),
                         "above_floor": s in attempts, "correct": s in out["correct"]} for s in out["present"]}
    return out


def replay_clip_windows(frames, gallery, identity_map, args, tracker_params, window_frames, hop_frames, det_thresh=0.3,
                        adjudications=None, clip=""):
    """Total of replay_window over every scan window of one clip."""
    tot = {"present": 0, "correct": 0, "wrong": 0, "false_accept": 0, "unverified": 0, "windows": 0, "first_attempt": [],
           "funnel": {"visible": 0, "detected": 0, "tracked": 0, "above_floor": 0, "correct": 0}, "scans_with_error": 0}
    for lo, hi in scan_windows(len(frames), window_frames, hop_frames):
        res = replay_window(frames[lo:hi], gallery, identity_map, args, tracker_params, det_thresh, adjudications, clip)
        tot["windows"] += 1
        tot["present"] += len(res["present"])
        tot["correct"] += len(res["correct"])
        tot["wrong"] += len(res["wrong"])
        tot["false_accept"] += len(res["false_accept"])
        tot["unverified"] += len(res["unverified"])
        tot["scans_with_error"] += int(bool(res["wrong"] or res["false_accept"]))
        tot["first_attempt"] += res["first_attempt"]
        for flags in res["funnel"].values():
            tot["funnel"]["visible"] += 1
            for stage in ("detected", "tracked", "above_floor", "correct"):
                tot["funnel"][stage] += int(flags[stage])
    return tot


def add_totals(parts):
    """Sum a list of replay_clip_windows results."""
    tot = {"present": 0, "correct": 0, "wrong": 0, "false_accept": 0, "unverified": 0, "windows": 0, "first_attempt": [], "scans_with_error": 0,
           "funnel": {"visible": 0, "detected": 0, "tracked": 0, "above_floor": 0, "correct": 0}}
    for p in parts:
        for k in ("present", "correct", "wrong", "false_accept", "unverified", "windows", "scans_with_error"):
            tot[k] += p[k]
        tot["first_attempt"] += p["first_attempt"]
        for k in tot["funnel"]:
            tot["funnel"][k] += p["funnel"][k]
    tot["recall"] = tot["correct"] / tot["present"] if tot["present"] else float("nan")
    tot["bad"] = tot["wrong"] + tot["false_accept"]
    tot["bad_per_scan"] = tot["bad"] / tot["windows"] if tot["windows"] else float("nan")
    tot["error_scan_rate"] = tot["scans_with_error"] / tot["windows"] if tot["windows"] else float("nan")
    tot["median_attempt"] = float(np.median(tot["first_attempt"])) if tot["first_attempt"] else float("nan")
    return tot


def poisson_upper(k, confidence=0.95):
    """One-sided upper confidence bound for a Poisson count k (k=0 -> about 3)."""
    lo, hi = float(k), float(k) + 20 + 4 * math.sqrt(k + 1)
    for _ in range(80):
        mid = (lo + hi) / 2
        cdf = sum(math.exp(-mid) * mid ** j / math.factorial(j) for j in range(int(k) + 1))
        lo, hi = (mid, hi) if cdf > 1 - confidence else (lo, mid)
    return (lo + hi) / 2


def decision_grid(base, thresholds, accepts_above, margins):
    """The coordinated (threshold x accept x margin) grid around `base`; accept = threshold + offset (0 offset = off)."""
    rows = []
    for t in thresholds:
        for a in accepts_above:
            for m in margins:
                rows.append({**base, "threshold": round(float(t), 4), "accept_threshold": 0.0 if a == 0 else round(float(t + a), 4), "margin": float(m)})
    return rows


def pick_operating_point(totals_by_row, rows, max_bad_per_scan=0.02, tolerance=0.005):
    """
    totals_by_row: list (aligned with rows) of add_totals() results over the TRAINING clips. Among rows whose wrong+false-accept count
    per scan is <= the budget, keep those whose recall is within `tolerance` of the best and with the fewest unverified guesses, then
    take the middle of that plateau by threshold, nudged to the SAFER (higher) side. Returns (index, info) or (None, info) when no
    row fits the budget (info says which row came closest).
    """
    ok = [i for i, t in enumerate(totals_by_row) if t["bad_per_scan"] <= max_bad_per_scan and not np.isnan(t["recall"])]
    if not ok:
        valid = [i for i, t in enumerate(totals_by_row) if not np.isnan(t["bad_per_scan"])]
        closest = min(valid, key=lambda i: (totals_by_row[i]["bad_per_scan"], -totals_by_row[i]["recall"])) if valid else None
        return None, {"closest": closest}
    best = max(totals_by_row[i]["recall"] for i in ok)
    top = [i for i in ok if totals_by_row[i]["recall"] >= best - tolerance]
    fewest = min(totals_by_row[i]["unverified"] for i in top)
    top = sorted((i for i in top if totals_by_row[i]["unverified"] == fewest),
                 key=lambda i: (rows[i].get("threshold", 0), rows[i].get("accept_threshold", 0), rows[i].get("margin", 0)))
    chosen = top[min(len(top) - 1, (len(top) + 1) // 2)]
    return chosen, {"plateau": (rows[top[0]].get("threshold"), rows[top[-1]].get("threshold"), len(top))}


def loco_selection(per_clip_totals, rows, clips, max_bad_per_scan=0.02):
    """
    Leave-one-clip-out. per_clip_totals[row index][clip] = replay_clip_windows result. For each held-out clip, pick the operating
    point on the OTHER clips and score it on the held-out one. Returns {"held_out": add_totals over the held-out scores,
    "choices": [(clip, row index or None)], "overall": row index chosen on ALL clips}.
    """
    parts, choices = [], []
    for held in clips:
        train = [c for c in clips if c != held]
        if not train:
            continue
        totals = [add_totals([per_clip_totals[i][c] for c in train]) for i in range(len(rows))]
        pick, _ = pick_operating_point(totals, rows, max_bad_per_scan)
        choices.append((held, pick))
        if pick is not None:
            parts.append(per_clip_totals[pick][held])
    overall_totals = [add_totals([per_clip_totals[i][c] for c in clips]) for i in range(len(rows))]
    overall, info = pick_operating_point(overall_totals, rows, max_bad_per_scan)
    return {"held_out": add_totals(parts) if parts else None, "choices": choices, "overall": overall, "overall_info": info,
            "overall_totals": overall_totals}


# =============================================================================== gallery size
def threshold_vs_gallery_size(impostor_emb, gallery_emb, names, sizes, far=0.01, repeats=20, seed=0, aggregator="max"):
    """
    How the open-set threshold at `far` rises as the roster grows: for each size N, draw N students (repeats times), score every
    impostor face against only them, take the threshold where `far` of the faces reach it. Returns [{size, mean, sd}].
    """
    unique, scores = per_student_scores(np.asarray(impostor_emb, np.float32), gallery_emb, names, aggregator)
    rng = np.random.default_rng(seed)
    out = []
    for size in sizes:
        size = min(size, len(unique))
        thr = []
        for _ in range(repeats):
            cols = rng.choice(len(unique), size=size, replace=False)
            best = scores[:, cols].max(axis=1)
            thr.append(float(np.quantile(best, 1 - far)) if len(best) else float("nan"))
        out.append({"size": size, "mean": float(np.nanmean(thr)), "sd": float(np.nanstd(thr))})
    return out


# =============================================================================== tracker evaluation (production cadence, all frames)
def tracker_eval(frames, window_frames, hop_frames, **params):
    """
    Re-track stored detections ([(pos, [look])] of one clip, already at production cadence) with other tracker settings, scan window by
    scan window, and judge against the per-look labels: `merged` = coarse ids that covered two different labelled people, `fragments` =
    extra ids a student received (ids - 1, per student per window), `students` = student-windows seen.
    """
    merged = fragments = students = tracks = 0
    for lo, hi in scan_windows(len(frames), window_frames, hop_frames):
        tracker = Tracker(**params)
        by_id, by_student = defaultdict(set), defaultdict(set)
        for pos, looks in frames[lo:hi]:
            ids = tracker.update([lk["bbox"] for lk in looks])
            for tid, lk in zip(ids, looks):
                if is_student_label(lk["label"]) or lk["label"] in IMPOSTOR:
                    by_id[tid].add(lk["label"] if is_student_label(lk["label"]) else f"#{lk['dense']}")
                if is_student_label(lk["label"]):
                    by_student[lk["label"]].add(tid)
        merged += sum(len(v) > 1 for v in by_id.values())
        fragments += sum(len(v) - 1 for v in by_student.values())
        students += len(by_student)
        tracks += len(by_id)
    return {"students": students, "merged_ids": merged, "fragments": fragments, "tracks": tracks}


# =============================================================================== detector evaluation
def width_bin(width, edges=(20, 30, 50, 80)):
    for i, edge in enumerate(edges):
        if width < edge:
            return f"<{edge}px" if i == 0 else f"{edges[i - 1]}-{edge}px"
    return f"{edges[-1]}+px"


def zone_of(bbox, image_height):
    """front / middle / back by the face's vertical position in a raised classroom camera (back rows are higher up the frame)."""
    cy = (bbox[1] + bbox[3]) / 2 / max(image_height, 1)
    return "back" if cy < 0.33 else "middle" if cy < 0.66 else "front"


def detection_recall(reference, detections, iou_threshold=0.3, image_height=1080):
    """
    reference: [[bbox,...] per frame] ground-truth boxes (labelled detections AND hand-added boxes); detections: the same for one
    detector setting. Returns recall overall, by width and by zone, and extra boxes per frame.
    """
    found = total = extra = 0
    by_bin, by_zone = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    for ref_boxes, det_boxes in zip(reference, detections):
        used = set()
        for box in ref_boxes:
            total += 1
            b, z = width_bin(box[2] - box[0]), zone_of(box, image_height)
            by_bin[b][1] += 1
            by_zone[z][1] += 1
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
                by_zone[z][0] += 1
                used.add(best_i)
        extra += len(det_boxes) - len(used)
    frames = max(1, len(reference))
    return {"recall": found / total if total else float("nan"), "by_width": {k: tuple(v) for k, v in sorted(by_bin.items())},
            "by_zone": {k: tuple(v) for k, v in sorted(by_zone.items())}, "extra_per_frame": extra / frames}


# =============================================================================== self-tests (known answers)
def selftest_report(seed=0, quick=False):
    """
    Known-answer checks of the metric / bootstrap code. Returns [(name, passed, detail)]. If any FAILS, do not trust the reports.
    """
    rng = np.random.default_rng(seed)
    results = []

    def synth(n_students=24, n_clips=3, looks=6, shift=0.0, sep=0.35):
        rows = []
        for c in range(n_clips):
            for s in range(n_students):
                for k in range(looks):
                    g = rng.normal(sep + shift, 0.1)
                    h = rng.normal(0.0, 0.1)
                    rows.append((f"c{c}", f"s{s}", c * 1000 + s, g, h))
        clip = np.array([r[0] for r in rows], dtype=object)
        student = np.array([r[1] for r in rows], dtype=object)
        track = np.array([r[2] for r in rows])
        g = np.array([r[3] for r in rows])
        h = np.array([r[4] for r in rows])
        ho = rng.normal(0.0, 0.1, 400)
        return clip, student, track, g, h, ho

    def ss_from(clip, student, track, g, h, ho):
        units = unit_keys(clip, track)
        wg = balance_weights(units)
        o_clip = np.array([f"c{i % 3}" for i in range(len(ho))], dtype=object)
        o_unit = np.array([f"o|{i // 4}" for i in range(len(ho))], dtype=object)
        return ScoreSet(g, h, clip, student, wg, ho, o_clip, o_unit, balance_weights(o_unit))

    clip, student, track, g, h, ho = synth()
    a = ss_from(clip, student, track, g, h, ho)
    # 1. AUC of a known separation: P(N(.35,.1) > N(0,.1)) = Phi(.35/.1414) ~ 0.993
    auc = METRICS["auc"](a, a.w_g, a.w_o)
    results.append(("AUC matches the known value (~0.993)", abs(auc - 0.993) < 0.01, f"{auc:.4f}"))
    # 2. shuffled labels: pair genuine scores with random h -> AUC ~ 0.5 when g and h are exchangeable
    pool = np.concatenate([g, h])[rng.permutation(2 * len(g))]
    shuffled = ScoreSet(pool[:len(g)], pool[len(g):], clip, student, a.w_g, ho, a.clip_o, a.unit_o, a.w_o)
    auc_s = METRICS["auc"](shuffled, shuffled.w_g, shuffled.w_o)
    results.append(("shuffled labels collapse to chance (AUC ~ 0.5)", abs(auc_s - 0.5) < 0.05, f"{auc_s:.3f}"))
    # 3. an exact toy: DIR@FAR must equal the hand count
    toy = ScoreSet([0.9, 0.8, 0.3, 0.7], [0.1, 0.2, 0.4, 0.1], ["c"] * 4, list("abcd"), np.ones(4), [0.5, 0.2, 0.25, 0.1], ["c"] * 4,
                   ["u1", "u2", "u3", "u4"], np.ones(4))
    toy_dir = _open_dir(0.25)(toy, toy.w_g, toy.w_o)      # at most 1 of 4 impostors may be accepted: T just above 0.25 -> 3 of 4 correct
    results.append(("open DIR@FAR equals the hand count (0.75)", abs(toy_dir - 0.75) < 1e-9, f"{toy_dir:.3f}"))
    # 4. a set compared with itself: difference 0, interval contains 0, verdict equivalent
    rs = Resampler(a, 200 if quick else 400, seed=1)
    same = paired_diff(a, a, "auc", rs)
    results.append(("a model compared with itself: diff = 0 and 'equivalent'",
                    same["diff"] == 0 and same["lo"] <= 0 <= same["hi"] and verdict(same["lo"], same["hi"], 0.01) == "equivalent", f"{same}"))
    # 5. a planted improvement is detected; a planted null is not (rarely)
    better = ss_from(clip, student, track, g + 0.06, h, ho)
    d = paired_diff(better, a, "auc", rs)
    results.append(("a planted improvement is found (diff > 0, lo > 0)", d["diff"] > 0 and d["lo"] > 0, f"diff {d['diff']:.4f} CI {d['lo']:.4f}..{d['hi']:.4f}"))
    # 6. Holm: adjusted >= raw, monotone in the sort order, capped at 1
    adj = holm_adjust([0.01, 0.04, 0.03, 0.5])
    results.append(("Holm adjustment is correct", np.allclose(adj, [0.04, 0.09, 0.09, 0.5]), f"{np.round(adj, 3)}"))
    # 7. planted leak: a probe in the gallery scores 1 against itself
    probe = rng.normal(size=(1, 16)).astype(np.float32)
    probe /= np.linalg.norm(probe)
    gi = genuine_impostor(probe, ["s0"], np.vstack([probe, -probe]), ["s0", "s1"])
    results.append(("planted leak: probe vs gallery copy scores 1.0", abs(float(gi["g"][0]) - 1.0) < 1e-5, f"{float(gi['g'][0]):.4f}"))
    # 8. bootstrap coverage with REAL student and clip effects: a 95% interval for the AUC must contain the population value
    #    (genuine ~ N(.35 + student effect + clip effect, .1), impostor ~ N(0, .1)  ->  truth = Phi(.35 / sqrt(.0145 + .01)))
    truth_auc = 0.5 * (1 + math.erf((0.35 / math.sqrt(0.0145 + 0.01)) / math.sqrt(2)))
    reps = 25 if quick else 80
    hit = 0
    for r in range(reps):
        n_s, n_c, per = 14, 3, 4
        clip_eff = rng.normal(0, 0.03, n_c)
        stud_eff = rng.normal(0, 0.06, n_s)
        rows_c, rows_s, rows_t, rows_g, rows_h = [], [], [], [], []
        for c in range(n_c):
            for s in range(n_s):
                for k in range(per):
                    rows_c.append(f"c{c}"); rows_s.append(f"s{s}"); rows_t.append(c * 1000 + s)
                    rows_g.append(0.35 + stud_eff[s] + clip_eff[c] + rng.normal(0, 0.1)); rows_h.append(rng.normal(0, 0.1))
        base = ss_from(np.array(rows_c, dtype=object), np.array(rows_s, dtype=object), np.array(rows_t), np.array(rows_g), np.array(rows_h), ho)
        lo, hi = bootstrap_ci(base, "auc", Resampler(base, 200, seed=r))
        hit += lo <= truth_auc <= hi
    results.append(("95% bootstrap interval covers the population AUC (>= 80%; ~90% expected with few students)", hit / reps >= 0.80, f"{hit}/{reps} = {hit / reps:.0%}"))
    # 9. the poisson bound of 0 events is about 3
    pu = poisson_upper(0)
    results.append(("Poisson upper bound for 0 events ~ 3", abs(pu - 3.0) < 0.1, f"{pu:.2f}"))
    return results


# =============================================================================== reporting helpers
def fmt(value, digits=3):
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "-"
    if isinstance(value, (bool, np.bool_)):
        return str(bool(value))
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