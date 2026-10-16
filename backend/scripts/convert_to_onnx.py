#!/usr/bin/env python3
"""Convert CVLface's AdaFace ViT-KPRPE (minchul/cvlface_adaface_vit_base_kprpe_webface12m) to ONNX for recognize.py,
then check the ONNX output matches PyTorch.

Setup:
    pip install torch onnx onnxruntime numpy safetensors transformers omegaconf huggingface_hub timm easydict
    pip install onnxsim                                  # optional, only for --simplify
    # download the whole model repo (code + weights) - the model code lives in the repo, so a bare .safetensors is not enough:
    hf download minchul/cvlface_adaface_vit_base_kprpe_webface12m --local-dir ./kprpe_repo
    #   (the card says the repo may need your Hugging Face token: set HF_TOKEN or run `huggingface-cli login`)

Usage:
    python scripts/convert_to_onnx.py --repo-dir ./kprpe_repo --out models/adaface_vit_kprpe_webface12m.onnx
    python scripts/convert_to_onnx.py --repo-dir ./kprpe_repo --weights path/to/model.safetensors --out ...   # explicit weights file

What the original model is, and what this script changes so recognize.py can use it unchanged:
    The original model takes TWO inputs - an RGB image and 5 face keypoints (normalised 0..1, as (x, y) in the 112x112
    image) - and returns ONE un-normalised vector. recognize.py feeds a BGR image only and wants (embedding, norm).
    So the exported graph wraps the network and:
      * flips BGR -> RGB inside the graph            (recognize.py keeps sending BGR, exactly as for AdaFace IR-101)
      * supplies the keypoints itself                (default: the fixed ArcFace landmark template, which is exactly where
                                                      recognize.py's norm_crop puts the eyes/nose/mouth in the 112x112 crop;
                                                      use --keypoints input to expose them as a second input instead)
      * splits the output into a unit-length embedding and the feature norm (AdaFace's quality hint, same meaning as before)

Model contract of the .onnx written here:
    input     : 'input'     float32 [N, 3, 112, 112]  aligned face, BGR order, pixels (x / 255 - 0.5) / 0.5
    (optional): 'keypoints' float32 [N, 5, 2]         only with --keypoints input: landmarks in the 112x112 crop, (x, y) / 112
    output    : 'embedding' float32 [N, 512]          L2-normalised
                'norm'      float32 [N, 1]            norm of the raw feature (quality hint; not on the same scale as IR-101's)
"""
import argparse
import os
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

# insightface.utils.face_align.arcface_dst: where norm_crop(image_size=112) places left eye, right eye, nose, left and
# right mouth corner in the aligned 112x112 crop. Divided by 112 = the [0, 1] (x, y) keypoints the model expects.
ARCFACE_112 = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                        [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)
TEMPLATE_KEYPOINTS = ARCFACE_112 / 112.0


def load_model(repo_dir, weights_path):
    """Build the network from the downloaded repo's own code (trust_remote_code), then optionally load an explicit weights file."""
    repo_dir = Path(repo_dir).resolve()
    if not (repo_dir / "config.json").exists():
        sys.exit(f"{repo_dir} has no config.json - point --repo-dir at the downloaded model repo "
                 f"(huggingface-cli download minchul/cvlface_adaface_vit_base_kprpe_webface12m --local-dir ./kprpe_repo)")
    try:
        from transformers.dynamic_module_utils import get_class_from_dynamic_module
    except ImportError:
        sys.exit("transformers is missing. Run: pip install transformers omegaconf")

    # CVLface's wrapper opens 'pretrained_model/...' relative to the repo folder, and imports 'models.*' from it.
    previous_cwd = os.getcwd()
    sys.path.insert(0, str(repo_dir))
    os.chdir(repo_dir)
    try:
        model_class = get_class_from_dynamic_module(
            "wrapper.CVLFaceRecognitionModel", str(repo_dir), local_files_only=True
        )
        # CVLFace's wrapper predates Transformers' tied-weight bookkeeping and has no tied weights.
        if not hasattr(model_class, "all_tied_weights_keys"):
            model_class.all_tied_weights_keys = {}
        model = model_class.from_pretrained(str(repo_dir))
    except Exception as error:
        sys.exit(f"Could not build the model from {repo_dir}: {type(error).__name__}: {error}\n"
                 f"Check that the repo download is complete (models/, pretrained_model/, wrapper.py, config.json) "
                 f"and that omegaconf / transformers are installed.")
    finally:
        os.chdir(previous_cwd)

    if weights_path:
        load_weights(model, weights_path)
    return model.eval().requires_grad_(False)


def load_weights(model, weights_path):
    """Load a .safetensors (or .pt/.ckpt) file into the network, tolerating a 'net.' / 'model.' / 'module.' key prefix."""
    weights_path = str(weights_path)
    if weights_path.endswith(".safetensors"):
        try:
            from safetensors.torch import load_file
        except ImportError:
            sys.exit("safetensors is missing. Run: pip install safetensors")
        state = load_file(weights_path, device="cpu")
    else:
        state = torch.load(weights_path, map_location="cpu")
        state = state.get("state_dict", state) if isinstance(state, dict) else state

    candidates = [state]
    candidates += [{k[len(p):]: v for k, v in state.items() if k.startswith(p)} for p in ("net.", "model.", "module.")]
    candidates.append({"net." + k: v for k, v in state.items()})
    last_error = None
    for candidate in candidates:
        if not candidate:
            continue
        try:
            model.load_state_dict(candidate, strict=True)   # strict: the wrong file fails here, loudly
            print(f"Loaded weights from {weights_path}")
            return
        except RuntimeError as error:
            last_error = error
    sys.exit(f"{weights_path} does not match this model's layers:\n{last_error}")


class Embedder(nn.Module):
    """BGR image in -> (unit embedding, feature norm) out. Keypoints are a baked-in constant, or a second input."""

    def __init__(self, network, keypoints_as_input):
        super().__init__()
        self.network = network
        self.keypoints_as_input = keypoints_as_input
        self.register_buffer("template", torch.from_numpy(TEMPLATE_KEYPOINTS))   # [5, 2]

    def forward(self, x, keypoints=None):
        x = x.flip(1)                                            # BGR -> RGB (the model was trained on RGB)
        if keypoints is None:
            keypoints = self.template.unsqueeze(0).expand(x.shape[0], -1, -1)   # same landmarks for every face in the batch
        feature = self.network(x, keypoints)
        if isinstance(feature, (tuple, list)):                   # be safe if a future version returns extras
            feature = feature[0]
        norm = torch.linalg.vector_norm(feature, dim=1, keepdim=True)
        return feature / norm.clamp_min(1e-9), norm


class EmbedderFixedKeypoints(Embedder):
    """Same, but forward() takes ONLY the image (the ONNX exporter needs a fixed argument list)."""

    def forward(self, x):
        return super().forward(x, None)


def export(network, out_path, opset=17, static_batch=0, keypoints_as_input=False, simplify=False):
    """Write `out_path` and return (wrapper module, input names). Separate from main() so it can be tested on its own."""
    model = (Embedder(network, True) if keypoints_as_input else EmbedderFixedKeypoints(network, False)).eval()
    batch = max(static_batch, 1)
    dummy = [torch.randn(batch, 3, 112, 112)]
    input_names = ["input"]
    if keypoints_as_input:
        dummy.append(torch.from_numpy(TEMPLATE_KEYPOINTS).unsqueeze(0).repeat(batch, 1, 1))
        input_names.append("keypoints")
    output_names = ["embedding", "norm"]

    dynamic_axes = None
    if not static_batch:
        dynamic_axes = {name: {0: "batch"} for name in input_names + output_names}

    export_kwargs = dict(input_names=input_names, output_names=output_names, dynamic_axes=dynamic_axes,
                         opset_version=opset, do_constant_folding=True)
    with torch.no_grad():
        try:
            # Newer torch defaults to the "dynamo" exporter; the classic exporter is the well-trodden path.
            torch.onnx.export(model, tuple(dummy), str(out_path), dynamo=False, **export_kwargs)
        except TypeError:
            torch.onnx.export(model, tuple(dummy), str(out_path), **export_kwargs)

    import onnx
    onnx.checker.check_model(str(out_path))   # by path: also works when the weights are stored as external data

    if simplify:
        try:
            import onnxsim
            simplified, ok = onnxsim.simplify(onnx.load(str(out_path)))
            if ok:
                onnx.save(simplified, str(out_path))
                print("Simplified with onnxsim.")
            else:
                print("onnxsim could not verify the simplified model; kept the original.")
        except ImportError:
            print("onnxsim is not installed; skipped --simplify.")
    return model, input_names


def verify(model, input_names, out_path, static_batch=0):
    """Same inputs through PyTorch and ONNX Runtime, for the exported batch size and (if dynamic) for others. Returns True if they agree."""
    import onnxruntime as ort
    session = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    batches = [static_batch] if static_batch else [4, 1, 3]
    worst_diff, worst_cos, worst_norm_rel = 0.0, 1.0, 0.0
    for n in batches:
        feeds = {"input": rng.uniform(-1, 1, size=(n, 3, 112, 112)).astype(np.float32)}
        if "keypoints" in input_names:   # a little jitter around the template, like real detector landmarks
            feeds["keypoints"] = (TEMPLATE_KEYPOINTS + rng.normal(0, 0.01, size=(n, 5, 2))).astype(np.float32)
        with torch.no_grad():
            expected_embedding, expected_norm = (t.numpy() for t in model(*[torch.from_numpy(feeds[name]) for name in input_names]))
        got_embedding, got_norm = session.run(None, feeds)
        worst_diff = max(worst_diff, float(np.abs(expected_embedding - got_embedding).max()))
        cos = (expected_embedding * got_embedding).sum(1) / (np.linalg.norm(expected_embedding, axis=1) * np.linalg.norm(got_embedding, axis=1))
        worst_cos = min(worst_cos, float(cos.min()))
        worst_norm_rel = max(worst_norm_rel, float((np.abs(expected_norm - got_norm) / np.maximum(np.abs(expected_norm), 1e-9)).max()))
        if got_embedding.shape != (n, expected_embedding.shape[1]) or got_norm.shape != (n, 1):
            print(f"Unexpected output shapes {got_embedding.shape}, {got_norm.shape} for batch {n}")
            return False
        unit = np.linalg.norm(got_embedding, axis=1)
        if not np.allclose(unit, 1.0, atol=1e-4):
            print("ONNX embedding is not unit length")
            return False
    print(f"PyTorch vs ONNX Runtime (batches {batches}): max |embedding diff| = {worst_diff:.2e}, "
          f"min cosine = {worst_cos:.6f}, max relative norm diff = {worst_norm_rel:.2e}")
    return worst_diff <= 1e-3 and worst_cos >= 0.9999 and worst_norm_rel <= 1e-3


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo-dir", required=True, help="folder with the downloaded model repo (config.json, wrapper.py, models/, weights)")
    ap.add_argument("--weights", help="optional .safetensors / .pt file to load instead of the repo's own weights")
    ap.add_argument("--out", required=True, help="output .onnx path")
    ap.add_argument("--keypoints", choices=["template", "input"], default="template",
                    help="template (default): bake in the ArcFace landmark template - works with recognize.py's aligned crops as is. "
                         "input: expose a second 'keypoints' [N,5,2] input")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--static-batch", type=int, default=0,
                    help="fix the batch size to N (some GPU runtimes compile faster for a fixed shape). Default: dynamic batch")
    ap.add_argument("--simplify", action="store_true", help="run onnxsim afterwards if it is installed")
    args = ap.parse_args()

    network = load_model(args.repo_dir, args.weights)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    keypoints_as_input = args.keypoints == "input"
    model, input_names = export(network, args.out, args.opset, args.static_batch, keypoints_as_input, args.simplify)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    size_mb = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir)
                  if f.startswith(os.path.basename(args.out))) / 1048576
    print(f"Wrote {args.out}  ({size_mb:.0f} MB, batch {'fixed ' + str(args.static_batch) if args.static_batch else 'dynamic'}, "
          f"inputs {input_names})")
    if not verify(model, input_names, args.out, args.static_batch):
        sys.exit("MISMATCH: the exported model does not reproduce the PyTorch output. Do not use it.")
    print("OK. Input: float32 [N,3,112,112], BGR, (pixel/255 - 0.5)/0.5"
          + (" + keypoints [N,5,2]" if keypoints_as_input else "") + ". Outputs: 512-d L2-normalised embedding, norm [N,1].")


if __name__ == "__main__":
    main()