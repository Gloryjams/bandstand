import asyncio

from server.api import events


def test_publish_excludes_originating_client():
    # A device's own write must not be echoed back to it, but every other device
    # subscriber should be notified.
    events._subscribers.clear()
    qa: asyncio.Queue = asyncio.Queue(maxsize=8)
    qb: asyncio.Queue = asyncio.Queue(maxsize=8)
    events._subscribers.append(("A", qa))
    events._subscribers.append(("B", qb))
    try:
        events.publish("data_changed", exclude_client="A")
        assert qa.empty()
        assert qb.qsize() == 1
        assert qb.get_nowait()["type"] == "data_changed"
    finally:
        events._subscribers.clear()


def test_publish_without_exclude_reaches_all():
    events._subscribers.clear()
    qa: asyncio.Queue = asyncio.Queue(maxsize=8)
    events._subscribers.append((None, qa))
    try:
        events.publish("piece_changed", path="x.pdf")
        assert qa.qsize() == 1
        msg = qa.get_nowait()
        assert msg["type"] == "piece_changed" and msg["path"] == "x.pdf"
    finally:
        events._subscribers.clear()


async def test_publish_from_thread_delivers_via_loop_bridge():
    # When a stream has set the loop, publish() must marshal onto it (thread-safe),
    # not touch the asyncio.Queue from the foreign thread. Simulate the cross-thread
    # call from a worker thread and confirm the loop-thread fan-out delivers it.
    events._subscribers.clear()
    events._loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=8)
    events._subscribers.append(("X", q))
    try:
        await asyncio.to_thread(events.publish, "data_changed")
        await asyncio.sleep(0.05)  # let the call_soon_threadsafe callback run
        assert q.qsize() == 1
        assert q.get_nowait()["type"] == "data_changed"
    finally:
        events._subscribers.clear()
        events._loop = None
