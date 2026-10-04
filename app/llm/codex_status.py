"""Read-only Codex metadata. Never starts or resumes an agent turn."""
import json
import os
import queue
import subprocess
import threading
import time
from datetime import datetime, timezone

from app.llm.cli import executable, ProcessRunner


def query_status(path):
    models, limits = query_readonly(path, [('model/list', {'limit': 100}), ('account/rateLimits/read', {})])
    return normalize(models, limits)


def query_readonly(path, requests):
    if any(method not in {'model/list', 'account/rateLimits/read', 'thread/list', 'thread/read'} for method, _ in requests):
        raise ValueError('읽기 전용 조회만 허용합니다.')
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}
    process = subprocess.Popen([path, 'app-server', '--stdio'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **flags)
    messages = queue.Queue(maxsize=256)

    def read():
        try:
            while line := process.stdout.readline(16 * 1024 * 1024 + 1):
                if len(line) > 16 * 1024 * 1024:
                    break
                messages.put_nowait(json.loads(line))
        except (ValueError, OSError, queue.Full):
            pass
        finally:
            try:
                messages.put_nowait(None)
            except queue.Full:
                pass

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    deadline = time.monotonic() + 20

    def send(value):
        process.stdin.write((json.dumps(value) + '\n').encode())
        process.stdin.flush()

    def call(identity, method, params):
        send({'id': identity, 'method': method, 'params': params})
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            message = messages.get(timeout=remaining)
            if message is None:
                raise OSError('Codex status process exited')
            if message.get('id') == identity:
                return message

    try:
        initialized = call(1, 'initialize', {'clientInfo': {'name': 'harness_status', 'version': '0.1'}})
        if 'result' not in initialized:
            raise OSError('Codex initialization failed')
        send({'method': 'initialized'})
        return [call(i, method, params) for i, (method, params) in enumerate(requests, 2)]
    finally:
        if process.poll() is None:
            ProcessRunner.kill(process)
        process.wait(timeout=10)
        reader.join(timeout=2)
        process.stdin.close()
        process.stdout.close()


def normalize(models, limits):
    """Allowlist public fields; account identifiers/credits/errors never reach the UI."""
    result = {'models': [], 'limits': [], 'models_state': 'unavailable', 'limits_state': 'unavailable'}
    if 'result' in models:
        result['models_state'] = 'available'
        result['models'] = [{key: row.get(key) for key in ('id', 'model', 'displayName', 'isDefault')}
                            for row in models['result'].get('data', [])]
        result['models_has_more'] = bool(models['result'].get('nextCursor'))
    if 'result' in limits:
        data = limits['result']
        buckets = data.get('rateLimitsByLimitId') or {'codex': data.get('rateLimits')}
        for identity, bucket in buckets.items():
            if not isinstance(bucket, dict):
                continue
            for name in ('primary', 'secondary'):
                window = bucket.get(name)
                if not isinstance(window, dict):
                    continue
                result['limits'].append({'bucket': identity, 'name': bucket.get('limitName'),
                                         'window': name, **{key: window.get(key) for key in
                                         ('usedPercent', 'windowDurationMins', 'resetsAt')}})
        result['limits_state'] = 'available' if result['limits'] else 'unavailable'
    return result


class CodexStatus:
    def __init__(self, query=query_status, ttl=60):
        self.query = query
        self.ttl = ttl
        self.lock = threading.Lock()
        self.cached = None
        self.key = None
        self.expires = 0

    def read(self, configured=''):
        with self.lock:
            if self.cached is not None and self.key == configured and time.monotonic() < self.expires:
                return self.cached
            result = {'client': 'codex', 'source': 'codex app-server', 'scope': 'account',
                      'models': [], 'limits': [], 'models_state': 'unavailable', 'limits_state': 'unavailable',
                      'execution_model_state': 'not_collected', 'context_state': 'not_collected'}
            try:
                path = executable('codex', configured)
                result.update(self.query(path))
                result['state'] = 'available' if result['models_state'] == result['limits_state'] == 'available' else 'partial'
            except FileNotFoundError:
                result['state'] = 'not_installed'
            except (OSError, ValueError, TimeoutError, queue.Empty, subprocess.SubprocessError):
                result['state'] = 'error'
            result['checked_at'] = datetime.now(timezone.utc).isoformat()
            self.cached, self.key, self.expires = result, configured, time.monotonic() + self.ttl
            return result
