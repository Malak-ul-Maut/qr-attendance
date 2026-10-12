#!/usr/bin/env python3
"""
check_backend.py - does OpenVINO give the same answers as onnxruntime, and how much faster is it on THIS laptop?

Run it once on each machine (Sparsh, Yash, Ali), with a real classroom frame or the test clip:
    python scripts/check_backend.py --video f310.avi
    python scripts/check_backend.py --image frame.jpg --devices CPU,GPU,AUTO
    python scripts/check_backend.py --video f310.avi --devices GPU --precision f32     # is fp16 hurting accuracy?

For every device it prints: detector time per 1920x1080 frame, recognizer time per batch of 16 faces, and how
close the results are to onnxruntime's (same faces found? same embeddings? same quality norm?). A device whose
embeddings stay above ~0.98 cosine similarity to onnxruntime's is safe to use with the current thresholds
(0.26 / 0.28); if not, try --precision f32 on that device.
"""
import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # recognize.py is one folder up
import cv2
import numpy as np

import accel
import recognize


def load_frame(args):
    if args.image:
        return recognize.load_image(args.image)
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        sys.exit(f"Cannot open {args.video}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    capture.set(cv2.CAP_PROP_POS_FRAMES, int(args.at * fps))
    ok, frame = capture.read()
    capture.release()
    if not ok:
        sys.exit(f"Could not read a frame at t={args.at}s")
    return frame


def build(args, backend, device=None, precision=None):
    os.environ["CCTV_BACKEND"] = backend
    if device:
        os.environ["CCTV_DEVICE"] = device
    if precision:
        os.environ["CCTV_PRECISION"] = precision
    return recognize.FaceModel(args.models, recognize.parse_det_size(args.det_size), args.det_thresh, args.rec_model)


def time_it(fn, repeats):
    fn()   # one warm-up call
    started = time.perf_counter()
    for _ in range(repeats):
        fn()
    return (time.perf_counter() - started) / repeats * 1000


def recognizer_batch(model, frame, faces, size):
    crops = [model.recognizer.align_face(frame, f.kps) for f in faces]
    crops = (crops * (size // max(len(crops), 1) + 1))[:size]   # repeat faces to fill a batch of `size`
    return np.concatenate([model.recognizer.to_tensor(c) for c in crops])


def embed(model, batch):
    rec = model.recognizer
    embeddings, norms = rec.session.run(rec.output_names, {rec.input_name: batch})
    embeddings = np.asarray(embeddings, dtype=np.float32)
    return embeddings / np.maximum(np.linalg.norm(embeddings, axis=1, keepdims=True), 1e-9), np.asarray(norms).reshape(-1)


def match_boxes(reference, other, min_iou=0.5):
    """Fraction of `reference` faces that have a face in `other` overlapping them by IoU >= min_iou."""
    if not reference:
        return 1.0
    hits = sum(1 for a in reference if any(recognize.iou(a.bbox, b.bbox) >= min_iou for b in other))
    return hits / len(reference)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--image")
    source.add_argument("--video")
    parser.add_argument("--at", type=float, default=2.0, help="second of the video to take the frame from")
    parser.add_argument("--devices", default="CPU,GPU,AUTO", help="OpenVINO devices to try, comma separated")
    parser.add_argument("--precision", default=None, choices=["auto", "f32", "f16"])
    parser.add_argument("--models", default=str(recognize.HERE / "models"))
    parser.add_argument("--rec-model", default=recognize.DEFAULT_REC_FILENAME)
    parser.add_argument("--det-size", default="1920x1080")
    parser.add_argument("--det-thresh", type=float, default=0.3)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()

    frame = load_frame(args)
    print(f"frame {frame.shape[1]}x{frame.shape[0]}; OpenVINO {accel.openvino_version() or 'NOT INSTALLED'}")
    if accel.openvino_version() is None:
        sys.exit("pip install openvino   first")
    try:
        import openvino as ov
        print("devices OpenVINO sees:", ", ".join(f"{d} ({ov.Core().get_property(d, 'FULL_DEVICE_NAME')})"
                                                  for d in ov.Core().available_devices))
    except Exception as error:
        print(f"(could not list devices: {error})")

    print("\n-- baseline: onnxruntime (CPU) --")
    base = build(args, "onnxruntime")
    base_faces, _ = base.detect(frame)
    batch = recognizer_batch(base, frame, base_faces, 16) if base_faces else None
    if batch is None:
        sys.exit("No face found in this frame - pick another frame (--at / --image).")
    base_emb, base_norm = embed(base, batch)
    base_detect = time_it(lambda: base.detect(frame), args.repeats)
    base_rec = time_it(lambda: embed(base, batch), args.repeats)
    print(f"{len(base_faces)} faces | detect {base_detect:.0f} ms/frame | recognize {base_rec:.0f} ms per batch of 16")

    print(f"\n{'device':<14}{'detect ms':>10}{'x faster':>9}{'recog ms':>10}{'x faster':>9}{'faces':>7}{'found':>7}"
          f"{'cos mean':>10}{'cos min':>9}{'norm diff':>10}  engine")
    for device in [d.strip() for d in args.devices.split(",") if d.strip()]:
        try:
            model = build(args, "openvino", device, args.precision)
            model.warm_up()
            if model.rec_session is None:
                print(f"{device:<14}  OpenVINO could not start on this device (see messages above)")
                continue
            faces, _ = model.detect(frame)
            emb, norm = embed(model, batch)
            detect_ms = time_it(lambda: model.detect(frame), args.repeats)
            rec_ms = time_it(lambda: embed(model, batch), args.repeats)
            cosine = (emb * base_emb).sum(axis=1)
            norm_diff = float(np.mean(np.abs(norm - base_norm) / np.maximum(base_norm, 1e-6)))
            print(f"{device:<14}{detect_ms:>10.0f}{base_detect / detect_ms:>8.1f}x{rec_ms:>10.0f}{base_rec / rec_ms:>8.1f}x"
                  f"{len(faces):>7}{match_boxes(base_faces, faces):>7.0%}{cosine.mean():>10.4f}{cosine.min():>9.4f}"
                  f"{norm_diff:>9.1%}  {model.backend_summary()}")
        except Exception as error:
            print(f"{device:<14}  failed: {type(error).__name__}: {error}")
    print("\nfaces = faces found | found = share of onnxruntime's faces also found | cos = embedding similarity "
          "to onnxruntime's | norm diff = change in AdaFace's quality norm")


if __name__ == "__main__":
    main()
