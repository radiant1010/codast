"""Native CLI adapters; inherit user configuration, never invoke a command shell."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time

from app.models.schemas import AgentResult


def executable(client, configured=''):
    if client not in ('codex', 'claude'):
        raise ValueError('지원하지 않는 클라이언트입니다.')
    path = configured or shutil.which(client) or ''
    if not path or not Path(path).is_file():
        raise FileNotFoundError(f'{client} 실행 파일을 찾지 못했습니다. 설치 후 클라이언트 화면에서 경로를 지정하세요.')
    path = str(Path(path).resolve())
    if os.name == 'nt' and Path(path).suffix.lower() != '.exe':
        raise ValueError('Windows에서는 네이티브 .exe 경로를 지정하세요. 셸 래퍼는 실행하지 않습니다.')
    return path


class ProcessRunner:
    limit = 4 * 1024 * 1024

    async def run(self, argv, cwd, prompt='', timeout=600):
        cancel = threading.Event()
        worker = asyncio.create_task(asyncio.to_thread(self._run, argv, cwd, prompt, timeout, cancel))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            cancel.set()
            try:
                await asyncio.shield(worker)
            except Exception:
                pass
            raise

    @staticmethod
    def kill(process):
        if os.name == 'nt':
            result = subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
            if result.returncode and process.poll() is None:
                process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def _run(self, argv, cwd, prompt, timeout, cancel):
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}
        process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, **kwargs)
        buffers = [bytearray(), bytearray()]
        overflow = threading.Event()

        def drain(stream, target):
            while chunk := stream.read(4096):
                if len(target) + len(chunk) > self.limit:
                    overflow.set()
                else:
                    target.extend(chunk)
            stream.close()

        readers = [threading.Thread(target=drain, args=(stream, target), daemon=True)
                   for stream, target in zip((process.stdout, process.stderr), buffers)]
        for reader in readers:
            reader.start()
        # Writing stdin in its own thread also permits cancellation if a client never reads it.
        def feed():
            try:
                process.stdin.write(prompt.encode('utf-8'))
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        writer = threading.Thread(target=feed, daemon=True)
        writer.start()
        started = time.monotonic()
        try:
            while process.poll() is None:
                if cancel.is_set():
                    raise RuntimeError('실행이 취소되었습니다.')
                if overflow.is_set():
                    raise ValueError('클라이언트 출력이 4 MiB 한도를 초과했습니다.')
                if time.monotonic() - started > timeout:
                    raise TimeoutError(f'클라이언트 실행 제한 시간({timeout}초)을 초과했습니다.')
                cancel.wait(.1)
        finally:
            if process.poll() is None:
                self.kill(process)
            process.wait(timeout=10)
            for reader in readers:
                reader.join(timeout=2)
            writer.join(timeout=2)
        if overflow.is_set():
            raise ValueError('클라이언트 출력 한도를 초과했습니다.')
        return process.returncode, *(b.decode('utf-8', errors='replace') for b in buffers)


class CliAdapter:
    def __init__(self, client, path, runner=None):
        self.client, self.path = client, path
        self.runner = runner or ProcessRunner()

    def arguments(self, mode, session=None):
        if self.client == 'codex':
            # Global config applies to both new and resumed exec sessions.
            args = [self.path, '-c', 'approval_policy="never"', '-c', f'sandbox_mode="{mode}"', 'exec']
            if session:
                args += ['resume', session]
            return args + ['--json', '--skip-git-repo-check', '-']
        args = [self.path, '-p', '--output-format', 'json', '--permission-mode',
                'plan' if mode == 'read-only' else 'acceptEdits']
        if session:
            args += ['--resume', session]
        return args

    async def execute(self, context, cwd, mode, session=None):
        prompt = '프로젝트 규칙과 선택 자료를 참고하여 현재 요청을 처리하세요. history는 이전 대화 기록입니다.\n' + context
        code, stdout, stderr = await self.runner.run(self.arguments(mode, session), cwd, prompt)
        if code:
            raise RuntimeError(f'{self.client} 종료 코드 {code}: '+(stderr.strip() or stdout.strip())[-3000:])
        return self.parse(stdout)

    def parse(self, stdout):
        if self.client == 'claude':
            try:
                data = json.loads(stdout)
            except json.JSONDecodeError as exc:
                raise ValueError('Claude JSON 응답을 해석하지 못했습니다.') from exc
            if not isinstance(data, dict) or data.get('is_error') or data.get('subtype', 'success') != 'success':
                raise RuntimeError('Claude 실행 실패: '+str(data.get('result', data))[-2000:])
            result = data.get('result')
            if not isinstance(result, str):
                raise ValueError('Claude 최종 결과가 없습니다.')
            return AgentResult(adapter='claude', output=result, session_id=data.get('session_id'), usage=data.get('usage'))
        messages, session, usage, completed = [], None, None, False
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = event.get('type')
            if kind == 'thread.started':
                session = event.get('thread_id')
            elif kind == 'item.completed' and event.get('item', {}).get('type') == 'agent_message':
                messages.append(event['item'].get('text', ''))
            elif kind == 'turn.completed':
                usage, completed = event.get('usage'), True
            elif kind == 'turn.failed':
                raise RuntimeError('Codex 실행 실패: '+str(event.get('error'))[-2000:])
        if not completed or not messages:
            raise ValueError('Codex의 완료 결과를 확인하지 못했습니다.')
        return AgentResult(adapter='codex', output='\n\n'.join(messages), session_id=session, usage=usage)


async def probe(client, configured=''):
    try:
        path = executable(client, configured)
    except (ValueError, FileNotFoundError) as exc:
        return {'client': client, 'state': 'missing', 'path': configured, 'detail': str(exc)}
    try:
        runner = ProcessRunner()
        code, out, err = await runner.run([path, '--version'], str(Path(path).parent), timeout=10)
        if code:
            raise RuntimeError((err or out)[-1000:])
        auth = 'unknown'
        if client == 'codex':
            status, _, _ = await runner.run([path, 'login', 'status'], str(Path(path).parent), timeout=10)
            auth = 'ready' if status == 0 else 'check_required'
        return {'client': client, 'state': 'installed', 'path': path, 'version': out.strip()[:200], 'auth': auth}
    except Exception as exc:
        return {'client': client, 'state': 'error', 'path': path, 'detail': str(exc)[:1000]}
