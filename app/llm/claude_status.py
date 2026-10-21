"""Read subscription limits without starting a model turn or persisting credentials."""
import http.client
import json
import math
import os
from pathlib import Path
import subprocess
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from app.llm.cli import executable


class UsageError(Exception):
    def __init__(self, state, retry_after=60):
        self.state, self.retry_after = state, retry_after
        super().__init__(state)


def normalize(data):
    if not isinstance(data, dict):
        return []
    durations = {'session': 300, 'weekly_all': 10080, 'weekly_scoped': 10080}
    rows = data.get('limits')
    rows = [row for row in rows if isinstance(row, dict) and row.get('kind') in durations] if isinstance(rows, list) else []
    if not rows:
        for key, kind, name in [('five_hour', 'session', None), ('seven_day', 'weekly_all', None),
                                ('seven_day_sonnet', 'weekly_scoped', 'Sonnet'), ('seven_day_opus', 'weekly_scoped', 'Opus')]:
            row = data.get(key)
            if isinstance(row, dict):
                rows.append({'kind': kind, 'percent': row.get('utilization'), 'resets_at': row.get('resets_at'),
                             'scope': {'model': {'display_name': name}}})
    result = []
    for row in rows:
        percent, reset = row.get('percent'), None
        if type(percent) not in (int, float) or not math.isfinite(percent) or percent < 0:
            percent = None
        try:
            date = datetime.fromisoformat(row.get('resets_at'))
            if date.tzinfo is not None:
                reset = date.timestamp()
        except (TypeError, ValueError, OverflowError, OSError):
            pass
        scope = row.get('scope')
        model = scope.get('model') if isinstance(scope, dict) else None
        name = model.get('display_name') if isinstance(model, dict) else None
        result.append({'bucket': 'claude', 'name': 'Claude'+(' '+name[:80] if isinstance(name, str) and name else ''),
                       'usedPercent': percent, 'windowDurationMins': durations[row['kind']], 'resetsAt': reset})
    return result


def query_status(path):
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    result = subprocess.run([path, 'auth', 'status', '--json'], capture_output=True,
                            encoding='utf-8', errors='replace', timeout=10, **flags)
    auth = json.loads(result.stdout)
    if not isinstance(auth, dict):
        raise UsageError('error')
    if auth.get('loggedIn') is False:
        raise UsageError('login_required')
    if result.returncode or auth.get('loggedIn') is not True:
        raise UsageError('error')
    if auth.get('authMethod') not in ('claude.ai', 'oauth_token'):
        raise UsageError('unsupported')
    token = os.environ.get('CLAUDE_CODE_OAUTH_TOKEN') if auth['authMethod'] == 'oauth_token' else None
    if not token:
        root = auth.get('configDirectory') or os.environ.get('CLAUDE_CONFIG_DIR') or str(Path.home() / '.claude')
        try:
            with (Path(root) / '.credentials.json').open(encoding='utf-8') as source:
                credentials = json.loads(source.read(65537))
        except (OSError, ValueError):
            raise UsageError('credentials_unavailable') from None
        oauth = credentials.get('claudeAiOauth') if isinstance(credentials, dict) else None
        token = oauth.get('accessToken') if isinstance(oauth, dict) else None
    if not isinstance(token, str) or not token.strip():
        raise UsageError('credentials_unavailable')
    # shortcut: Claude's usage endpoint is internal; update this adapter if its response changes.
    connection = http.client.HTTPSConnection('api.anthropic.com', timeout=10)
    try:
        connection.request('GET', '/api/oauth/usage', headers={
            'Authorization': 'Bearer '+token, 'anthropic-beta': 'oauth-2025-04-20', 'Accept': 'application/json'})
        response = connection.getresponse()
        if response.status != 200:
            retry = response.getheader('Retry-After') or ''
            try:
                wait = int(retry) if retry.isdigit() else max(0, parsedate_to_datetime(retry).timestamp() - time.time())
                if not math.isfinite(wait):
                    wait = 60
            except (TypeError, ValueError, OverflowError):
                wait = 60
            raise UsageError({401: 'login_required', 403: 'permission_required', 429: 'rate_limited'}.get(response.status, 'error'), wait)
        raw = response.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise UsageError('error')
        return normalize(json.loads(raw))
    finally:
        connection.close()


class ClaudeStatus:
    def __init__(self, query=query_status, ttl=60):
        self.query, self.ttl = query, ttl
        self.lock = threading.Lock()
        self.cached, self.key, self.expires = None, None, 0

    def read(self, configured=''):
        with self.lock:
            if self.cached is not None and self.key == configured and time.monotonic() < self.expires:
                return self.cached
            result = {'client': 'claude', 'source': 'Claude Code usage', 'scope': 'account', 'limits': []}
            wait = self.ttl
            try:
                result['limits'] = self.query(executable('claude', configured))
                result['state'] = 'available' if any(row['usedPercent'] is not None for row in result['limits']) else 'unavailable'
            except UsageError as exc:
                result['state'] = exc.state
                wait = max(wait, exc.retry_after)
            except FileNotFoundError:
                result['state'] = 'not_installed'
            except (OSError, ValueError, TypeError, http.client.HTTPException, subprocess.SubprocessError):
                result['state'] = 'error'
            result['checked_at'] = datetime.now(timezone.utc).isoformat()
            self.cached, self.key, self.expires = result, configured, time.monotonic() + wait
            return result
