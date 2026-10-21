"""Read measured session metadata without running a model or exposing transcript text."""
import io
import json
import os
import threading
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import UUID

import zstandard


def token_count(value):
    return value if type(value) is int and 0 <= value < 2**53 else None


def model_name(value):
    return value if isinstance(value, str) and 0 < len(value) <= 200 and value.isprintable() and value != '<synthetic>' else None


def context_usage(used, window, source, timestamp=None):
    return {'used_tokens': token_count(used), 'window_tokens': token_count(window) or None,
            'source': source, 'observed_at': timestamp or datetime.now(timezone.utc).isoformat()}


def update_claude_metrics(metrics, event):
    if event.get('parent_tool_use_id') or event.get('isSidechain'):
        return
    kind = event.get('type')
    if kind == 'system' and event.get('subtype') == 'init':
        if model := model_name(event.get('model')):
            metrics['context_usage'] = context_usage(None, None, 'claude_response', event.get('timestamp'))
            metrics['execution_model'] = model
    elif kind == 'system' and event.get('subtype') == 'compact_boundary':
        metrics['context_usage'] = context_usage(None, None, 'claude_response', event.get('timestamp'))
    elif kind == 'assistant':
        message = event.get('message') or {}
        if not isinstance(message, dict) or not (model := model_name(message.get('model'))):
            return
        if metrics.get('execution_model') and metrics['execution_model'] != model:
            metrics['context_usage'] = context_usage(None, None, 'claude_response', event.get('timestamp'))
        metrics['execution_model'] = model
        usage = message.get('usage') or {}
        if isinstance(usage, dict):
            counts = [token_count(usage.get(k, 0)) for k in
                      ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')]
            if 'input_tokens' in usage and all(n is not None for n in counts):
                metrics['context_usage'] = context_usage(sum(counts), None, 'claude_response', event.get('timestamp'))
    elif kind == 'result':
        models = event.get('modelUsage') or {}
        if isinstance(models, dict):
            if not metrics.get('execution_model') and len(models) == 1:
                metrics['execution_model'] = model_name(next(iter(models)))
            current = models.get(metrics.get('execution_model')) or {}
            if metrics.get('context_usage') and isinstance(current, dict):
                metrics['context_usage']['window_tokens'] = token_count(current.get('contextWindow')) or None
    if isinstance(event.get('session_id'), str):
        metrics['session_id'] = event['session_id']


def read_metrics_file(path, root, identity, client):
    # shortcut: native transcript formats can change; replace with a read-only metrics API when offered.
    matched = False
    metrics = {}
    modified_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    with path.open('rb') as raw:
        stream = zstandard.ZstdDecompressor().stream_reader(raw) if path.suffix == '.zst' else raw
        with io.BufferedReader(stream) as source:
            size = 0
            while line := source.readline(4 * 1024 * 1024 + 1):
                size += len(line)
                if size > 64 * 1024 * 1024 or len(line) > 4 * 1024 * 1024:
                    raise ValueError('Session metadata read limit')
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict) or event.get('isSidechain'):
                    continue
                event['timestamp'] = event.get('timestamp') or modified_at
                payload = event.get('payload') or {}
                if not isinstance(payload, dict):
                    continue
                scope = payload if client == 'codex' and event.get('type') == 'session_meta' else event if client == 'claude' else {}
                if scope:
                    recorded_id = scope.get('id' if client == 'codex' else 'sessionId')
                    if recorded_id and recorded_id != identity:
                        raise ValueError('Session mismatch')
                    if scope.get('cwd'):
                        if Path(scope['cwd']).resolve() != root:
                            raise ValueError('Workspace mismatch')
                        matched = matched or recorded_id == identity
                if client == 'claude':
                    update_claude_metrics(metrics, event)
                elif event.get('type') == 'turn_context':
                    if model := model_name(payload.get('model')):
                        if metrics.get('execution_model') and metrics['execution_model'] != model:
                            metrics['context_usage'] = context_usage(None, None, 'codex_token_count', event['timestamp'])
                        metrics['execution_model'] = model
                elif event.get('type') == 'compacted':
                    metrics['context_usage'] = context_usage(None, None, 'codex_token_count', event['timestamp'])
                elif event.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                    info = payload.get('info') or {}
                    last = (info.get('last_token_usage') or {}) if isinstance(info, dict) else {}
                    if isinstance(last, dict) and token_count(last.get('total_tokens')) is not None:
                        metrics['context_usage'] = context_usage(last['total_tokens'], info.get('model_context_window'),
                                                                 'codex_token_count', event.get('timestamp'))
    if not matched:
        raise ValueError('Unscoped session')
    metrics.pop('session_id', None)
    return metrics


def safe_path(path, base):
    path, base = Path(path), Path(base)
    if not path.resolve().is_relative_to(base.resolve()):
        raise ValueError('Outside session store')
    for parent in (path, *path.parents):
        if parent.is_symlink() or parent.is_junction():
            raise ValueError('Linked session store')
        if parent == base:
            break
    return path


class SessionMetrics:
    def __init__(self):
        self.cache = {}
        self.lock = threading.Lock()
        self.pending = set()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="session-metrics")

    def close(self):
        self.pool.shutdown(wait=False, cancel_futures=True)

    def snapshot(self, client, cwd, identity, configured=''):
        try:
            key = (client, str(Path(cwd).resolve()), str(UUID(identity)), configured)
        except (ValueError, TypeError, AttributeError):
            return {'state': 'unavailable'}
        with self.lock:
            cached = self.cache.get(key)
            refresh = not cached or time.monotonic() - cached[0] >= 30
            submit = refresh and key not in self.pending and len(self.pending) < 64
            if submit:
                self.pending.add(key)
        if submit:
            future = self.pool.submit(self.read, *key)
            def finished(_):
                with self.lock:
                    self.pending.discard(key)
            future.add_done_callback(finished)
        return cached[1].copy() if cached else {'state': 'loading'}

    def read(self, client, cwd, identity, configured=''):
        try:
            identity = str(UUID(identity))
            root = Path(cwd).resolve()
        except (ValueError, TypeError, AttributeError):
            return {'state': 'unavailable'}
        key = (client, str(root), identity, configured)
        with self.lock:
            cached = self.cache.get(key)
            if cached and time.monotonic() - cached[0] < 30:
                return cached[1].copy()
        metrics = {}
        try:
            if client == 'codex':
                from app.core.native_threads import request
                thread = request(configured, 'thread/read', {'threadId': identity, 'includeTurns': False})['thread']
                if thread.get('id') != identity or not thread.get('cwd') or Path(thread['cwd']).resolve() != root:
                    raise ValueError('Workspace mismatch')
                if model := model_name(thread.get('model')):
                    metrics['execution_model'] = model
                home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
                path = safe_path(thread['path'], home)
                if not path.exists():
                    path = safe_path(str(path) + '.zst', home)
                metrics.update(read_metrics_file(path, root, identity, client))
            elif client == 'claude':
                from app.core.claude_threads import transcript_root
                base = transcript_root()
                for path in base.glob(f'*/{identity}.jsonl'):
                    metrics = read_metrics_file(safe_path(path, base), root, identity, client)
                    break
            metrics['state'] = 'available' if metrics else 'unavailable'
        except (OSError, ValueError, TypeError, KeyError, zstandard.ZstdError):
            metrics['state'] = 'unavailable'
        with self.lock:
            if len(self.cache) >= 256:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = (time.monotonic(), metrics)
            return metrics.copy()
