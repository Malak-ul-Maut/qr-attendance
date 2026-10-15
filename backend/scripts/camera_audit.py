#!/usr/bin/env python3
"""
camera_audit.py - how good is the picture the camera gives US? Run it after every camera / recorder setting change.

    python scripts/camera_audit.py "rtsp://USER:PASS@NVR_IP:554/cam/realmonitor?channel=3&subtype=0" --label "main stream, 6 Mbps, shutter 1/100"
    python scripts/camera_audit.py frame.jpg --label "current settings"        # a saved picture or a video file works too

It grabs a few frames, finds the faces and measures what matters for recognition:
  * face width in pixels (the biggest factor: below ~24 px the models struggle, below ~16 px they mostly cannot)
  * AdaFace's own quality score ("norm") for each face: higher = a face the model finds easier. It needs NO labels,
    so it is the fair way to compare two camera settings: same classroom, change one setting, run again, compare.
  * sharpness and brightness of the face crops
One line per run is appended to camera_audit.csv so the runs can be compared side by side.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # the scripts live in scripts/; recognize.py is one folder up
import argparse
import csv
import statistics
import time
from pathlib import Path

import cv2
import numpy as np

import recognize
from enroll_qa import sharpness_of


def grab_frames(source, count, interval):
    """Yields (frame, seconds since start). A picture file gives the same frame `count` times."""
    path = Path(source)
    if path.is_file() and path.suffix.lower() in recognize.IMAGE_TYPES:
        image = recognize.load_image(path)
        for _ in range(count):
            yield image, 0.0
        return
    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        raise SystemExit(f"Could not open {recognize.mask_url(source)}")
    started, next_at, taken = time.time(), 0.0, 0
    while taken < count:
        ok, frame = capture.read()
        if not ok:
            break
        elapsed = time.time() - started
        if elapsed >= next_at:
            yield frame, elapsed
            taken += 1
            next_at = elapsed + interval
    capture.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", help="rtsp:// address, video file or picture")
    parser.add_argument("--label", default="", help="what you changed, e.g. 'bitrate 6 Mbps' (written into the csv)")
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--interval", type=float, default=0.7, help="seconds between frames")
    parser.add_argument("--models", default=str(recognize.HERE / "models"))
    parser.add_argument("--det-size", default="1920x1080")
    parser.add_argument("--det-thresh", type=float, default=0.3)
    parser.add_argument("--csv", default=str(recognize.HERE / "camera_audit.csv"))
    parser.add_argument("--save-frame", default=None, help="save the first frame here")
    args = parser.parse_args()

    model = recognize.FaceModel(args.models, recognize.parse_det_size(args.det_size), args.det_thresh)
    widths, norms, sharp, luma, resolution, counts, stamps = [], [], [], [], None, [], []
    for index, (frame, elapsed) in enumerate(grab_frames(args.source, args.frames, args.interval)):
        resolution = f"{frame.shape[1]}x{frame.shape[0]}"
        if index == 0 and args.save_frame:
            recognize.save_image(args.save_frame, frame)
        faces, _ = model.detect(frame)
        model.recognize_batch(frame, faces)
        counts.append(len(faces))
        stamps.append(elapsed)
        grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        for face in faces:
            x1, y1, x2, y2 = (max(0, int(v)) for v in face.bbox)
            widths.append(face.bbox[2] - face.bbox[0])
            norms.append(float(face.quality))
            sharp.append(sharpness_of(face.aligned_bgr))
            luma.append(float(grey[y1:y2, x1:x2].mean()) if y2 > y1 and x2 > x1 else 0.0)
    if not widths:
        raise SystemExit("No face was found in any frame. Check the picture (and the camera address).")

    def pct(values, q):
        return float(np.percentile(values, q))

    row = {
        "when": time.strftime("%Y-%m-%d %H:%M"), "label": args.label, "resolution": resolution,
        "frames": len(counts), "faces_per_frame": round(statistics.mean(counts), 1),
        "width_median_px": round(statistics.median(widths), 1), "width_p10_px": round(pct(widths, 10), 1),
        "width_p90_px": round(pct(widths, 90), 1),
        "share_ge_24px": round(sum(w >= 24 for w in widths) / len(widths), 2),
        "share_ge_32px": round(sum(w >= 32 for w in widths) / len(widths), 2),
        "adaface_norm_mean": round(statistics.mean(norms), 2), "sharpness_mean": round(statistics.mean(sharp), 1),
        "face_brightness_mean": round(statistics.mean(luma), 1),
        "fps_seen": round((len(counts) - 1) / stamps[-1], 2) if len(counts) > 1 and stamps[-1] > 0 else "",
    }
    for key, value in row.items():
        print(f"  {key:<22} {value}")
    csv_path = Path(args.csv)
    new_file = not csv_path.exists()
    with open(csv_path, "a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(row))
        if new_file:
            writer.writeheader()
        writer.writerow(row)
    print(f"\nAppended to {csv_path}. Compare 'adaface_norm_mean' and 'sharpness_mean' between runs: higher is better.")


if __name__ == "__main__":
    main()
