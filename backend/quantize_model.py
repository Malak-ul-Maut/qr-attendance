#!/usr/bin/env python3
"""
quantize_model.py - make an int8 (8-bit) copy of the AdaFace recognizer, then check how much it
changed the results and how much faster it is.

Why: the recognizer does its maths in 32-bit floats. An int8 copy stores weights as 8-bit numbers
and runs most of the network in integer maths, which is often 1.5-3x faster on a CPU - at the price
of tiny changes in every embedding. This script measures that price so you can decide.

How: STATIC quantization. The network (ir101) is almost entirely convolution layers, and static
quantization is the kind that speeds those up. It needs "calibration" data - real face crops to
run through the model once, so the script can measure each layer's typical value range. The closer
those crops look to your real CCTV faces (small, a bit blurry), the better the int8 model
behaves, so pass a real clip with --calib-video. Gallery photos alone are sharp close-ups.

Setup:    pip install onnx onnxruntime        (onnx is needed for quantization)

Usage:
    python quantize_model.py --calib-video f310.avi
    python quantize_model.py --calib-video f310.avi --calib-method entropy
    python quantize_model.py --compare-only          # skip quantizing, just re-run the comparison

Afterwards: if the comparison looks good, use the new file by setting CCTV_REC_MODEL (server) or
--rec-model (recognize.py) to its name, and restart. Gallery embeddings are rebuilt automatically
for the new model. Re-check --min-norm too: int8 quality norms differ slightly from fp32 ones.
"""
import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime

import recognize

CALIBRATION_METHODS = {"minmax": "MinMax", "entropy": "Entropy", "percentile": "Percentile"}


def collect_from_gallery(model, gallery_dir, wanted):
    """Aligned face tensors from gallery photos, sampled evenly across all students."""
    gallery_dir = Path(gallery_dir)
    photos = [p for d in sorted(gallery_dir.iterdir()) if d.is_dir()
              for p in sorted(d.iterdir()) if p.suffix.lower() in recognize.IMAGE_TYPES] if gallery_dir.is_dir() else []
    tensors = []
    for photo in photos[::max(1, len(photos) // wanted)]:
        image = recognize.load_image(photo)
        faces, _ = model.detect(image, det_size=recognize.GALLERY_DET_SIZE)
        if faces:
            biggest = max(faces, key=lambda f: np.prod(recognize.face_size(f)))
            tensors.append(model.recognizer.preprocess(image, biggest))
        if len(tensors) >= wanted:
            break
    return tensors


def collect_from_video(model, video, wanted, every=18):
    """Aligned face tensors from every Nth frame of a clip - these look like real CCTV faces."""
    roi = recognize.load_cached_roi(video)
    capture = cv2.VideoCapture(str(video))
    tensors, frame_no = [], 0
    while len(tensors) < wanted:
        if not capture.grab():
            break
        frame_no += 1
        if frame_no % every:
            continue
        ok, frame = capture.retrieve()
        if not ok:
            break
        if roi is not None:
            frame = frame[roi[1]:roi[1] + roi[3], roi[0]:roi[0] + roi[2]]
        faces, _ = model.detect(frame)
        tensors.extend(model.recognizer.preprocess(frame, face) for face in faces)
    capture.release()
    return tensors[:wanted]


def make_calibration_reader(input_name, tensors):
    """Feeds the face tensors to the quantizer one at a time."""
    from onnxruntime.quantization import CalibrationDataReader

    class FaceCalibrationReader(CalibrationDataReader):
        def __init__(self):
            self.iterator = iter(tensors)

        def get_next(self):
            tensor = next(self.iterator, None)
            return None if tensor is None else {input_name: tensor}

        def rewind(self):  # some calibration methods read the data twice
            self.iterator = iter(tensors)

    return FaceCalibrationReader()


def quantize(src, out, input_name, calibration_tensors, method, reduce_range):
    try:
        from onnxruntime.quantization import CalibrationMethod, QuantFormat, QuantType, quantize_static
    except ImportError:
        sys.exit("Quantization needs onnx + a recent onnxruntime. Run: pip install onnx onnxruntime")

    # Optional tidy-up pass that helps quantization; skipped if it fails on this model
    prepped = out.with_suffix(".prep.onnx")
    try:
        from onnxruntime.quantization.shape_inference import quant_pre_process
        quant_pre_process(str(src), str(prepped), skip_symbolic_shape=True)
        to_quantize = prepped
    except Exception as error:
        print(f"  (pre-processing step skipped: {error})")
        to_quantize = src

    print(f"  quantizing with {len(calibration_tensors)} calibration face(s), method={method} ...")
    started = time.perf_counter()
    quantize_static(
        str(to_quantize), str(out), make_calibration_reader(input_name, calibration_tensors),
        quant_format=QuantFormat.QDQ,                 # the format that runs fastest on CPU
        per_channel=True,                             # one scale per filter: keeps accuracy higher
        reduce_range=reduce_range,                    # only needed on older CPUs (see --reduce-range)
        weight_type=QuantType.QInt8,
        activation_type=QuantType.QUInt8,
        calibrate_method=getattr(CalibrationMethod, CALIBRATION_METHODS[method]),
    )
    prepped.unlink(missing_ok=True)
    print(f"  done in {time.perf_counter() - started:.0f}s: {out}  ({out.stat().st_size / 1e6:.0f} MB, "
          f"original {src.stat().st_size / 1e6:.0f} MB)")


def average_ms(session, input_name, batch, runs=5):
    """Average time of one model call on this batch (after one untimed warm-up call)."""
    session.run(None, {input_name: batch})
    started = time.perf_counter()
    for _ in range(runs):
        session.run(None, {input_name: batch})
    return (time.perf_counter() - started) * 1000 / runs


def compare(src, out, tensors):
    """Run both models on faces that were NOT used for calibration and report differences + speed."""
    fp32 = onnxruntime.InferenceSession(str(src), providers=["CPUExecutionProvider"])
    int8 = onnxruntime.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    name_fp32, name_int8 = fp32.get_inputs()[0].name, int8.get_inputs()[0].name

    similarities, norms_fp32, norms_int8 = [], [], []
    for tensor in tensors:
        embedding_fp32, norm_fp32 = fp32.run(None, {name_fp32: tensor})
        embedding_int8, norm_int8 = int8.run(None, {name_int8: tensor})
        a, b = embedding_fp32[0], embedding_int8[0]
        similarities.append(float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b))))  # 1.0 = identical direction
        norms_fp32.append(float(np.asarray(norm_fp32).reshape(-1)[0]))
        norms_int8.append(float(np.asarray(norm_int8).reshape(-1)[0]))

    similarities = np.array(similarities)
    print(f"\nAccuracy check on {len(tensors)} held-out face(s) (fp32 embedding vs int8 embedding of the SAME face):")
    print(f"  cosine similarity: mean {similarities.mean():.4f}, worst {similarities.min():.4f}, "
          f"5th percentile {np.percentile(similarities, 5):.4f}   (1.0 = no change)")
    print(f"  AdaFace quality norm: fp32 mean {np.mean(norms_fp32):.2f} -> int8 mean {np.mean(norms_int8):.2f} "
          f"(re-check --min-norm if you use one)")

    print("\nSpeed (average per call, this machine):")
    print(f"  {'':<22}{'fp32':>12}{'int8':>12}{'speedup':>10}")
    one_face = tensors[0]
    fp32_ms, int8_ms = average_ms(fp32, name_fp32, one_face), average_ms(int8, name_int8, one_face)
    print(f"  {'1 face per call':<22}{fp32_ms:>9.0f} ms{int8_ms:>9.0f} ms{fp32_ms / int8_ms:>9.2f}x")
    batch_dim = fp32.get_inputs()[0].shape[0]
    if not (isinstance(batch_dim, int) and batch_dim > 0):  # model accepts a batch
        batch = np.concatenate(tensors[:recognize.RECOGNIZE_BATCH_SIZE])
        count = len(batch)
        fp32_ms, int8_ms = average_ms(fp32, name_fp32, batch), average_ms(int8, name_int8, batch)
        print(f"  {f'{count} faces per call':<22}{fp32_ms / count:>7.0f} ms/f{int8_ms / count:>7.0f} ms/f{fp32_ms / int8_ms:>9.2f}x")
    else:
        print("  (this model has a fixed batch size of 1, so batching can't be tested)")

    print("\nHow to read this: a mean similarity around 0.98+ with no very low outliers usually keeps "
          "recognition working the same; the real test is running recognize.py on your own clips with "
          "both models and comparing who gets marked present. If int8 is not clearly faster, this CPU "
          "probably lacks fast 8-bit instructions - keep the fp32 model.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models", default=str(recognize.HERE / "models"))
    parser.add_argument("--src", default=recognize.DEFAULT_REC_FILENAME, help="fp32 recognizer file inside --models")
    parser.add_argument("--out", default=None, help="int8 file to create inside --models (default: <src>_int8.onnx)")
    parser.add_argument("--gallery", default=str(recognize.HERE / "gallery"))
    parser.add_argument("--calib-video", default=None, help="a real CCTV clip to take calibration faces from (recommended)")
    parser.add_argument("--calib-images", type=int, default=100,
                        help="calibration faces per source (gallery / video); the same number again is held out for the accuracy check")
    parser.add_argument("--calib-method", choices=sorted(CALIBRATION_METHODS), default="minmax",
                        help="minmax is the safe default; entropy often keeps accuracy better but takes longer")
    parser.add_argument("--reduce-range", action="store_true",
                        help="use 7-bit activations - try this if int8 results are poor on an older CPU without VNNI/AVX512")
    parser.add_argument("--compare-only", action="store_true", help="don't quantize, just compare existing files")
    args = parser.parse_args()

    models_dir = Path(args.models)
    src = models_dir / args.src
    out = models_dir / (args.out or f"{Path(args.src).stem}_int8.onnx")

    print("Loading detector + recognizer (needed to cut out face crops) ...")
    model = recognize.FaceModel(models_dir, recognize.parse_det_size("1920x1080"), 0.3, args.src)

    # Collect twice as many faces as needed: even-numbered ones calibrate, odd-numbered ones are
    # held out for the accuracy check (a model should never be judged on its own calibration data).
    wanted = args.calib_images * 2
    faces = collect_from_gallery(model, args.gallery, wanted)
    print(f"  {len(faces)} face(s) from the gallery")
    if args.calib_video:
        from_video = collect_from_video(model, args.calib_video, wanted)
        print(f"  {len(from_video)} face(s) from {args.calib_video}")
        faces += from_video
    if len(faces) < 4:
        sys.exit("Need at least a handful of faces to calibrate with - check --gallery / --calib-video.")
    calibration, held_out = faces[0::2], faces[1::2]

    if not args.compare_only:
        quantize(src, out, model.recognizer.input_name, calibration, args.calib_method, args.reduce_range)
    elif not out.exists():
        sys.exit(f"--compare-only: {out} does not exist yet.")

    compare(src, out, held_out)
    print(f"\nTo use it: set CCTV_REC_MODEL={out.name} and restart the service "
          f"(or: python recognize.py --rec-model {out.name} ...).")


if __name__ == "__main__":
    main()