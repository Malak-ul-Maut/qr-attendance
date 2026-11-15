"""
matching.py - small, model-free helpers for recognising a face from SEVERAL looks at it.

Kept apart from recognize.py (which needs insightface + onnxruntime to even import) so this file can be
read, tested and tuned on its own. Only numpy is needed.

Why pool? A back-row face is ~18 px wide, so one frame's embedding is noisy: a blink, a compression block or a
half-turned head can push a genuine match below the threshold. Looking at the SAME face in several frames and
averaging their embeddings (weighted by how good each look was) cancels much of that noise. AdaFace gives a free
quality number for every crop (the length of its feature vector, "norm"); we use it as the weight.
"""
import numpy as np


class TrackPool:
    """The best few looks at ONE tracked face, and their combined (pooled) embedding."""

    def __init__(self, top_k=5, keep_fraction=0.6):
        self.top_k = top_k                  # only the best this-many looks are averaged
        self.keep_fraction = keep_fraction  # a look worse than this share of the best one is ignored
        self.total_added = 0                # every look ever added, including ones that were not kept
        self._items = []                    # [(quality, unit embedding, aligned 112x112 crop or None)], best first

    @property
    def count(self):
        return self.total_added

    def add(self, embedding, quality, aligned=None):
        """Remember one look at the face. `embedding` must be unit length."""
        self.total_added += 1
        self._items.append((float(quality), np.asarray(embedding, dtype=np.float32), aligned))
        self._items.sort(key=lambda item: item[0], reverse=True)   # best quality first
        del self._items[self.top_k:]                               # worse looks are never used again

    def _used(self):
        """The looks that take part in the average: the best few that are not much worse than the best one."""
        if not self._items:
            return []
        best_quality = self._items[0][0]
        if best_quality <= 0:               # no usable quality numbers: treat every look equally
            return list(self._items)
        return [item for item in self._items if item[0] >= self.keep_fraction * best_quality]

    def pooled(self):
        """One unit-length embedding for the face, or None when nothing was added."""
        used = self._used()
        if not used:
            return None
        weights = np.array([max(quality, 1e-6) if used[0][0] > 0 else 1.0 for quality, _, _ in used], dtype=np.float32)
        total = sum(weight * embedding for weight, (_, embedding, _) in zip(weights, used))
        length = float(np.linalg.norm(total))
        if length < 1e-9:
            return used[0][1]
        return (total / length).astype(np.float32)

    def best_aligned(self):
        """The aligned crop of the best look that has one (what the recognizer actually saw), or None."""
        for _, _, aligned in self._items:
            if aligned is not None:
                return aligned
        return None

    def sharpest_aligned(self, measure):
        """(crop, sharpness) of the kept look whose aligned crop `measure` rates sharpest, or (None, None)."""
        best = (None, None)
        for _, _, aligned in self._items:
            if aligned is None:
                continue
            value = measure(aligned)
            if best[1] is None or value > best[1]:
                best = (aligned, value)
        return best

    def best_quality(self):
        return self._items[0][0] if self._items else None


def rank_candidates(embedding, gallery_embeddings, gallery_names, identity_map, exclude_student_ids=(),
                    top_n=3, min_score=0.12):
    """
    The students this embedding looks most like, best first - used to suggest "who is this?" for a face the
    scan could not name. Each student scores as their BEST gallery photo. Students in `exclude_student_ids`
    (already marked present) are left out, because the point is to find who among the rest it might be.
    Returns [{"student_id", "name", "score"}, ...].
    """
    scores = np.asarray(gallery_embeddings) @ np.asarray(embedding)   # unit vectors: dot product = cosine
    best_by_folder = {}
    for folder, score in zip(gallery_names, scores):
        if folder not in best_by_folder or score > best_by_folder[folder]:
            best_by_folder[folder] = float(score)
    ranked = []
    for folder, score in best_by_folder.items():
        identity = identity_map.get(folder)
        if identity is None or identity["student_id"] in exclude_student_ids or score < min_score:
            continue
        ranked.append({"student_id": identity["student_id"], "name": identity.get("name"), "score": round(score, 4)})
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return ranked[:top_n]


def choose_faces_to_report(track_boxes, track_identity, track_best_scores, track_sightings, track_last_seen,
                           frames_processed, min_sightings=2, amber_recent_frames=2, recent_frames=0, duplicate_test=None):
    """
    Decides which tracks appear in the final picture and in the review list, so the two always agree.
    Returns (drawn, best_track_by_student): `drawn` is [(track_id, box)] in drawing priority order (a student's
    best track first, then other claims on a student, then unresolved faces biggest first); a face overlapping an
    already-kept one is dropped. This is the selection save_aggregate_annotation used to do inline.
    """
    best_track_by_student = {}
    for track_id, student_id in track_identity.items():
        if student_id is None or track_id not in track_boxes:
            continue
        box = track_boxes[track_id]
        area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
        # a track that is still alive beats a dead one (a student who moved leaves a stale old track behind);
        # among live tracks the higher score wins
        alive = (track_last_seen is None
                 or track_last_seen.get(track_id, 0) > frames_processed - amber_recent_frames)
        rank = (alive, track_best_scores.get(track_id, float("-inf")), area)
        if student_id not in best_track_by_student or rank > best_track_by_student[student_id][0]:
            best_track_by_student[student_id] = (rank, track_id)

    candidates = []
    for track_id, box in track_boxes.items():
        student_id = track_identity.get(track_id)
        if student_id is not None:
            if best_track_by_student[student_id][1] == track_id:
                priority = 0
            else:  # 1 = a second claim on the same student; only worth showing while that track is alive
                if track_last_seen is not None and track_last_seen.get(track_id, 0) <= frames_processed - amber_recent_frames:
                    continue
                priority = 1
        else:
            if track_sightings is not None and track_sightings.get(track_id, 0) < min_sightings:
                continue
            if (recent_frames > 0 and track_last_seen is not None
                    and track_last_seen.get(track_id, 0) <= frames_processed - recent_frames):
                continue
            priority = 2
        area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
        candidates.append((priority, -area, track_id, box))
    candidates.sort(key=lambda c: (c[0], c[1]))

    drawn = []
    for priority, _, track_id, box in candidates:
        if duplicate_test and any(duplicate_test(box, kept_box) for _, kept_box in drawn):
            continue
        drawn.append((track_id, box))
    return drawn, best_track_by_student


# ======================================================================================================
# The per-attempt decision logic. It used to live inline in recognize.process_frame; it is here so that
# scripts/bakeoff.py replays EXACTLY the code production runs (numpy only, no insightface needed).
# ======================================================================================================
CLAIM_MARGIN = 0.03   # a borderline match loses to a live track already holding the same student if that track scored this much higher


class RunState:
    """Everything that changes while one clip is being scanned."""

    def __init__(self):
        self.present = {}            # student_id -> record of the match that marked them present
        self.attempts_used = {}      # track_id -> recognition attempts spent so far
        self.track_identity = {}     # track_id -> student_id, or None once given up on
        self.track_boxes = {}        # track_id -> last known bbox (for the final annotated image)
        self.track_best_scores = {}  # track_id -> best trusted similarity so far
        self.recognitions = 0        # total face recognitions run (for the timing summary)
        self.frames_processed = 0    # processed frames so far (the clock for track_last_seen)
        self.track_sightings = {}    # track_id -> number of processed frames it was detected in
        self.track_last_seen = {}    # track_id -> frames_processed value at its latest sighting
        self.track_votes = {}        # track_id -> {student_id: borderline attempts that named that student}
        self.frame_faces = {}        # track_id -> what happened to that face on the frame just processed (for snapshots)
        self.track_pools = {}        # track_id -> TrackPool: the best looks at that face (for pooled matching + saved crops)
        self.track_thumbs = {}       # track_id -> (det score, small BGR picture of the face with some margin)
        self.track_widths = {}       # track_id -> latest face width in pixels
        self.track_attempt_frames = {}  # track_id -> [processed-frame number of each recognition attempt] (for window_study.py)
        self.frame_stats = []        # one dict per processed frame: faces, recognitions, detect/recognize ms, new matches
        self.attempt_log = []        # one dict per recognition attempt, filled only when settings.trace is on


def stronger_live_claim(state, track_id, student_id, score):
    """
    Track id of another LIVE track (seen this frame or the one before) that already holds
    `student_id` with a clearly higher score than `score`, else None. Dead tracks are ignored on
    purpose: a student who leaned and got a new track id must not be rejected by their own old track.
    """
    for other_id, other_student in state.track_identity.items():
        if other_student != student_id or other_id == track_id:
            continue
        if state.track_last_seen.get(other_id, 0) < state.frames_processed - 1:
            continue
        if state.track_best_scores.get(other_id, float("-inf")) >= score + CLAIM_MARGIN:
            return other_id
    return None


def nearest_gallery_match(embedding, gallery_embeddings, gallery_names):
    """
    The single closest gallery photo to this embedding, and its similarity score. This already
    finds the best-matching STUDENT too, not just the best photo: whichever photo scores highest
    across the searched gallery is, by definition, that student's own best photo.
    """
    scores = gallery_embeddings @ embedding  # both are unit-length, so this is cosine similarity
    best = int(np.argmax(scores))
    return gallery_names[best], float(scores[best])


_GROUP_CACHE = {}


def _student_groups(gallery_names):
    """(names, order, starts): gallery rows regrouped per student, for per-student aggregation. Cached by content."""
    key = (len(gallery_names), hash(tuple(gallery_names)))
    cached = _GROUP_CACHE.get(key)
    if cached is None:
        names = list(dict.fromkeys(gallery_names))
        index = {name: i for i, name in enumerate(names)}
        ids = np.array([index[name] for name in gallery_names])
        order = np.argsort(ids, kind="stable")
        starts = np.searchsorted(ids[order], np.arange(len(names)))
        if len(_GROUP_CACHE) > 8:
            _GROUP_CACHE.clear()
        cached = _GROUP_CACHE[key] = (names, order, starts)
    return cached


def student_scores(embedding, gallery_embeddings, gallery_names, aggregator="max"):
    """
    One score per student (list of names, array of scores). aggregator:
      max    the student's single best photo (what nearest_gallery_match does)
      mean2  the average of the student's two best photos (mean3: three) - one lucky photo counts for less
    """
    names, order, starts = _student_groups(gallery_names)
    scores = (gallery_embeddings @ embedding)[order]
    if aggregator == "max":
        return names, np.maximum.reduceat(scores, starts)
    if aggregator in ("mean2", "mean3"):
        k = int(aggregator[-1])
        ends = list(starts[1:]) + [len(scores)]
        return names, np.array([np.sort(scores[a:b])[::-1][:k].mean() for a, b in zip(starts, ends)])
    raise ValueError(f"unknown aggregator '{aggregator}' (max, mean2, mean3)")


def rank_students(embedding, gallery_embeddings, gallery_names, aggregator="max"):
    """(best student's gallery name, their score, best score among all OTHER students or None if there is no other)."""
    names, per_student = student_scores(embedding, gallery_embeddings, gallery_names, aggregator)
    best = int(np.argmax(per_student))
    if len(per_student) < 2:
        return names[best], float(per_student[best]), None
    second = float(np.max(np.delete(per_student, best)))
    return names[best], float(per_student[best]), second


def gate_track(state, track_id, info, args, big_enough, sharp_enough):
    """
    Step 1 of process_frame for one detected face: does this track get a recognition attempt on this frame?
    `big_enough` / `sharp_enough` are callables (the sharpness test is not free, so it only runs when needed).
    Updates state.track_identity / info["status"] exactly as the inline code did.
    """
    if track_id in state.track_identity:
        info["status"] = "resolved" if state.track_identity[track_id] is not None else "gave up"
        return False   # already resolved (matched, or gave up) - nothing left to do for this track
    if state.attempts_used.get(track_id, 0) >= args.max_attempts:
        state.track_identity[track_id] = None   # give up on this track for good
        info["status"] = "gave up"
        return False
    if not big_enough():
        info["status"] = "skipped: small"
        return False   # too small to bother with - free, does not use up an attempt
    if not sharp_enough():
        info["status"] = "skipped: blurry"
        return False   # too blurry - also free
    return True


def decide_attempt(state, track_id, face, gallery, identity_map, args, frame_index):
    """
    Step 3 of process_frame for ONE recognised face: spend an attempt, update the track's pool, compare with the
    gallery and decide whether this marks a student present. Mutates `state` and `state.frame_faces[track_id]`.
    Returns the new presence record when a student was newly marked present, else None.
    `face` needs: normed_embedding, quality, and optionally aligned_bgr.

    Optional settings (all off by default, so behaviour is unchanged until measured):
      aggregator  'max' | 'mean2' | 'mean3'  how a student's several gallery photos become one score
      margin      0 = off; else the best student must beat the best OTHER student by at least this much
      pool_gate   0 = off; else a look whose similarity to the track's pooled looks is below this starts a fresh
                  pool (another person probably took over the track), so two seatmates are never averaged together
      trace       True = append one dict per attempt to state.attempt_log
    """
    gallery_embeddings, gallery_names = gallery
    aggregator = getattr(args, "aggregator", "max")
    margin = float(getattr(args, "margin", 0.0) or 0.0)
    pool_gate = float(getattr(args, "pool_gate", 0.0) or 0.0)

    def match(vector):
        if aggregator == "max" and margin <= 0:
            name_, score_ = nearest_gallery_match(vector, gallery_embeddings, gallery_names)
            return name_, score_, None
        return rank_students(vector, gallery_embeddings, gallery_names, aggregator)

    attempts = state.attempts_used.get(track_id, 0) + 1
    state.attempts_used[track_id] = attempts
    state.track_attempt_frames.setdefault(track_id, []).append(state.frames_processed)
    matched = False
    record = None
    info = state.frame_faces[track_id]
    info["status"] = "tried (no match)"
    info["quality"] = float(face.quality)

    pool = state.track_pools.setdefault(track_id, TrackPool(top_k=args.pool_top_k))
    if pool_gate > 0 and pool.count >= 2:
        earlier = pool.pooled()
        if earlier is not None and float(earlier @ face.normed_embedding) < pool_gate:
            state.track_pools[track_id] = pool = TrackPool(top_k=args.pool_top_k)
            state.track_votes.pop(track_id, None)
            info["split"] = True
    pool.add(face.normed_embedding, face.quality, getattr(face, "aligned_bgr", None))
    name, score, second = None, None, None
    if face.quality >= args.min_norm:  # a low-norm crop is not trusted (its attempt still counted)
        name, score, second = match(face.normed_embedding)
        single_look_score = score
        if args.pool_attempts and pool.count >= 2:
            # Several looks at the same face: average the best of them. A genuine match that one noisy
            # frame scored too low often clears the bar when the noise is averaged out.
            pooled_name, pooled_score, pooled_second = match(pool.pooled())
            if pooled_score > score:
                name, score, second = pooled_name, pooled_score, pooled_second
                info["pooled"] = True
        info["score"] = float(score)
        state.track_best_scores[track_id] = max(state.track_best_scores.get(track_id, float("-inf")), score)
        identity = identity_map.get(name)  # None = a gallery folder with no matching roster student
        ambiguous = margin > 0 and second is not None and (score - second) < margin
        if score >= args.threshold and identity is not None and ambiguous:
            info["status"] = "tried (ambiguous)"
        elif score >= args.threshold and identity is not None:
            student_id = identity["student_id"]
            if args.accept_threshold > args.threshold and score < args.accept_threshold:
                # borderline: needs a second agreeing attempt, and no stronger live claim on this student
                holder = stronger_live_claim(state, track_id, student_id, score)
                if holder is not None:
                    info["status"] = f"tried (T{holder} holds this student)"
                elif info.get("pooled") and single_look_score < args.threshold:
                    # the average is borderline and this look alone is below the bar: the averaged looks are
                    # not independent of the earlier vote, so this does not count as a second opinion
                    info["status"] = "borderline (average only)"
                else:
                    votes = state.track_votes.setdefault(track_id, {})
                    votes[student_id] = votes.get(student_id, 0) + 1
                    matched = votes[student_id] >= 2
                    if not matched:
                        info["status"] = "borderline 1/2"
            else:
                matched = True
        if matched:
            info["status"] = "MATCHED"
            state.track_identity[track_id] = identity["student_id"]
            if identity["student_id"] not in state.present:
                record = {**identity, "best_score": round(score, 4), "frame": frame_index, "track_id": track_id,
                          "attempt": attempts,   # which recognition attempt on this track matched (for window_study.py)
                          "sightings": state.track_sightings.get(track_id, 0)}
                state.present[identity["student_id"]] = record

    if not matched and face.quality < args.min_norm:
        info["status"] = "tried (low quality)"
    if not matched and attempts >= args.max_attempts:
        state.track_identity[track_id] = None  # out of attempts: resolved as "unmatched" right away
    if getattr(args, "trace", False):
        state.attempt_log.append({"frame": frame_index, "processed": state.frames_processed, "track": track_id,
                                  "attempt": attempts, "quality": float(face.quality), "name": name,
                                  "score": None if score is None else float(score),
                                  "second": None if second is None else float(second),
                                  "status": info["status"], "pooled": bool(info.get("pooled")),
                                  "split": bool(info.get("split"))})
    return record
