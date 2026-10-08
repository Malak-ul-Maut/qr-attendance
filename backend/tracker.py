"""
tracker.py - gives each detected face a persistent ID across video frames.

Why not just match boxes frame-to-frame by overlap (as the earlier plan did)? Because that
breaks the moment a face is missed for even one frame (a head turn, a blink, a bad detection) -
the next sighting gets treated as a brand new person. A real tracker instead lets a track
survive a few missed frames and still be recognised as "the same track" when the face reappears
in roughly the same place.

Matching rule: a detection belongs to a track if the two boxes overlap enough (IoU) OR their
centres are close relative to the face's own size. Plain IoU alone is too strict for the small,
far-away faces in a classroom: a seated student who shifts by only a few pixels between two
sampled frames can drop below the IoU threshold on a ~30 px box and be treated as a new person.
Distance is measured in "face widths" so it works the same for near and far rows.

Simplification made on purpose: there is no motion model (no Kalman filter) here. A tracked
face's predicted next position is just "wherever it was last seen". For a WALL-MOUNTED CAMERA
watching SEATED students, that is a good enough prediction - motion between frames is small. A
moving camera or walking subjects would need a real motion model; this scenario does not.

Usage (see calibrate.py for a full example):
    tracker = Tracker()
    for frame in frames:
        boxes = [face.bbox for face in detect_faces(frame)]   # list of [x1, y1, x2, y2]
        track_ids = tracker.update(boxes)                     # one id per box, same order
"""
import numpy as np


def _center(box):
    return (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0


def _size(box):
    """Average of a box's width and height (at least 1 px) - the unit for 'how far did it move'."""
    return max(1.0, ((box[2] - box[0]) + (box[3] - box[1])) / 2.0)


def iou(box_a, box_b):
    """Intersection-over-union of two [x1, y1, x2, y2] boxes: 1.0 = identical, 0.0 = no overlap."""
    x1, y1 = max(box_a[0], box_b[0]), max(box_a[1], box_b[1])
    x2, y2 = min(box_a[2], box_b[2]), min(box_a[3], box_b[3])
    overlap = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = (box_a[2] - box_a[0]) * (box_a[3] - box_a[1])
    area_b = (box_b[2] - box_b[0]) * (box_b[3] - box_b[1])
    union = area_a + area_b - overlap
    return overlap / union if union > 0 else 0.0


class Track:
    """One tracked face: its id, its last known box, and how reliable it currently looks."""

    def __init__(self, track_id, box):
        self.id = track_id
        self.box = box
        self.hits = 1          # frames this track has been successfully matched, ever
        self.missed = 0        # frames in a row it has NOT been matched (resets to 0 on a match)

    @property
    def confirmed(self):
        """True once a track has been seen enough times to trust it is a real face, not a flicker."""
        return self.hits >= 3


class Tracker:
    """
    Call .update(boxes) once per frame, in frame order. Returns one track id per input box.
    A box that overlaps an existing track (IoU >= iou_threshold), or whose centre is within
    max_center_dist face-widths of the track's last box and is a similar size (within
    max_size_ratio), keeps that track's id. A box that matches nothing becomes a new track. A track not matched for > max_missed frames in a
    row is dropped (its id will not be reused).
    """

    def __init__(self, iou_threshold=0.3, max_missed=15, max_center_dist=0.6, max_size_ratio=1.6):
        self.iou_threshold = iou_threshold
        self.max_center_dist = max_center_dist   # 0 turns the distance rule off (IoU only, as before)
        self.max_size_ratio = max_size_ratio
        self.max_missed = max_missed
        self.tracks = []       # currently alive tracks (includes ones missed recently, not yet dropped)
        self._next_id = 1

    def update(self, boxes):
        assigned_ids = [None] * len(boxes)

        # Rank every plausible (track, box) pair, closest first, then assign greedily.
        # This is simpler than an optimal (Hungarian) assignment, and is accurate enough here
        # because seated students' faces rarely overlap each other in the frame.
        candidates = []
        for track in self.tracks:
            track_cx, track_cy = _center(track.box)
            track_size = _size(track.box)
            for box_i, box in enumerate(boxes):
                box_cx, box_cy = _center(box)
                distance = ((box_cx - track_cx) ** 2 + (box_cy - track_cy) ** 2) ** 0.5 / track_size
                overlaps = iou(track.box, box) >= self.iou_threshold
                size_ratio = max(track_size, _size(box)) / min(track_size, _size(box))
                close = (self.max_center_dist > 0 and distance <= self.max_center_dist
                         and size_ratio <= self.max_size_ratio)
                if overlaps or close:
                    candidates.append((distance, track, box_i))
        candidates.sort(key=lambda c: c[0])  # smallest normalised distance first

        used_tracks, used_boxes = set(), set()
        for score, track, box_i in candidates:
            if id(track) in used_tracks or box_i in used_boxes:
                continue  # this track or this box was already claimed by a better-overlapping pair
            track.box = boxes[box_i]
            track.hits += 1
            track.missed = 0
            assigned_ids[box_i] = track.id
            used_tracks.add(id(track))
            used_boxes.add(box_i)

        # Boxes nothing matched become new tracks
        for box_i, box in enumerate(boxes):
            if assigned_ids[box_i] is None:
                new_track = Track(self._next_id, box)
                self._next_id += 1
                self.tracks.append(new_track)
                assigned_ids[box_i] = new_track.id
                used_tracks.add(id(new_track))

        # Tracks nothing matched this frame get older; drop ones that have been missing too long
        for track in self.tracks:
            if id(track) not in used_tracks:
                track.missed += 1
        self.tracks = [t for t in self.tracks if t.missed <= self.max_missed]

        return assigned_ids

    def is_confirmed(self, track_id):
        """Has this track id been seen enough times to trust (see Track.confirmed)? False if it no longer exists."""
        return any(t.id == track_id and t.confirmed for t in self.tracks)