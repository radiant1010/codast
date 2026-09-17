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


def discovery_candidates(client):
    """PATH first, then bounded native install locations; never run shell wrappers."""
    found = shutil.which(client)
    if found:
        yield Path(found)
    if os.name != 'nt':
        return
    try:
        home = Path.home()
    except RuntimeError:
        home = None
    if home:
        yield home / '.local' / 'bin' / (client + '.exe')
    local = os.environ.get('LOCALAPPDATA')
    if client == 'codex' and local:
        folder = Path(local) / 'OpenAI' / 'Codex' / 'bin'
        if folder.is_dir():
            yield from sorted(folder.glob('*/codex.exe'), key=lambda p: p.stat().st_mtime, reverse=True)


def executable(client, configured=''):
    if client not in ('codex', 'claude'):
        raise ValueError('지원하지 않는 클라이언트입니다.')
    path = configured or next((str(p) for p in discovery_candidates(client)
                               if p.is_file() and (os.name != 'nt' or p.suffix.lower() == '.exe')), '')
    if not path or not Path(path).is_file():
        raise FileNotFoundError(f'{client} 실행 파일을 찾지 못했습니다. 설치 후 클라이언트 화면에서 경로를 지정하세요.')
    path = str(Path(path).resolve())
    if os.name == 'nt' and Path(path).suffix.lower() != '.exe':
        raise ValueError('Windows에서는 네이티브 .exe 경로를 지정하세요. 셸 래퍼는 실행하지 않습니다.')
    return path


class ProcessRunner:
    limit = 4 * 1024 * 1024

    async def run(self, argv, cwd, prompt='', timeout=600, on_line=None):
        cancel = threading.Event()
        worker = asyncio.create_task(asyncio.to_thread(self._run, argv, cwd, prompt, timeout, cancel, on_line))
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

    def _run(self, argv, cwd, prompt, timeout, cancel, on_line=None):
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}
        process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, **kwargs)
        buffers = [bytearray(), bytearray()]
        overflow = threading.Event()
        reader_errors = []

        def drain(stream, target, channel):
            pending = bytearray()
            try:
                while chunk := stream.read1(4096):
                    if len(target) + len(chunk) > self.limit:
                        overflow.set()
                        continue
                    target.extend(chunk)
                    if on_line:
                        pending.extend(chunk)
                        while b'\n' in pending:
                            line, _, rest = pending.partition(b'\n')
                            pending = bytearray(rest)
                            on_line(channel, line.decode('utf-8', errors='replace'))
                if pending and on_line:
                    on_line(channel, pending.decode('utf-8', errors='replace'))
            except Exception as exc:
                reader_errors.append(exc)
            finally:
                stream.close()

        readers = [threading.Thread(target=drain, args=(stream, target, channel), daemon=True)
                   for stream, target, channel in zip((process.stdout, process.stderr), buffers, ('stdout','stderr'))]
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
                if reader_errors:
                    raise reader_errors[0]
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
        if reader_errors:
            raise reader_errors[0]
        return process.returncode, *(b.decode('utf-8', errors='replace') for b in buffers)


class CliAdapter:
    def __init__(self, client, path, runner=None):
        self.client, self.path = client, path
        self.runner = runner or ProcessRunner()
        self.on_event = None
        self.seen_text = {}
        self.model = None

    def arguments(self, mode, session=None):
        if self.client == 'codex':
            # Global config applies to both new and resumed exec sessions.
            args = [self.path, '-c', 'approval_policy="never"', '-c', f'sandbox_mode="{mode}"', 'exec']
            if session:
                args += ['resume', session]
            if self.model:
                args += ['--model', self.model]
            return args + ['--json', '--skip-git-repo-check', '-']
        args = [self.path, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode',
                'plan' if mode == 'read-only' else 'acceptEdits']
        if session:
            args += ['--resume', session]
        if self.model:
            args += ['--model', self.model]
        return args

    async def execute(self, context, cwd, mode, session=None):
        prompt = '프로젝트 규칙과 선택 자료를 참고하여 현재 요청을 처리하세요. history는 이전 대화 기록입니다.\n' + context
        options = {'on_line': self.stream_line} if self.on_event else {}
        code, stdout, stderr = await self.runner.run(self.arguments(mode, session), cwd, prompt, **options)
        if code:
            raise RuntimeError(f'{self.client} 종료 코드 {code}: '+(stderr.strip() or stdout.strip())[-3000:])
        return self.parse(stdout)

    def stream_line(self, channel, line):
        if channel == 'stderr':
            if line.strip():
                self.on_event('warning', line)
            return
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(event, dict):
            return
        kind = event.get('type', '')
        if self.client == 'codex':
            item = event.get('item') or {}
            category = item.get('type')
            if kind in ('thread.started', 'turn.started'):
                self.on_event('status', kind)
            elif kind.startswith('item.') and category in ('agent_message', 'command_execution'):
                key = (item.get('id'), category)
                value = item.get('text', '') if category == 'agent_message' else item.get('aggregated_output', '')
                previous = self.seen_text.get(key, '')
                if category == 'command_execution' and key not in self.seen_text:
                    self.on_event('tool', item.get('command', '명령 실행'))
                if value and value != previous:
                    self.on_event('assistant' if category == 'agent_message' else 'output',
                                  value[len(previous):] if value.startswith(previous) else value)
                self.seen_text[key] = value
                if category == 'command_execution' and kind == 'item.completed':
                    self.on_event('status', f"명령 종료 · 코드 {item.get('exit_code', '?')}")
            elif kind == 'item.completed' and category == 'file_change':
                self.on_event('file', json.dumps(item.get('changes', []), ensure_ascii=False))
            elif kind in ('item.started', 'item.completed') and category in ('mcp_tool_call', 'web_search'):
                self.on_event('tool', json.dumps(item, ensure_ascii=False))
            elif kind in ('error', 'turn.failed'):
                self.on_event('warning', str(event.get('message') or event.get('error')))
        else:
            if kind == 'stream_event':
                delta = (event.get('event') or {}).get('delta') or {}
                if delta.get('type') == 'text_delta':
                    self.on_event('assistant', delta.get('text', ''))
            elif kind == 'assistant':
                for block in (event.get('message') or {}).get('content', []):
                    if block.get('type') == 'tool_use':
                        self.on_event('tool', block.get('name', '')+' '+json.dumps(block.get('input', {}), ensure_ascii=False))
            elif kind == 'user':
                for block in (event.get('message') or {}).get('content', []):
                    if isinstance(block, dict) and block.get('type') == 'tool_result':
                        self.on_event('output', str(block.get('content', '')))
            elif kind == 'system':
                self.on_event('status', 'Claude · '+event.get('subtype', 'system'))

    def parse(self, stdout):
        if self.client == 'claude':
            execution_model = None
            try:
                data = json.loads(stdout)
            except json.JSONDecodeError:
                data = None
                for line in stdout.splitlines():
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(event, dict) and event.get('type') == 'system' and event.get('subtype') == 'init':
                        execution_model = event.get('model')
                    if isinstance(event, dict) and event.get('type') == 'result':
                        data = event
            if not isinstance(data, dict):
                raise ValueError('Claude 최종 JSON 응답을 해석하지 못했습니다.')
            if data.get('is_error') or data.get('subtype', 'success') != 'success':
                raise RuntimeError('Claude 실행 실패: '+str(data.get('result', data))[-2000:])
            result = data.get('result')
            if not isinstance(result, str):
                raise ValueError('Claude 최종 결과가 없습니다.')
            return AgentResult(adapter='claude', output=result, session_id=data.get('session_id'), usage=data.get('usage'), execution_model=execution_model)
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
        else:
            status, auth_out, _ = await runner.run([path, 'auth', 'status', '--json'], str(Path(path).parent), timeout=10)
            try:
                payload = json.loads(auth_out)
                logged_in = payload.get('loggedIn') if isinstance(payload, dict) else None
                if logged_in is False:
                    auth = 'check_required'
                elif logged_in is True and status == 0:
                    auth = 'ready'
            except (ValueError, TypeError):
                pass
        return {'client': client, 'state': 'installed', 'path': path, 'version': out.strip()[:200], 'auth': auth,
                'execution_state': 'not_verified',
                'next_action': None if auth == 'ready' else 'login' if auth == 'check_required' else 'check_auth'}
    except (OSError, ValueError, RuntimeError, TimeoutError):
        return {'client': client, 'state': 'error', 'path': path, 'auth': 'unknown',
                'detail': 'CLI 확인에 실패했습니다. 실행 권한과 설치 상태를 확인하세요.', 'next_action': 'check_cli'}
