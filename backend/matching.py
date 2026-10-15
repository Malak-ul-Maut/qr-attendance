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
