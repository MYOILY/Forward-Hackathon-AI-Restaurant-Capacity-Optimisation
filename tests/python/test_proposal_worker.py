"""Spawned setup inference is persistent and cancellable without real weights."""

import asyncio
import os
import time
import numpy as np
import pytest
from processor.live_workers import ProposalWorker


def test_proposal_worker_retains_process_and_receives_actual_frame_pixels(tmp_path):
    async def run():
        worker = ProposalWorker(
            tmp_path, factory="tests.fixtures.live_worker_fakes:FakeProposal"
        )
        first = await worker.propose(np.ones((8, 8, 3), np.uint8))
        second = await worker.propose(np.full((8, 8, 3), 2, np.uint8))
        assert first[0]["label"] == "192" and second[0]["label"] == "384"
        assert (
            first[0]["test_pid"] == second[0]["test_pid"] == worker.pid
            and worker.pid != os.getpid()
        )
        await worker.close()
        assert worker.closed

    asyncio.run(run())


def test_cancelled_proposal_reaps_inflight_spawned_worker(tmp_path):
    async def run():
        worker = ProposalWorker(
            tmp_path, factory="tests.fixtures.live_worker_fakes:SlowProposal"
        )
        pending = asyncio.create_task(worker.propose(np.zeros((8, 8, 3), np.uint8)))
        await asyncio.sleep(0.15)
        started = time.perf_counter()
        await worker.close()
        assert time.perf_counter() - started < 3
        with pytest.raises((RuntimeError, ValueError, asyncio.CancelledError)):
            await pending
        assert worker.closed

    asyncio.run(run())
