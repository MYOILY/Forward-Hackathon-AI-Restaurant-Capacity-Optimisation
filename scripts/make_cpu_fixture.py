"""Create a 20-second static AI-image clip for repeatable CPU integration checks."""

import argparse
from pathlib import Path
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New MP4 file, normally under /tmp")
    args = parser.parse_args()
    source = (
        Path(__file__).resolve().parents[1]
        / "tests/fixtures/surface/ai-t1-reference.png"
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-n",
            "-loop",
            "1",
            "-i",
            str(source),
            "-t",
            "20",
            "-r",
            "10",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(args.output),
        ],
        check=True,
    )
    print(
        "Created static AI-image integration input; this is not physical-camera or restaurant accuracy evidence."
    )


if __name__ == "__main__":
    main()
