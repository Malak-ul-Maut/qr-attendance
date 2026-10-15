#!/usr/bin/env python3
"""Convert an AdaFace checkpoint (.ckpt) to ONNX, then check the ONNX output matches PyTorch.

Works for the IR-101 models (adaface_ir101_webface4m.ckpt, adaface_ir101_webface12m.ckpt) and the other
architectures that AdaFace's net.py can build (ir_18, ir_34, ir_50, ir_101, ir_152, ir_200).

Setup:
    git clone https://github.com/mk-minchul/AdaFace
    pip install torch onnx onnxruntime numpy pytorch-lightning     # pytorch-lightning only if loading fails without it

Usage:
    python convert_adaface.py --ckpt adaface_ir101_webface12m.ckpt --adaface-dir ./AdaFace --out adaface_ir101_webface12m.onnx

Model contract (what to feed it, unchanged by this script):
    input  : float32 [N, 3, 112, 112], aligned face, BGR channel order, pixels (x / 255 - 0.5) / 0.5
    output : 'embedding' float32 [N, 512], already L2-normalised (use --with-norm to also get AdaFace's feature 'norm')
"""
import argparse
import os
import sys

import numpy as np
import torch
from torch import nn


def load_model(adaface_dir, arch, ckpt_path):
    sys.path.insert(0, os.path.abspath(adaface_dir))
    try:
        import net  # AdaFace/net.py
    except ImportError as error:
        sys.exit(f"Could not import net.py from {adaface_dir!r}: {error}\nPoint --adaface-dir at the cloned AdaFace repo.")

    model = net.build_model(arch)
    try:
        checkpoint = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    except ModuleNotFoundError as error:
        sys.exit(f"The checkpoint needs a package that is not installed ({error}). Try: pip install pytorch-lightning")

    state = checkpoint.get("state_dict", checkpoint)
    # Lightning saves the backbone as "model.*" and the training head as "head.*"; only the backbone is needed.
    if any(k.startswith("model.") for k in state):
        state = {k[len("model."):]: v for k, v in state.items() if k.startswith("model.")}
    else:
        state = {k[len("module."):] if k.startswith("module.") else k: v for k, v in state.items()}
    model.load_state_dict(state, strict=True)  # strict: a wrong --arch fails here, loudly
    return model.eval()


class Embedder(nn.Module):
    """AdaFace's backbone returns (normalised embedding, norm). Keep the embedding, optionally the norm."""

    def __init__(self, backbone, with_norm):
        super().__init__()
        self.backbone = backbone
        self.with_norm = with_norm

    def forward(self, x):
        embedding, norm = self.backbone(x)
        return (embedding, norm) if self.with_norm else embedding


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", required=True, help="path to the .ckpt file")
    ap.add_argument("--adaface-dir", required=True, help="folder of the cloned AdaFace repo (contains net.py)")
    ap.add_argument("--out", required=True, help="output .onnx path")
    ap.add_argument("--arch", default="ir_101", help="architecture name for net.build_model (default ir_101)")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--static-batch", type=int, default=0,
                    help="fix the batch size to N (some GPU runtimes compile faster for a fixed shape). Default: dynamic batch")
    ap.add_argument("--with-norm", action="store_true", help="also output AdaFace's feature norm (a face-quality hint)")
    ap.add_argument("--simplify", action="store_true", help="run onnxsim afterwards if it is installed")
    args = ap.parse_args()

    backbone = load_model(args.adaface_dir, args.arch, args.ckpt)
    model = Embedder(backbone, args.with_norm).eval()
    dummy = torch.randn(max(args.static_batch, 1), 3, 112, 112)

    output_names = ["embedding", "norm"] if args.with_norm else ["embedding"]
    dynamic_axes = None
    if not args.static_batch:
        dynamic_axes = {"input": {0: "batch"}, **{name: {0: "batch"} for name in output_names}}

    export_kwargs = dict(
        input_names=["input"], output_names=output_names, dynamic_axes=dynamic_axes,
        opset_version=args.opset, do_constant_folding=True,
    )
    with torch.no_grad():
        try:
            # Newer torch defaults to the "dynamo" exporter; the classic exporter is the well-trodden path for this model.
            torch.onnx.export(model, dummy, args.out, dynamo=False, **export_kwargs)
        except TypeError:
            torch.onnx.export(model, dummy, args.out, **export_kwargs)

    import onnx
    onnx.checker.check_model(onnx.load(args.out, load_external_data=False))

    if args.simplify:
        try:
            import onnxsim
            simplified, ok = onnxsim.simplify(onnx.load(args.out))
            if ok:
                onnx.save(simplified, args.out)
                print("Simplified with onnxsim.")
            else:
                print("onnxsim could not verify the simplified model; kept the original.")
        except ImportError:
            print("onnxsim is not installed; skipped --simplify.")

    # ---- check: same inputs through PyTorch and ONNX Runtime ----
    import onnxruntime as ort
    session = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    batch = max(args.static_batch, 4)
    x = rng.uniform(-1, 1, size=(batch, 3, 112, 112)).astype(np.float32)
    with torch.no_grad():
        expected = model(torch.from_numpy(x))
    expected = [t.numpy() for t in (expected if isinstance(expected, tuple) else (expected,))]
    got = session.run(None, {"input": x})
    worst_diff, worst_cos = 0.0, 1.0
    for e, g in zip(expected, got):
        worst_diff = max(worst_diff, float(np.abs(e - g).max()))
        if e.ndim == 2 and e.shape[1] > 1:
            cos = (e * g).sum(1) / (np.linalg.norm(e, axis=1) * np.linalg.norm(g, axis=1))
            worst_cos = min(worst_cos, float(cos.min()))
    size_mb = sum(os.path.getsize(os.path.join(os.path.dirname(os.path.abspath(args.out)), f))
                  for f in os.listdir(os.path.dirname(os.path.abspath(args.out)) or ".")
                  if f.startswith(os.path.basename(args.out))) / 1048576
    print(f"Wrote {args.out}  ({size_mb:.0f} MB, batch {'fixed ' + str(args.static_batch) if args.static_batch else 'dynamic'})")
    print(f"PyTorch vs ONNX Runtime on random input: max |diff| = {worst_diff:.2e}, min cosine = {worst_cos:.6f}")
    if worst_diff > 1e-3 or worst_cos < 0.9999:
        sys.exit("MISMATCH: the exported model does not reproduce the PyTorch output. Do not use it.")
    print("OK. Input: float32 [N,3,112,112], BGR, (pixel/255 - 0.5)/0.5. Output: 512-d L2-normalised embedding.")


if __name__ == "__main__":
    main()