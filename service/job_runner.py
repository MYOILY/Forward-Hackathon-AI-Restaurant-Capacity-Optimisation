"""JSONL progress adapter around the unchanged processor CLI argument contract."""

import json
import sys
from processor.__main__ import parser
from processor.pipeline import analyze, prepare


def progress(phase, fraction, details=None):
    print(
        json.dumps(
            {
                "type": "progress",
                "phase": phase,
                "fraction": fraction,
                "details": details or {},
            },
            allow_nan=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    args = parser().parse_args()
    if args.command == "analyze" and args.sample_hz is None:
        args.sample_hz = 10.0
    try:
        result = (prepare if args.command == "prepare" else analyze)(
            args, progress=progress
        )
        print(
            json.dumps({"type": "completed", "result": result}, allow_nan=False),
            flush=True,
        )
        if args.command == "analyze" and result.get("valid_samples") == 0:
            raise ValueError(
                "All analyzed frames failed; inspect the exported uncertainty evidence."
            )
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
