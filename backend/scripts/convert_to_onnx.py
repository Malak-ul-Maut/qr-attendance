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
      * keypoints: DEFAULT is to expose them as a second input called 'keypoints' ([N, 5, 2], (x, y) / 112 inside the aligned
                   crop). That is how CVLface itself runs the model (apps/verification/verify.py feeds the aligned image together
                   with the landmarks in the aligned frame), and the model code treats them as positions in the [0, 1] square of
                   the image it sees. recognize.py computes them from the detector's landmarks and can also be told to feed the
                   fixed template instead (CCTV_KEYPOINTS=template), so ONE .onnx file covers both settings for an A/B test.
                   --keypoints template bakes the fixed ArcFace template into the graph (image-only file, as before).
      * splits the output into a unit-length embedding and the feature norm (AdaFace's quality hint, same meaning as before)

Which exporter:
    Default is the classic TorchScript-based exporter (--exporter legacy). This model's relative-position-embedding layers
    (attn.rpe_k) cache a tensor on themselves (`_ctx_rp_bucket_flatten`) during forward(). Under the new dynamo exporter that
    tensor is created in "fake tensor" mode, so it ends up in the ONNX file as an initializer with no data and saving fails with
    "Cannot take content out from the FakeTensor". The legacy exporter traces with real tensors, so it does not hit this.
    --exporter dynamo is still available, but is expected to fail on this model.

Dynamic batch (why the model needs a patch):
    CVLface's iRPE.forward_rpe_transpose (models/vit_kprpe/RPE/KPRPE/kprpe_shared.py) does `B = len(x)` and then
    `.view(B, -1, L_query, L_key)`. While tracing, len(x) is frozen to the dummy batch size (1), so at batch 4 the view
    folds the batch into the head axis ([1, 64, L, L] instead of [4, 16, L, L]) and the Add in blocks.0/attn fails with
    "broadcast an axis ... 16 by 64". patch_rpe_for_dynamic_batch() swaps in `.view(-1, x.shape[1], L_query, L_key)`,
    which gives identical results and keeps the batch dimension dynamic. The repo files on disk are not modified.

Other models in the family (minchul/cvlface_adaface_ir101_*, cvlface_arcface_ir101_*, cvlface_adaface_vit_base_*):
    The IR-ResNet and plain-ViT models take the image only; the script detects KP-RPE models (they own `keypoint_linear`)
    and otherwise exports image-only graphs with the same contract below (BGR in, unit embedding + norm out). Only the
    AdaFace-trained models make `norm` a quality hint; for ArcFace-trained ones it is still exported but not meaningful.
    A <model>.onnx.json sidecar records the contract and a SHA-256 of the file.

Model contract of the .onnx written here:
    input     : 'input'     float32 [N, 3, 112, 112]  aligned face, BGR order, pixels (x / 255 - 0.5) / 0.5
    (KP-RPE)  : 'keypoints' float32 [N, 5, 2]         default for KP-RPE models: landmarks in the 112x112 crop, (x, y) / 112
    output    : 'embedding' float32 [N, 512]          L2-normalised
                'norm'      float32 [N, 1]            norm of the raw feature (quality hint; not on the same scale as IR-101's)
"""
import argparse
import os
import sys
import warnings
from itertools import chain
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

        # Newer transformers builds the model on the "meta" device first. The wrapper's own attempt to load
        # pretrained_model/model.pt during __init__ then silently does nothing (that is what the long wall of
        # "copying from a non-meta parameter ... is a no-op" warnings is). The real weights are filled in afterwards by
        # transformers ("Loading weights 283/283"), and ensure_real_weights() below double-checks that.
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message=".*copying from a non-meta parameter.*")
            model = model_class.from_pretrained(str(repo_dir), low_cpu_mem_usage=False)
        model = model.to("cpu")
        ensure_real_weights(model, repo_dir)
    except Exception as error:
        sys.exit(f"Could not build the model from {repo_dir}: {type(error).__name__}: {error}\n"
                 f"Check that the repo download is complete (models/, pretrained_model/, wrapper.py, config.json) "
                 f"and that omegaconf / transformers are installed.")
    finally:
        os.chdir(previous_cwd)

    if weights_path:
        load_weights(model, weights_path)
    return model.eval().requires_grad_(False)


def ensure_real_weights(model, repo_dir):
    """Make sure no parameter/buffer is still a meta tensor, and (re)load the repo's pretrained_model/model.pt into the net."""
    inner = getattr(model, "model", model)       # the wrapper keeps the real network at .model; model.pt keys look like 'net.blocks...'
    ckpt = Path(repo_dir) / "pretrained_model" / "model.pt"
    if ckpt.exists():
        try:
            try:
                state = torch.load(ckpt, map_location="cpu", weights_only=True)
            except Exception:
                state = torch.load(ckpt, map_location="cpu", weights_only=False)
            state = state.get("state_dict", state) if isinstance(state, dict) else state
            inner.load_state_dict(state, strict=True, assign=True)   # assign=True: replaces meta/placeholder tensors with the real ones
            print(f"Loaded weights from {ckpt}")
        except Exception as error:
            print(f"Note: could not load {ckpt} directly ({type(error).__name__}); keeping the weights transformers loaded.")
    meta = [name for name, t in chain(model.named_parameters(), model.named_buffers()) if t.is_meta]
    if meta:
        raise RuntimeError(f"{len(meta)} tensors are still on the meta device (e.g. {meta[:3]}) - the weights did not load. "
                           f"Check that {ckpt} / model.safetensors exist in the repo folder.")


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


def scrub_fake_tensors(network):
    """Reset plain tensor attributes that a previous (failed) dynamo export left behind as FakeTensors."""
    from torch._subclasses.fake_tensor import FakeTensor
    for module in network.modules():
        for key, value in list(vars(module).items()):
            if isinstance(value, FakeTensor):
                setattr(module, key, None)


def patch_rpe_for_dynamic_batch(network):
    """Replace iRPE.forward_rpe_transpose's `view(len(x), ...)` (batch frozen at trace time) with a batch-agnostic view."""
    patched = set()
    for module in network.modules():
        cls = type(module)
        if cls in patched or not hasattr(cls, "forward_rpe_transpose"):
            continue
        original = cls.forward_rpe_transpose

        def forward_rpe_transpose(self, x, rp_bucket, _original=original):
            # only the pure-PyTorch contextual path (no compiled RPEIndexFunction) has the frozen-batch view
            if self.mode == "contextual" and getattr(self, "_ctx_rp_bucket_flatten", None) is not None:
                l_query, l_key = rp_bucket.shape
                return x.flatten(2)[:, :, self._ctx_rp_bucket_flatten].view(-1, x.shape[1], l_query, l_key)
            return _original(self, x, rp_bucket)

        cls.forward_rpe_transpose = forward_rpe_transpose
        patched.add(cls)
    return len(patched)


def apply_batch_patch(network, uses_keypoints=True):
    """Patch, and prove in plain PyTorch that the patched network gives the same output as the original on a batch of 3."""
    probe = torch.from_numpy(np.random.default_rng(3).uniform(-1, 1, size=(3, 3, 112, 112)).astype(np.float32))
    wrapper = EmbedderFixedKeypoints(network, False, uses_keypoints).eval()
    with torch.no_grad():
        before = wrapper(probe)[0]
        count = patch_rpe_for_dynamic_batch(network)
        after = wrapper(probe)[0]
    diff = float((before - after).abs().max())
    print(f"Patched {count} RPE class(es) for dynamic batch; max |output change| in PyTorch = {diff:.2e}")
    if count == 0:
        print("Note: no iRPE class with forward_rpe_transpose found - nothing patched.")
    if diff > 1e-5:
        sys.exit("The batch patch changed the model output - refusing to export.")


def check_openvino(out_path, input_names, batches=(1, 4, 8, 16), crops=None):
    """Mimic accel.OpenVINOSession: read the .onnx, reshape EVERY input to each batch bucket, compile on each CPU/GPU device
    OpenVINO can see, compare with onnxruntime. Two precisions per device: f32 (CCTV_PRECISION=f32) and the device default
    (what accel.py uses with CCTV_PRECISION=auto - f16 on an Intel iGPU). `crops` = real crops from _crop_tensors, used
    instead of random noise when given. f32 must match; a weaker default-precision result is a warning, not a failure."""
    try:
        import openvino as ov
    except ImportError:
        print("openvino is not installed - skipped the OpenVINO bucket check (pip install openvino to run it).")
        return True
    import onnxruntime as ort
    session = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    core = ov.Core()
    devices = [d for d in core.available_devices if d.split(".")[0] in ("CPU", "GPU")]
    print("OpenVINO devices: " + ", ".join(f"{d} ({core.get_property(d, 'FULL_DEVICE_NAME')})" for d in devices))
    rng = np.random.default_rng(1)
    ok = True
    for device in devices:
        for precision in ("f32", "default"):
            worst_cos, worst_diff, failed = 1.0, 0.0, False
            for n in batches:
                if crops is not None:
                    x = np.ascontiguousarray(crops[np.arange(n) % len(crops)])
                else:
                    x = rng.uniform(-1, 1, size=(n, 3, 112, 112)).astype(np.float32)
                feeds = {"input": x}
                if "keypoints" in input_names:
                    feeds["keypoints"] = (TEMPLATE_KEYPOINTS + rng.normal(0, 0.01, size=(n, 5, 2))).astype(np.float32)
                try:
                    model = core.read_model(str(out_path))
                    model.reshape({i: ov.PartialShape(list(feeds[name].shape)) for i, name in enumerate(input_names)})
                    config = {"PERFORMANCE_HINT": "LATENCY"}
                    if precision == "f32":
                        config["INFERENCE_PRECISION_HINT"] = "f32"
                    request = core.compile_model(model, device, config).create_infer_request()
                    request.infer({i: feeds[name] for i, name in enumerate(input_names)})
                    got = request.get_output_tensor(0).data.copy()
                except Exception as error:
                    print(f"  OpenVINO {device} {precision:7s} batch {n}: FAILED ({type(error).__name__}: {str(error).splitlines()[0][:200]})")
                    failed = True
                    continue
                expected = session.run(None, feeds)[0]
                worst_diff = max(worst_diff, float(np.abs(got - expected).max()))
                worst_cos = min(worst_cos, float((got * expected).sum(1).min() / 1.0))
            if failed:
                ok = ok and precision != "f32"
                continue
            good = worst_cos >= 0.9999 and worst_diff <= 1e-3 if precision == "f32" else worst_cos >= 0.999
            verdict = "OK" if good else ("PROBLEM" if precision == "f32" else "WARNING - set CCTV_PRECISION=f32 for this model")
            print(f"  OpenVINO {device} {precision:7s}: batches {list(batches)}: min cosine vs onnxruntime = {worst_cos:.6f}, "
                  f"max |diff| = {worst_diff:.2e}  {verdict}")
            if precision == "f32":
                ok = ok and good
    print("OpenVINO bucket check: " + ("OK" if ok else "PROBLEM - see above"))
    return ok


def detect_uses_keypoints(network):
    """KP-RPE models (VisionTransformerWithKPRPE) own a `keypoint_linear` layer and need (image, keypoints); the plain
    IR-ResNet / ViT models in the same family take the image only."""
    return any(hasattr(module, "keypoint_linear") for module in network.modules())


def _load_bgr_112(path):
    """An image file -> 112x112 BGR uint8 (None if unreadable). Use already-aligned face crops for a meaningful test."""
    try:
        import cv2
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        return None if image is None else cv2.resize(image, (112, 112), interpolation=cv2.INTER_AREA)
    except ImportError:
        try:
            from PIL import Image
            image = Image.open(path).convert("RGB").resize((112, 112), Image.BILINEAR)
            return np.asarray(image)[:, :, ::-1].copy()
        except Exception:
            return None


def _crop_tensors(folder, limit=16):
    """Real face crops from `folder` -> float32 (N, 3, 112, 112): BGR, (x/255 - 0.5)/0.5 - exactly what recognize.py sends.
    None when the folder has no readable image."""
    suffixes = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    files = sorted(p for p in Path(folder).rglob("*") if p.suffix.lower() in suffixes)[:limit]
    crops = [c for c in (_load_bgr_112(p) for p in files) if c is not None]
    if not crops:
        return None
    batch = np.stack(crops).astype(np.float32)
    return np.ascontiguousarray(((batch / 255.0 - 0.5) / 0.5).transpose(0, 3, 1, 2))


def verify_images(model, input_names, out_path, folder, static_batch=0, limit=16):
    """
    Checks on REAL face crops (random noise barely exercises the attention layers):
      1. wrapper vs ONNX Runtime            - the export itself is faithful
      2. GOLDEN: raw network vs ONNX        - the raw CVLface network fed an RGB tensor made with plain numpy (no wrapper, no
                                              in-graph flip) must give the same embedding as the ONNX fed BGR. Check 1 cannot
                                              catch a wrong channel order or normalisation because both sides share the wrapper.
      3. the feature norm's range on these crops (its scale differs from IR-101's: matters for min_norm and pooling weights)
      4. (KP-RPE) how much the embedding moves when the keypoints are noisy - a feel for how much real, noisy landmarks
         from tiny CCTV faces could hurt compared with the fixed template
    """
    import onnxruntime as ort
    tensors = _crop_tensors(folder, limit)
    if tensors is None:
        print(f"--verify-dir: no readable images in {folder}; skipped the real-image check.")
        return True
    chunk = static_batch or len(tensors)
    if len(tensors) < chunk:
        print(f"--verify-dir: only {len(tensors)} readable crops, fewer than the fixed batch {chunk}; skipped the real-image check.")
        return True
    tensors = tensors[: (len(tensors) // chunk) * chunk]
    session = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(5)
    worst_cos, worst_norm, worst_golden = 1.0, 0.0, 1.0
    all_norms = []
    for start in range(0, len(tensors) - chunk + 1, chunk):
        x = tensors[start:start + chunk]
        feeds = {"input": x}
        if "keypoints" in input_names:   # slightly different landmarks per face, so the keypoint path is really exercised
            feeds["keypoints"] = (TEMPLATE_KEYPOINTS + rng.normal(0, 0.01, size=(len(x), 5, 2))).astype(np.float32)
        with torch.no_grad():
            want_emb, want_norm = (t.numpy() for t in model(*[torch.from_numpy(feeds[n]) for n in input_names]))
            rgb = torch.from_numpy(np.ascontiguousarray(x[:, ::-1]))          # BGR -> RGB by flipping the channel axis in numpy
            if model.uses_keypoints:
                kp = feeds.get("keypoints")
                if kp is None:
                    kp = np.repeat(TEMPLATE_KEYPOINTS[None], len(x), axis=0)
                ref = model.network(rgb, torch.from_numpy(kp))
            else:
                ref = model.network(rgb)
            ref = ref[0] if isinstance(ref, (tuple, list)) else ref
            ref = (ref / ref.norm(dim=1, keepdim=True).clamp_min(1e-9)).numpy()
        got_emb, got_norm = session.run(None, feeds)
        worst_cos = min(worst_cos, float(((want_emb * got_emb).sum(1)).min()))
        worst_norm = max(worst_norm, float((np.abs(want_norm - got_norm) / np.maximum(np.abs(want_norm), 1e-9)).max()))
        worst_golden = min(worst_golden, float((ref * got_emb).sum(1).min()))
        all_norms.append(got_norm.reshape(-1))
    print(f"Real-image check ({len(tensors)} crops from {folder}): min cosine = {worst_cos:.6f}, "
          f"max relative norm diff = {worst_norm:.2e}")
    print(f"Golden check (raw network, RGB tensor, no wrapper) vs ONNX: min cosine = {worst_golden:.6f}"
          + ("" if worst_golden >= 0.9999 else "   <-- channel order / normalisation / keypoints are NOT what the model expects"))
    norms = np.concatenate(all_norms)
    print(f"Feature norm on these crops: min {norms.min():.2f}, median {np.median(norms):.2f}, max {norms.max():.2f} "
          f"(recognize.py's min_norm and pooling weights use this scale; IR-101's is different)")

    if "keypoints" in input_names:
        def embed_all(keypoints):
            out = []
            for start in range(0, len(tensors) - chunk + 1, chunk):
                out.append(session.run(None, {"input": tensors[start:start + chunk],
                                              "keypoints": keypoints[start:start + chunk].astype(np.float32)})[0])
            return np.concatenate(out)
        template = np.repeat(TEMPLATE_KEYPOINTS[None], len(tensors), axis=0)
        clean = embed_all(template)
        noise_rng = np.random.default_rng(11)
        print("Keypoint sensitivity (cosine between the embedding with the clean template and with noisy keypoints):")
        for sigma in (0.01, 0.03, 0.06):
            cos = (clean * embed_all(template + noise_rng.normal(0, sigma, size=template.shape))).sum(1)
            print(f"  noise sigma = {sigma:.2f} ({sigma * 112:.1f} px at 112): mean {cos.mean():.4f}, min {cos.min():.4f}")
    return worst_cos >= 0.9999 and worst_norm <= 1e-3 and worst_golden >= 0.9999


def write_sidecar(out_path, repo_dir, keypoints_mode, static_batch, opset, exporter):
    """<model>.onnx.json next to the model: the contract recognize.py / the gallery cache can rely on, plus a SHA-256 so a
    re-export under the same file name is noticed (the gallery cache currently only looks at the file name)."""
    import hashlib
    import json
    digest = hashlib.sha256()
    with open(out_path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    source = Path(repo_dir).resolve().name
    try:
        config = json.loads((Path(repo_dir) / "config.json").read_text(encoding="utf-8"))
        source = str(config.get("_name_or_path") or config.get("name") or source)
    except (OSError, ValueError):
        pass
    lowered = source.lower()
    info = {
        "file": Path(out_path).name,
        "sha256": digest.hexdigest(),
        "source": source,
        "input": {"name": "input", "layout": "NCHW", "size": 112, "color_order": "BGR", "normalisation": "(x/255-0.5)/0.5"},
        "outputs": ["embedding (L2-normalised, 512-d)", "norm (feature norm, [N,1])"],
        "keypoints": keypoints_mode,                      # none | template | input
        "keypoint_coordinates": "(x, y) / 112 inside the aligned 112x112 crop, shape [N, 5, 2]" if keypoints_mode == "input" else None,
        "batch": static_batch or "dynamic",
        "opset": opset, "exporter": exporter, "torch": torch.__version__,
        # name-based guess: only AdaFace-trained models make the feature norm a quality score
        "norm_is_quality_hint": True if "adaface" in lowered else False if "arcface" in lowered else None,
    }
    path = str(out_path) + ".json"
    Path(path).write_text(json.dumps(info, indent=2), encoding="utf-8")
    print(f"Wrote {path} (sha256 {info['sha256'][:12]}...)")

class Embedder(nn.Module):
    """BGR image in -> (unit embedding, feature norm) out. Keypoints are a baked-in constant, or a second input."""

    def __init__(self, network, keypoints_as_input, uses_keypoints=True):
        super().__init__()
        self.network = network
        self.keypoints_as_input = keypoints_as_input
        self.uses_keypoints = uses_keypoints      # False for the plain IR / ViT models that take an image only
        self.register_buffer("template", torch.from_numpy(TEMPLATE_KEYPOINTS), persistent=False)    # [5, 2]
        self.register_buffer("rgb_index", torch.tensor([2, 1, 0], dtype=torch.long), persistent=False)

    def forward(self, x, keypoints=None):
        x = x.index_select(1, self.rgb_index)                    # BGR -> RGB (the model was trained on RGB)
        if self.uses_keypoints:
            if keypoints is None:
                keypoints = self.template.unsqueeze(0).expand(x.shape[0], -1, -1)   # same landmarks for every face in the batch
            feature = self.network(x, keypoints)
        else:
            feature = self.network(x)
        if isinstance(feature, (tuple, list)):                   # be safe if a future version returns extras
            feature = feature[0]
        norm = torch.linalg.vector_norm(feature, dim=1, keepdim=True)
        return feature / norm.clamp_min(1e-9), norm


class EmbedderFixedKeypoints(Embedder):
    """Same, but forward() takes ONLY the image (the ONNX exporter needs a fixed argument list)."""

    def forward(self, x):
        return super().forward(x, None)


def export(network, out_path, opset=17, static_batch=0, keypoints_as_input=False, simplify=False, exporter="legacy",
           uses_keypoints=True):
    """Write `out_path` and return (wrapper module, input names). Separate from main() so it can be tested on its own."""
    scrub_fake_tensors(network)
    model = (Embedder(network, True, uses_keypoints) if keypoints_as_input
             else EmbedderFixedKeypoints(network, False, uses_keypoints)).eval()
    batch = max(static_batch, 1)
    dummy = [torch.randn(batch, 3, 112, 112)]
    input_names = ["input"]
    if keypoints_as_input:
        dummy.append(torch.from_numpy(TEMPLATE_KEYPOINTS).unsqueeze(0).repeat(batch, 1, 1))
        input_names.append("keypoints")
    output_names = ["embedding", "norm"]

    with torch.no_grad():
        model(*dummy)     # one real forward pass first: lazily-built RPE caches get created with real data, not fake tensors

        if exporter == "dynamo":
            batch_dim = torch.export.Dim("batch", min=1)
            dynamic_shapes = None if static_batch else tuple({0: batch_dim} for _ in dummy)
            torch.onnx.export(model, tuple(dummy), str(out_path), dynamo=True, input_names=input_names,
                              output_names=output_names, dynamic_shapes=dynamic_shapes, opset_version=opset,
                              do_constant_folding=True)
        else:
            dynamic_axes = None if static_batch else {name: {0: "batch"} for name in input_names + output_names}
            legacy_kwargs = dict(input_names=input_names, output_names=output_names, dynamic_axes=dynamic_axes,
                                 opset_version=opset, do_constant_folding=True)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")      # the legacy exporter is deprecated in new torch and warns loudly
                try:
                    torch.onnx.export(model, tuple(dummy), str(out_path), dynamo=False, **legacy_kwargs)
                except TypeError:                    # old torch without the `dynamo` argument: it only has the legacy exporter
                    torch.onnx.export(model, tuple(dummy), str(out_path), **legacy_kwargs)

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
    ap.add_argument("--keypoints", choices=["template", "input"], default=None,
                    help="default: 'input' for KP-RPE models (a second 'keypoints' [N,5,2] input; recognize.py chooses real or "
                         "template landmarks at run time with CCTV_KEYPOINTS), nothing for image-only models. "
                         "template: bake the fixed ArcFace landmark template into the graph (image-only file)")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--exporter", choices=["legacy", "dynamo"], default="legacy",
                    help="legacy (default): classic TorchScript exporter, works with this model. "
                         "dynamo: new exporter, fails on this model's RPE cache (FakeTensor error)")
    ap.add_argument("--static-batch", type=int, default=0,
                    help="fix the batch size to N. Default: dynamic batch (needed for recognize.py's OpenVINO batch buckets)")
    ap.add_argument("--simplify", action="store_true", help="run onnxsim afterwards if it is installed")
    ap.add_argument("--verify-dir", help="folder of (ideally already aligned 112x112) face crops: also compare PyTorch and ONNX on "
                                         "these real images, not only on random noise")
    args = ap.parse_args()

    network = load_model(args.repo_dir, args.weights)
    uses_keypoints = detect_uses_keypoints(network)
    if args.keypoints and not uses_keypoints:
        sys.exit("--keypoints only makes sense for KP-RPE models; this model takes an image only.")
    print(f"Model type: {'KP-RPE (image + keypoints)' if uses_keypoints else 'image only (no keypoints)'}")
    apply_batch_patch(network, uses_keypoints)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    keypoints_mode = "none" if not uses_keypoints else (args.keypoints or "input")
    keypoints_as_input = keypoints_mode == "input"
    last = {}

    def build(static_batch):
        """Export + verify once. Returns (ok, input_names)."""
        model, input_names = export(network, args.out, args.opset, static_batch, keypoints_as_input, args.simplify,
                                    args.exporter, uses_keypoints)
        last["model"], last["input_names"] = model, input_names
        out_dir = os.path.dirname(os.path.abspath(args.out))
        size_mb = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir)
                      if f.startswith(os.path.basename(args.out))) / 1048576
        print(f"Wrote {args.out}  ({size_mb:.0f} MB, batch {'fixed ' + str(static_batch) if static_batch else 'dynamic'}, "
              f"inputs {input_names})")
        try:
            return verify(model, input_names, args.out, static_batch), input_names
        except Exception as error:      # e.g. onnxruntime refusing to run the graph at a batch size it was not traced with
            print(f"ONNX Runtime could not run the exported model: {type(error).__name__}: {str(error).splitlines()[0][:300]}")
            return False, input_names

    static_batch = args.static_batch
    ok, input_names = build(static_batch)
    if not ok and not static_batch:
        # Safety net: if something else in the model still freezes the batch size, fall back to a fixed batch of 1,
        # which recognize.py handles natively (one face per model call; note OpenVINO buckets then cannot be used).
        print("\nDynamic batch still does not work. Re-exporting with a fixed batch of 1 "
              "(recognize.py sends one face per call for such a model).\n")
        static_batch = 1
        ok, input_names = build(static_batch)
    if not ok:
        sys.exit("MISMATCH: the exported model does not reproduce the PyTorch output. Do not use it.")
    if args.verify_dir and not verify_images(last["model"], last["input_names"], args.out, args.verify_dir, static_batch):
        sys.exit("MISMATCH on real images: the exported model does not reproduce the PyTorch output. Do not use it.")
    write_sidecar(args.out, args.repo_dir, keypoints_mode, static_batch, args.opset, args.exporter)
    if not static_batch:
        # informational: recognize.py's accel.py reshapes the model to batch buckets 1/4/8/16 (every input, keypoints included)
        check_openvino(args.out, input_names, crops=_crop_tensors(args.verify_dir) if args.verify_dir else None)
    print("OK. Input: float32 [%s,3,112,112], BGR, (pixel/255 - 0.5)/0.5" % (static_batch or "N")
          + (" + keypoints [N,5,2]" if keypoints_as_input else "") + ". Outputs: 512-d L2-normalised embedding, norm [N,1].")
    if keypoints_as_input:
        print("recognize.py: CCTV_KEYPOINTS=detected (default) feeds the real landmarks, CCTV_KEYPOINTS=template feeds the fixed "
              "template - same file, so you can A/B both. Re-calibrate the thresholds for this model either way.")


if __name__ == "__main__":
    main()