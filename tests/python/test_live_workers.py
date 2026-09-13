"""Real spawn/RPC tests with explicit fake inference, bounded lifetime and RAM images."""

import asyncio
import os
import time
import numpy as np
import pytest
from processor.live_workers import VisionWorker, SurfaceWorker


def test_vision_worker_persists_process_and_source_frame_bytes():
    async def run():
        worker = VisionWorker(
            {"tables": [{"id": "T1"}]},
            factory="tests.fixtures.live_worker_fakes:FakeVision",
        )
        frame = np.full((8, 8, 3), 7, np.uint8)
        first = await worker.process_frame(frame, 1.2, 12)
        second = await worker.process_frame(frame, 1.3, 13)
        assert (
            first["test_pid"] == second["test_pid"] == worker.pid
            and worker.pid != os.getpid()
        )
        assert first["pixel_sum"] == 1344 and second["observation"]["t"] == 1.3
        await worker.set_tables([{"id": "T2"}])
        assert (await worker.process_frame(frame, 1.4, 14))["observation"][
            "tables"
        ] == {"T2": "absent"}
        await worker.close()
        assert worker.closed
        with pytest.raises((RuntimeError, ValueError)):
            await worker.process_frame(frame, 1.5, 15)

    asyncio.run(run())


def test_close_terminates_inflight_work_without_waiting_for_model_delay():
    async def run():
        worker = VisionWorker(
            {"test_delay": 10}, factory="tests.fixtures.live_worker_fakes:FakeVision"
        )
        pending = asyncio.create_task(
            worker.process_frame(np.zeros((8, 8, 3), np.uint8), 0, 0)
        )
        await asyncio.sleep(0.15)
        started = time.perf_counter()
        await worker.close()
        assert time.perf_counter() - started < 3
        with pytest.raises((RuntimeError, ValueError, asyncio.CancelledError)):
            await pending
        assert worker.closed

    asyncio.run(run())


def test_surface_worker_accepts_ram_images_and_writes_no_crop_files(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)

    async def run():
        worker = SurfaceWorker(
            tmp_path, factory="tests.fixtures.live_worker_fakes:FakeSurface"
        )
        first = np.full((8, 8, 3), 150, np.uint8)
        other = np.zeros((8, 8, 3), np.uint8)
        assert (await worker.assess(first, first))["outcome"] == "cleared_reset"
        assert (await worker.assess(first, other))["outcome"] == "not_reset"
        await worker.close()
        assert worker.closed

    asyncio.run(run())
    assert list(tmp_path.iterdir()) == []
