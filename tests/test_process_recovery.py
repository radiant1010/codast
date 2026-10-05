"""Exercise the real OS process tree, without model calls or authentication."""
import asyncio
import sys
import time
import threading
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


@pytest.mark.parametrize('overlap', ['runner', 'cancel', 'shutdown'])
def test_repeated_cancel_keeps_run_active_until_process_tree_stops(tmp_path, overlap):
    from app.main import create_app
    from app.models.schemas import AgentResult, Command

    parent, child = tmp_path/'parent', tmp_path/'child'
    stopping, release, stopped = threading.Event(), threading.Event(), threading.Event()
    worker = "import pathlib,time,sys; p=pathlib.Path(sys.argv[1]); deadline=time.time()+15\nwhile time.time()<deadline: p.write_text(str(time.time_ns())); time.sleep(.04)"
    script = "import subprocess,sys; subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[3]]); exec(sys.argv[1].replace('sys.argv[1]', 'sys.argv[2]'))"

    class DelayedStopRunner(ProcessRunner):
        def kill(self, process):
            stopping.set()
            release.wait(5)
            super().kill(process)

        def _run(self, *args):
            try:
                return super()._run(*args)
            finally:
                stopped.set()

    runner = DelayedStopRunner()

    class LocalProcessAgent:
        async def run(self, context):
            await runner.run([sys.executable,'-c',script,worker,str(parent),str(child)], str(tmp_path))
            return AgentResult(adapter='mock', output='done')

    async def until(predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(.01)
        await asyncio.wait_for(poll(), 5)

    async def scenario():
        loop = asyncio.get_running_loop()
        unhandled = []
        loop.set_exception_handler(lambda _, context: unhandled.append(context))
        service = create_app(tmp_path/'ws', LocalProcessAgent()).state.harness
        service.projects.create('one')
        service.projects.create('two')
        waiters = []
        if overlap == 'runner':
            task = asyncio.create_task(LocalProcessAgent().run(None))
            run_id = None
        else:
            run_id = service.submit('one', Command(text='run', task='work'))
            task = service.active[run_id]
        try:
            await until(lambda: parent.exists() and child.exists())
            if overlap == 'runner':
                task.cancel()
            else:
                waiters.append(asyncio.create_task(service.cancel('one', run_id)))
            await until(stopping.is_set)
            if overlap == 'runner':
                task.cancel()
            elif overlap == 'cancel':
                waiters.append(asyncio.create_task(service.cancel('one', run_id)))
            else:
                waiters.append(asyncio.create_task(service.shutdown()))
            # Yield through the second cancellation, while OS termination is held.
            for _ in range(10):
                await asyncio.sleep(0)
            assert not stopped.is_set()
            assert not task.done(), 'run completed before its owned processes stopped'
            assert all(not waiter.done() for waiter in waiters)
            if run_id:
                assert run_id in service.active
                assert service.storage.run('one', run_id)['status'] == 'running'
                with pytest.raises(FileExistsError):
                    service.prepare('one', Command(text='too early', task='next'))
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            await asyncio.gather(*waiters)
            assert stopped.is_set()
            stamps = [path.stat().st_mtime_ns for path in (parent, child)]
            await asyncio.sleep(.3)
            assert stamps == [path.stat().st_mtime_ns for path in (parent, child)]
            if run_id:
                assert run_id not in service.active
                assert service.storage.run('one', run_id)['status'] == 'interrupted'
                prepared = service.prepare('one', Command(text='after stop', task='next'))
                service.storage.finish_run(prepared[0], 'interrupted', error='test cleanup')
                terminals = [e for e in service.storage.events('one', run_id) if e['kind']=='status' and e['text']=='interrupted']
                assert len(terminals) == 1
            assert not unhandled
        finally:
            release.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, *waiters, return_exceptions=True)
            await until(stopped.is_set)
    asyncio.run(scenario())
