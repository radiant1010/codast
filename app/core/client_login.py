"""User-triggered native login. Credentials and terminal output stay with the CLI."""
import asyncio
import os
from pathlib import Path
import subprocess

from app.core.connections import login_instructions
from app.llm.cli import probe


def launch_login(argv):
    if os.name != 'nt':
        raise ValueError('로그인 창은 Windows 로컬 실행에서 지원합니다.')
    startup = subprocess.STARTUPINFO()
    startup.lpDesktop = 'winsta0\\default'
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 1
    # Leave all streams unset so the new console owns them, not the server log.
    return subprocess.Popen(argv, cwd=str(Path.home()), close_fds=True,
                            creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup)


class ClientLogin:
    def __init__(self, statuses, launch=launch_login, timeout=300):
        self.statuses, self.launch, self.timeout = statuses, launch, timeout
        self.jobs = {}

    def view(self, client):
        job = self.jobs.get(client, {})
        return {'state': job.get('state', 'idle'), 'message': job.get('message', '')}

    def start(self, client, configured):
        if client not in ('codex', 'claude'):
            raise ValueError('지원하지 않는 클라이언트입니다.')
        previous = self.jobs.get(client)
        if previous and not previous['task'].done():
            return self.view(client)
        job = {'state': 'checking', 'message': '로그인 상태를 확인하고 있습니다.'}
        self.jobs[client] = job
        job['task'] = asyncio.create_task(self._run(client, configured, job))
        return self.view(client)

    def _clear_usage(self, client):
        status = self.statuses.get(client)
        if status:
            with status.lock:
                status.cached, status.expires = None, 0

    @staticmethod
    def _stop(process):
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)

    async def _run(self, client, configured, job):
        process = None
        try:
            observed = await probe(client, configured)
            if observed.get('auth') != 'ready':
                if observed.get('state') != 'installed' or observed.get('auth') != 'check_required':
                    raise ValueError('CLI 연결을 먼저 확인하세요.')
                argv = login_instructions(client, observed['path'])['argv']
                process = self.launch(argv)
                job.update(state='waiting', message='로그인 창과 브라우저에서 인증을 완료하세요. 창을 닫으면 취소됩니다.')
                await asyncio.to_thread(process.wait, timeout=self.timeout)
                job.update(state='verifying', message='로그인 결과를 확인하고 있습니다.')
                observed = await probe(client, configured)
            if observed.get('auth') == 'ready':
                await asyncio.to_thread(self._clear_usage, client)
                job.update(state='ready', message='로그인을 확인했습니다.')
            else:
                job.update(state='failed', message='로그인을 완료하지 못했습니다. 로그인 창을 닫았다면 다시 시도하세요.')
        except subprocess.TimeoutExpired:
            job.update(state='timed_out', message='로그인 대기 시간이 지났습니다. 다시 로그인하세요.')
        except asyncio.CancelledError:
            job.update(state='cancelled', message='서버 종료로 로그인 대기를 취소했습니다.')
            raise
        except (OSError, ValueError, RuntimeError):
            job.update(state='failed', message='로그인 창을 열거나 결과를 확인하지 못했습니다. CLI 연결을 확인한 뒤 다시 시도하세요.')
        finally:
            if process is not None:
                await asyncio.to_thread(self._stop, process)

    async def close(self):
        tasks = [job['task'] for job in self.jobs.values() if not job['task'].done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
