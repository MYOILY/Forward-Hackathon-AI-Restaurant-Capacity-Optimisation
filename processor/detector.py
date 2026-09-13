"""Official YOLOX ONNX adapter, independent of the training package.

Reference implementation (Megvii, Apache-2.0):
https://github.com/Megvii-BaseDetection/YOLOX/blob/main/yolox/data/data_augment.py
https://github.com/Megvii-BaseDetection/YOLOX/blob/main/yolox/utils/demo_utils.py
https://github.com/Megvii-BaseDetection/YOLOX/blob/main/demo/ONNXRuntime/onnx_inference.py

This adapter supports the official 0.1.1rc0 raw-head ONNX assets only. In
particular, an export with embedded decoding needs already_decoded=True in
postprocess; it must not be silently used with the default detector.
"""

from __future__ import annotations

from pathlib import Path
from time import perf_counter

import cv2
import numpy as np

MODEL_SPECS = {
    "nano": {"size": (416, 416), "parameters_m": 0.91, "gflops": 1.08},
    "tiny": {"size": (416, 416), "parameters_m": 5.06, "gflops": 6.45},
    "s": {"size": (640, 640), "parameters_m": 9.0, "gflops": 26.8},
}
RELEVANT_CLASSES = (0, 56, 60)


def preprocess(
    frame_bgr: np.ndarray, input_size: tuple[int, int]
) -> tuple[np.ndarray, float]:
    """BGR uint8 -> top-left letterbox CHW float32, with no normalization."""
    if frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3 or frame_bgr.dtype != np.uint8:
        raise ValueError("Expected a nonempty uint8 OpenCV BGR image")
    height, width = frame_bgr.shape[:2]
    target_h, target_w = map(int, input_size)
    if min(height, width, target_h, target_w) <= 0:
        raise ValueError("Image dimensions must be positive")
    ratio = min(target_h / height, target_w / width)
    resized_h, resized_w = int(height * ratio), int(width * ratio)
    if min(resized_h, resized_w) < 1:
        raise ValueError("Image aspect ratio is too extreme for this model input")
    resized = cv2.resize(
        frame_bgr, (resized_w, resized_h), interpolation=cv2.INTER_LINEAR
    )
    padded = np.full((target_h, target_w, 3), 114, dtype=np.uint8)
    padded[:resized_h, :resized_w] = resized
    return np.ascontiguousarray(padded.transpose(2, 0, 1), dtype=np.float32), ratio


def decode_outputs(raw: np.ndarray, input_size: tuple[int, int]) -> np.ndarray:
    """Decode the official raw YOLOX head into centre/size pixels; do not mutate."""
    output = np.asarray(raw, dtype=np.float32).copy()
    if output.ndim != 3 or output.shape[0] != 1 or output.shape[2] != 85:
        raise ValueError(f"Expected YOLOX output [1,N,85], received {output.shape}")
    grids, strides_expanded = [], []
    height, width = input_size
    for stride in (8, 16, 32):
        yy, xx = np.meshgrid(
            np.arange(height // stride), np.arange(width // stride), indexing="ij"
        )
        grid = np.stack((xx, yy), axis=-1).reshape(1, -1, 2)
        grids.append(grid)
        strides_expanded.append(np.full((*grid.shape[:2], 1), stride))
    grid = np.concatenate(grids, axis=1)
    strides = np.concatenate(strides_expanded, axis=1)
    if output.shape[1] != grid.shape[1]:
        raise ValueError(
            f"Model output length {output.shape[1]} does not match input {input_size}"
        )
    with np.errstate(over="ignore", invalid="ignore"):
        output[..., :2] = (output[..., :2] + grid) * strides
        output[..., 2:4] = np.exp(output[..., 2:4]) * strides
    return output


def nms(
    boxes: np.ndarray, scores: np.ndarray, iou_threshold: float = 0.45
) -> list[int]:
    """Class-local NMS in source/model pixel XYXY, matching upstream +1 areas."""
    if not 0 <= iou_threshold <= 1:
        raise ValueError("NMS threshold must lie in [0,1]")
    boxes = np.asarray(boxes, dtype=np.float32)
    scores = np.asarray(scores, dtype=np.float32)
    if len(boxes) == 0:
        return []
    if boxes.ndim != 2 or boxes.shape[1] != 4 or scores.shape != (len(boxes),):
        raise ValueError("Expected boxes [N,4] and scores [N]")
    if not np.isfinite(boxes).all() or not np.isfinite(scores).all():
        raise ValueError("NMS inputs must be finite")
    x1, y1, x2, y2 = boxes.T
    areas = np.maximum(0, x2 - x1 + 1) * np.maximum(0, y2 - y1 + 1)
    order = np.argsort(-scores, kind="stable")
    keep: list[int] = []
    while order.size:
        index = int(order[0])
        keep.append(index)
        following = order[1:]
        xx1, yy1 = np.maximum(x1[index], x1[following]), np.maximum(
            y1[index], y1[following]
        )
        xx2, yy2 = np.minimum(x2[index], x2[following]), np.minimum(
            y2[index], y2[following]
        )
        intersection = np.maximum(0, xx2 - xx1 + 1) * np.maximum(0, yy2 - yy1 + 1)
        union = areas[index] + areas[following] - intersection
        overlap = np.divide(
            intersection, union, out=np.zeros_like(intersection), where=union > 0
        )
        order = following[overlap <= iou_threshold]
    return keep


def postprocess(
    raw: np.ndarray,
    original_shape: tuple[int, int],
    input_size: tuple[int, int],
    score_threshold: float = 0.3,
    nms_threshold: float = 0.45,
    class_ids: tuple[int, ...] = RELEVANT_CLASSES,
    already_decoded: bool = False,
) -> list[dict]:
    """Return relevant detections with normalized original-image XYXY boxes."""
    if not 0 < score_threshold <= 1:
        raise ValueError("Score threshold must lie in (0,1]")
    if not 0 <= nms_threshold <= 1:
        raise ValueError("NMS threshold must lie in [0,1]")
    height, width = original_shape[:2]
    if min(height, width) <= 0:
        raise ValueError("Invalid original image dimensions")
    predictions = (
        np.asarray(raw, dtype=np.float32).copy()
        if already_decoded
        else decode_outputs(raw, input_size)
    )
    if predictions.ndim != 3 or predictions.shape[0] != 1 or predictions.shape[2] != 85:
        raise ValueError("Expected YOLOX output [1,N,85]")
    predictions = predictions[0]
    if not np.isfinite(predictions).all():
        raise ValueError(
            "Nonfinite model output cannot be interpreted as a vacant frame"
        )
    ratio = min(input_size[0] / height, input_size[1] / width)
    centre, size = predictions[:, :2], predictions[:, 2:4]
    boxes = np.concatenate((centre - size / 2, centre + size / 2), axis=1) / ratio
    scores = predictions[:, 4:5] * predictions[:, 5:]
    # Each anchor retains its best category. Otherwise an irrelevant high-score
    # object could acquire a second, lower person label after category filtering.
    best_class = scores.argmax(axis=1)
    best_score = scores[np.arange(len(scores)), best_class]
    finite_size = (boxes[:, 2] > boxes[:, 0]) & (boxes[:, 3] > boxes[:, 1])
    result = []
    for class_id in class_ids:
        if not isinstance(class_id, int) or not 0 <= class_id < 80:
            raise ValueError("Invalid COCO class index")
        selected = np.flatnonzero(
            (best_class == class_id) & (best_score >= score_threshold) & finite_size
        )
        for local_index in nms(boxes[selected], best_score[selected], nms_threshold):
            index = int(selected[local_index])
            box = boxes[index].copy()
            box[[0, 2]] = np.clip(box[[0, 2]], 0, width) / width
            box[[1, 3]] = np.clip(box[[1, 3]], 0, height) / height
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            result.append(
                {
                    "class_id": int(class_id),
                    "score": float(best_score[index]),
                    "box": [float(value) for value in box],
                }
            )
    return sorted(
        result, key=lambda detection: (-detection["score"], detection["class_id"])
    )


class YOLOXDetector:
    """One CPU session per process. Timings in last_timing are seconds."""

    def __init__(
        self,
        model: str = "tiny",
        model_dir: str | Path = "models",
        score_threshold: float = 0.3,
        nms_threshold: float = 0.45,
        intra_threads: int = 4,
        model_path: str | Path | None = None,
        class_ids: tuple[int, ...] = RELEVANT_CLASSES,
    ):
        setup_started = perf_counter()
        if model not in MODEL_SPECS:
            raise ValueError(f"Unknown model {model}; choose nano, tiny, or s")
        if intra_threads < 1:
            raise ValueError("intra_threads must be positive")
        if not 0 < score_threshold <= 1 or not 0 <= nms_threshold <= 1:
            raise ValueError("Invalid detection/NMS thresholds")
        import_started = perf_counter()
        import onnxruntime as ort

        runtime_import_s = perf_counter() - import_started

        from .models import verify_model

        cv2.setNumThreads(1)
        self.model = model
        self.input_size = MODEL_SPECS[model]["size"]
        self.path = (
            Path(model_path) if model_path else Path(model_dir) / f"yolox_{model}.onnx"
        )
        if not self.path.is_file():
            raise FileNotFoundError(
                f"Model missing: {self.path}. Run python -m processor download-model --model {model} --model-dir {model_dir}"
            )
        verify_started = perf_counter()
        self.sha256 = verify_model(self.path, model)
        model_verify_s = perf_counter() - verify_started
        options = ort.SessionOptions()
        options.intra_op_num_threads = intra_threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        session_started = perf_counter()
        self.session = ort.InferenceSession(
            str(self.path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        session_load_s = perf_counter() - session_started
        inputs = self.session.get_inputs()
        expected_input = [1, 3, *self.input_size]
        if (
            len(inputs) != 1
            or inputs[0].type != "tensor(float)"
            or inputs[0].shape != expected_input
        ):
            raise ValueError(
                f"Unsupported {model} ONNX input: expected float32 {expected_input}"
            )
        outputs = self.session.get_outputs()
        expected_count = sum(
            (self.input_size[0] // stride) * (self.input_size[1] // stride)
            for stride in (8, 16, 32)
        )
        if len(outputs) != 1 or outputs[0].shape != [1, expected_count, 85]:
            raise ValueError(
                f"Unsupported YOLOX ONNX output; expected [1,{expected_count},85]"
            )
        self.input_name = inputs[0].name
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        if not class_ids or any(
            type(value) is not int or not 0 <= value < 80 for value in class_ids
        ):
            raise ValueError("Invalid requested detection classes")
        self.class_ids = tuple(class_ids)
        self.last_timing = {"preprocess": 0.0, "inference": 0.0, "postprocess": 0.0}
        self.startup_timing = {
            "runtime_import": runtime_import_s,
            "model_verify": model_verify_s,
            "session_load": session_load_s,
            "detector_setup": perf_counter() - setup_started,
        }

    def detect(self, frame_bgr: np.ndarray) -> list[dict]:
        self.last_timing = {"preprocess": 0.0, "inference": 0.0, "postprocess": 0.0}
        start = perf_counter()
        tensor, _ = preprocess(frame_bgr, self.input_size)
        self.last_timing["preprocess"] = perf_counter() - start
        start = perf_counter()
        try:
            output = self.session.run(None, {self.input_name: tensor[None]})[0]
        finally:
            self.last_timing["inference"] = perf_counter() - start
        start = perf_counter()
        try:
            return postprocess(
                output,
                frame_bgr.shape[:2],
                self.input_size,
                self.score_threshold,
                self.nms_threshold,
                self.class_ids,
            )
        finally:
            self.last_timing["postprocess"] = perf_counter() - start
