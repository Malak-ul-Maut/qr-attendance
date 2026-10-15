"""
accel.py - optional OpenVINO backend for the two face models (SCRFD detector + AdaFace recognizer).

Why: onnxruntime on the CPU is the slowest way to run these models on an Intel laptop. OpenVINO runs the SAME
.onnx files (no conversion step) on the CPU, on the integrated GPU, or on whichever is available ("AUTO"):
  * Sparsh / Yash laptops (Intel Iris Xe / Intel Graphics)  -> AUTO picks the iGPU
  * a PC with no usable iGPU (e.g. the old i3-380M)         -> AUTO falls back to the CPU
  * openvino not installed, or it fails to start            -> the old onnxruntime path, unchanged

Setup:  pip install openvino          (nothing else; onnxruntime stays installed as the fallback)

Settings (environment variables, all optional):
    CCTV_BACKEND      auto (default) | openvino | onnxruntime
                      auto = try OpenVINO, silently fall back to onnxruntime if it is missing or fails.
                      openvino = same, but a failure stops the service (so a broken setup is noticed).
    CCTV_DEVICE       AUTO (default) | GPU | CPU | AUTO:GPU,CPU | MULTI:GPU,CPU ...  (any OpenVINO device string)
    CCTV_PRECISION    auto (default) | f32 | f16.  auto = OpenVINO's own choice: f16 on the iGPU, f32 on the CPU.
                      Embeddings in f16 differ from f32 in the 3rd decimal; run scripts/check_backend.py to see it.
    CCTV_OV_BATCHES   recognizer batch sizes that get compiled, default "1,4,8,16" (a batch is padded up to the
                      next size; each size is compiled once and cached on disk).
    CCTV_OV_CACHE     folder for OpenVINO's compiled-model cache, default backend/cache/openvino. The first start
                      on an iGPU compiles each model (tens of seconds); later starts load the cache in ~1 s.

How it plugs in: OpenVINOSession has the small slice of the onnxruntime InferenceSession interface that
recognize.py and insightface use (get_inputs, get_outputs, run, set_providers), so the rest of the code does not
know which engine is underneath.
"""
import os
import threading
from pathlib import Path

import numpy as np

DEFAULT_BATCHES = (1, 4, 8, 16)


# ------------------------------------------------------------------ settings
def backend_mode():
    mode = os.environ.get("CCTV_BACKEND", "auto").strip().lower()
    return mode if mode in ("auto", "openvino", "onnxruntime") else "auto"


def device_setting():
    return os.environ.get("CCTV_DEVICE", "AUTO").strip() or "AUTO"


def precision_setting():
    value = os.environ.get("CCTV_PRECISION", "auto").strip().lower()
    return value if value in ("f32", "f16") else "auto"


def batch_buckets():
    sizes = set()
    for part in os.environ.get("CCTV_OV_BATCHES", "").replace(";", ",").split(","):
        if part.strip().isdigit() and int(part) > 0:
            sizes.add(int(part))
    return tuple(sorted(sizes)) or DEFAULT_BATCHES


def cache_dir(default_parent):
    return Path(os.environ.get("CCTV_OV_CACHE") or Path(default_parent) / "cache" / "openvino")


def wants_openvino():
    return backend_mode() in ("auto", "openvino")


# ----------------------------------------------------------------- the wrapper
class _Port:
    """Looks like onnxruntime's NodeArg: .name and .shape (ints, or a string for a dynamic dimension)."""

    def __init__(self, name, shape):
        self.name = name
        self.shape = shape


def _port_name(port, fallback):
    try:
        return port.get_any_name()
    except Exception:   # a tensor without a name
        return fallback


def _port_shape(port):
    shape = port.get_partial_shape()
    return [int(dim.get_length()) if dim.is_static else "?" for dim in shape]


class OpenVINOSession:
    """
    An onnxruntime-InferenceSession look-alike backed by OpenVINO, for models with ONE input.

    OpenVINO compiles a model for fixed tensor shapes (fastest, and the only good option on the iGPU), while
    onnxruntime accepts any shape per call. So every distinct input shape is compiled the first time it is seen
    and remembered. To keep that to a handful of shapes:
      * a dynamic BATCH dimension (the recognizer) is padded up to the next size in `batches`;
      * other dynamic dimensions (the detector's height/width) simply get one compile per image size - in
        practice two: the CCTV frame size and the 640x640 gallery-photo size.
    """

    def __init__(self, onnx_path, device="AUTO", cache=None, precision="auto", batches=DEFAULT_BATCHES, log=print):
        import openvino as ov   # imported here so a missing package only matters when OpenVINO is wanted
        self._ov = ov
        self.log = log
        self.device = device
        self.precision = precision
        self.batches = tuple(sorted(batches))
        self.core = ov.Core()
        if cache:
            Path(cache).mkdir(parents=True, exist_ok=True)
            self.core.set_property({"CACHE_DIR": str(cache)})
        self.model_file = str(onnx_path)
        self._model = self.core.read_model(self.model_file)
        if len(self._model.inputs) != 1:
            raise ValueError(f"{Path(onnx_path).name}: OpenVINOSession supports single-input models only")
        self._inputs = [_Port(_port_name(p, f"input{i}"), _port_shape(p)) for i, p in enumerate(self._model.inputs)]
        self._outputs = [_Port(_port_name(p, f"output{i}"), _port_shape(p)) for i, p in enumerate(self._model.outputs)]
        first = self._inputs[0].shape[0]
        self.dynamic_batch = not (isinstance(first, int) and first > 0)
        self._compiled = {}          # input shape tuple -> (compiled model, infer request)
        self._lock = threading.Lock()

    # --- the onnxruntime-style surface -------------------------------------------------------------
    def get_inputs(self):
        return self._inputs

    def get_outputs(self):
        return self._outputs

    def set_providers(self, *_args, **_kwargs):
        """insightface calls this (CPU only) from detector.prepare(); the device is chosen by CCTV_DEVICE here instead."""

    def run(self, output_names, input_feed, run_options=None):
        (array,) = input_feed.values()
        array = np.ascontiguousarray(array, dtype=np.float32)
        count = array.shape[0]
        padded = array
        if self.dynamic_batch:
            target = self.bucket_for(count)
            if target > count:
                padded = np.concatenate([array, np.repeat(array[-1:], target - count, axis=0)])
        with self._lock:
            _, request = self._get(tuple(padded.shape))
            request.infer({0: padded})
            outputs = [request.get_output_tensor(i).data.copy() for i in range(len(self._outputs))]
        if padded.shape[0] != count:
            outputs = [out[:count] if out.ndim and out.shape[0] == padded.shape[0] else out for out in outputs]
        return outputs

    # --- internals ----------------------------------------------------------------------------------
    def bucket_for(self, count):
        for size in self.batches:
            if size >= count:
                return size
        return count   # bigger than every bucket: compile that exact size once

    def compile_shape(self, shape):
        """Compile (and cache on disk) the model for this exact input shape now, instead of on first use."""
        with self._lock:
            self._get(tuple(shape))

    def _get(self, shape):
        entry = self._compiled.get(shape)
        if entry is None:
            entry = self._compiled[shape] = self._compile(shape)
        return entry

    def _compile(self, shape):
        ov = self._ov
        try:
            model = self._model.clone()
        except AttributeError:   # older OpenVINO without Model.clone(): read the file again
            model = self.core.read_model(self.model_file)
        model.reshape(ov.PartialShape(list(shape)))
        config = {"PERFORMANCE_HINT": "LATENCY"}
        if self.precision in ("f32", "f16"):
            config["INFERENCE_PRECISION_HINT"] = self.precision
        try:
            compiled = self.core.compile_model(model, self.device, config)
        except Exception as error:
            if len(config) == 1:
                raise
            self.log(f"  openvino: {self.precision} precision hint refused ({error}); using the device default")
            compiled = self.core.compile_model(model, self.device, {"PERFORMANCE_HINT": "LATENCY"})
        return compiled, compiled.create_infer_request()

    # --- reporting ----------------------------------------------------------------------------------
    def execution_devices(self):
        """Devices that actually run the compiled models, e.g. ['GPU.0']. With AUTO this can change a few seconds
        after startup (the CPU answers while the iGPU is still compiling)."""
        found = []
        for compiled, _ in self._compiled.values():
            try:
                found.extend(str(d) for d in compiled.get_property("EXECUTION_DEVICES"))
            except Exception:
                pass
        return sorted(set(found))

    def device_names(self):
        names = []
        for device in self.execution_devices():
            try:
                names.append(f"{device} ({self.core.get_property(device.split('.')[0], 'FULL_DEVICE_NAME')})")
            except Exception:
                names.append(device)
        return names


def openvino_version():
    try:
        import openvino as ov
        return getattr(ov, "__version__", "?")
    except Exception:
        return None
