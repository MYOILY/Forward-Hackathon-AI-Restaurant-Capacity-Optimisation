"""Run one gateway worker with a bounded camera transport."""

import os
import uvicorn


def main():
    frame_bytes = int(os.getenv("TABLEWATCH_FRAME_BYTES", str(2 * 1024 * 1024)))
    if frame_bytes < 1:
        raise ValueError("TABLEWATCH_FRAME_BYTES must be positive")
    uvicorn.run(
        "service.app:app",
        host=os.getenv("TABLEWATCH_API_HOST", "127.0.0.1"),
        port=int(os.getenv("TABLEWATCH_API_PORT", "8000")),
        workers=1,
        ws_max_size=2 * frame_bytes + 65536,
    )


if __name__ == "__main__":
    main()
