"""Exercise the real OS process tree, without model calls or authentication."""
import asyncio
import sys
import time
import pytest
from app.llm.cli import ProcessRunner


def test_cancel_waits_until_parent_and_child_stop(tmp_path):
    parent=tmp_path/'parent';child=tmp_path/'child'
    worker="import pathlib,time,sys; p=pathlib.Path(sys.argv[1]); deadline=time.time()+15\nwhile time.time()<deadline: p.write_text(str(time.time_ns())); time.sleep(.04)"
    script="import subprocess,sys; subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[3]]); exec(sys.argv[1].replace('sys.argv[1]', 'sys.argv[2]'))"
    async def scenario():
        task=asyncio.create_task(ProcessRunner().run([sys.executable,'-c',script,worker,str(parent),str(child)],str(tmp_path)))
        deadline=time.monotonic()+5
        try:
            while not (parent.exists() and child.exists()):
                assert time.monotonic()<deadline,'process tree did not start'
                await asyncio.sleep(.02)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):await task
            stamps=[path.stat().st_mtime_ns for path in (parent,child)]
            await asyncio.sleep(.3)
            assert stamps==[path.stat().st_mtime_ns for path in (parent,child)]
        finally:
            if not task.done():
                task.cancel()
                try:await task
                except asyncio.CancelledError:pass
    asyncio.run(scenario())
