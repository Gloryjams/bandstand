"""One data folder, one server."""
import asyncio
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from server import config, instance_lock, serve

REPO = Path(__file__).parent.parent.parent


def test_the_second_taker_is_refused_and_told_why(tmp_path):
    first = instance_lock.acquire(tmp_path)
    try:
        with pytest.raises(instance_lock.DataFolderInUse) as err:
            instance_lock.acquire(tmp_path)
        assert str(tmp_path) in str(err.value)
        assert "BANDSTAND_DATA_DIR" in str(err.value)
    finally:
        instance_lock.release(first)


def test_the_folder_is_free_again_after_release(tmp_path):
    instance_lock.release(instance_lock.acquire(tmp_path))
    again = instance_lock.acquire(tmp_path)
    assert again is not None
    instance_lock.release(again)


def test_two_different_folders_never_block_each_other(tmp_path):
    a = instance_lock.acquire(tmp_path / "band-a")
    b = instance_lock.acquire(tmp_path / "band-b")
    assert a is not None and b is not None
    instance_lock.release(a)
    instance_lock.release(b)


def test_a_crashed_server_leaves_nothing_behind(tmp_path):
    # The lock belongs to the process, not to the file: when the holder dies without
    # cleaning up, the folder is free. A leftover file must never lock anybody out.
    holder = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(f"""
            import os
            from pathlib import Path
            from server import instance_lock
            assert instance_lock.acquire(Path({str(tmp_path)!r})) is not None
            os._exit(9)  # no cleanup of any kind
        """)],
        cwd=REPO, check=False,
    )
    assert holder.returncode == 9
    assert (tmp_path / instance_lock.LOCK_NAME).exists()
    handle = instance_lock.acquire(tmp_path)
    assert handle is not None
    instance_lock.release(handle)


def test_a_running_server_in_another_process_blocks_this_one(tmp_path):
    holder = subprocess.Popen(
        [sys.executable, "-c", textwrap.dedent(f"""
            import sys, time
            from pathlib import Path
            from server import instance_lock
            handle = instance_lock.acquire(Path({str(tmp_path)!r}))
            print("held", flush=True)
            sys.stdin.read()
        """)],
        cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "held"
        with pytest.raises(instance_lock.DataFolderInUse):
            instance_lock.acquire(tmp_path)
    finally:
        holder.communicate(input="", timeout=10)
    instance_lock.release(instance_lock.acquire(tmp_path))


def test_the_app_holds_its_folder_for_as_long_as_it_runs(tmp_data_dir):
    from server.main import build_app, lifespan

    async def scenario():
        app = build_app()
        async with lifespan(app):
            with pytest.raises(instance_lock.DataFolderInUse):
                instance_lock.acquire(tmp_data_dir)
            # A second copy of the app on the same folder does not get to start.
            with pytest.raises(instance_lock.DataFolderInUse):
                async with lifespan(build_app()):
                    pytest.fail("a second server started on a folder that was in use")
        instance_lock.release(instance_lock.acquire(tmp_data_dir))

    asyncio.run(scenario())


def test_the_entry_point_refuses_in_one_sentence(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path / "data"))
    cfg = config.load()
    serve.prepare(cfg, lambda _line: None)
    key = cfg.key_path.read_text().strip()
    started = []
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: started.append(1))
    holder = instance_lock.acquire(cfg.data_dir)
    try:
        assert serve.main() == 1
    finally:
        instance_lock.release(holder)
    err = capsys.readouterr().err
    assert err.startswith("Cannot start: Another Bandstand server is already running")
    assert "Traceback" not in err and key not in err
    assert started == []


@pytest.mark.skipif(os.name != "posix", reason="mode bits are a POSIX concept")
def test_the_lock_file_is_private(tmp_path):
    import stat
    handle = instance_lock.acquire(tmp_path)
    instance_lock.release(handle)
    assert stat.S_IMODE((tmp_path / instance_lock.LOCK_NAME).stat().st_mode) == 0o600
