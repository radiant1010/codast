import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


def test_claude_usage_endpoint_does_not_start_a_run(tmp_path):
    app = create_app(tmp_path / 'projects')
    app.state.claude_status = SimpleNamespace(read=lambda path: {
        'client': 'claude', 'state': 'available', 'limits': [
            {'bucket': 'claude', 'usedPercent': 0, 'windowDurationMins': 300, 'resetsAt': None}]})
    with TestClient(app) as client:
        response = client.get('/api/clients/claude/status')
        assert response.status_code == 200
        assert response.json()['limits'][0]['usedPercent'] == 0
        assert client.get('/api/session-overview').json()['running'] == []


def test_usage_normalization_preserves_zero_without_account_details():
    from app.llm.claude_status import normalize
    result = normalize({'limits': [
        {'kind': 'session', 'percent': 0, 'resets_at': None},
        {'kind': 'weekly_all', 'percent': 35.5, 'resets_at': '2026-01-01T00:00:00Z'},
        {'kind': 'weekly_scoped', 'percent': 12, 'resets_at': 'invalid',
         'scope': {'model': {'display_name': 'Sonnet'}}},
        {'kind': 'unknown', 'percent': 99}], 'accountId': 'private', 'spend': {'balance': 'private'}})
    assert result == [
        {'bucket': 'claude', 'name': 'Claude', 'usedPercent': 0, 'windowDurationMins': 300, 'resetsAt': None},
        {'bucket': 'claude', 'name': 'Claude', 'usedPercent': 35.5, 'windowDurationMins': 10080, 'resetsAt': 1767225600},
        {'bucket': 'claude', 'name': 'Claude Sonnet', 'usedPercent': 12, 'windowDurationMins': 10080, 'resetsAt': None}]
    assert 'private' not in json.dumps(result)


@pytest.mark.parametrize('value', [None, True, -1, '25', float('nan'), float('inf')])
def test_invalid_usage_is_never_reported_as_zero(value):
    from app.llm.claude_status import normalize
    result = normalize({'five_hour': {'utilization': value, 'resets_at': '2026-01-01'}})
    assert result[0]['usedPercent'] is None
    assert result[0]['resetsAt'] is None


def test_legacy_usage_and_invalid_response_shapes():
    from app.llm.claude_status import normalize
    assert normalize({'five_hour': {'utilization': 0}, 'seven_day': {'utilization': 80}})[0]['usedPercent'] == 0
    assert len(normalize({'limits': [], 'seven_day': {'utilization': 80}})) == 1
    for data in (None, [], {'limits': [None, 'bad', {'kind': 'unknown'}]}, {'five_hour': []}):
        assert normalize(data) == []


@pytest.fixture
def usage_transport(tmp_path, monkeypatch):
    import app.llm.claude_status as module
    (tmp_path / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {
        'accessToken': 'test-only-token', 'refreshToken': 'private-refresh'}}), encoding='utf-8')
    monkeypatch.delenv('CLAUDE_CODE_OAUTH_TOKEN', raising=False)
    auth = {'loggedIn': True, 'authMethod': 'claude.ai', 'configDirectory': str(tmp_path)}
    calls = []
    def run(argv, **kwargs):
        assert argv == ['claude.exe', 'auth', 'status', '--json']
        assert kwargs['timeout'] <= 10
        return SimpleNamespace(returncode=0, stdout=json.dumps(auth))
    monkeypatch.setattr(module.subprocess, 'run', run)
    response = SimpleNamespace(status=200, read=lambda size: b'{"five_hour":{"utilization":0}}',
                               getheader=lambda name: None)
    class Connection:
        def __init__(self, host, timeout):
            assert host == 'api.anthropic.com' and timeout <= 15
        def request(self, method, path, headers):
            calls.append((method, path, headers))
        def getresponse(self): return response
        def close(self): pass
    monkeypatch.setattr(module.http.client, 'HTTPSConnection', Connection)
    return module, auth, calls, response


def test_usage_request_uses_native_login_and_fixed_origin(usage_transport):
    module, _, calls, _ = usage_transport
    assert module.query_status('claude.exe')[0]['usedPercent'] == 0
    assert len(calls) == 1
    method, path, headers = calls[0]
    assert (method, path) == ('GET', '/api/oauth/usage')
    assert headers['Authorization'] == 'Bearer test-only-token'
    assert headers['anthropic-beta'] == 'oauth-2025-04-20'


@pytest.mark.parametrize('code,state', [(401, 'login_required'), (403, 'permission_required'),
                                      (429, 'rate_limited'), (302, 'error'), (500, 'error')])
def test_usage_errors_are_explicit_and_do_not_follow_redirects(usage_transport, code, state):
    module, _, calls, response = usage_transport
    response.status = code
    response.getheader = lambda name: '120'
    with pytest.raises(module.UsageError) as exc:
        module.query_status('claude.exe')
    assert exc.value.state == state
    if code == 429: assert exc.value.retry_after == 120
    assert len(calls) == 1


@pytest.mark.parametrize('auth,state', [({'loggedIn': False}, 'login_required'),
    ({'loggedIn': True, 'authMethod': 'api_key'}, 'unsupported')])
def test_no_usage_request_without_subscription_auth(usage_transport, auth, state):
    module, observed, calls, _ = usage_transport
    observed.clear(); observed.update(auth)
    with pytest.raises(module.UsageError) as exc:
        module.query_status('claude.exe')
    assert exc.value.state == state and calls == []


def test_retry_after_http_date_is_respected(usage_transport, monkeypatch):
    module, _, _, response = usage_transport
    response.status = 429
    response.getheader = lambda name: 'Thu, 01 Jan 2026 00:02:00 GMT'
    monkeypatch.setattr(module.time, 'time', lambda: 1767225600)
    with pytest.raises(module.UsageError) as exc:
        module.query_status('claude.exe')
    assert exc.value.retry_after == 120


def test_cache_shares_concurrent_reads_and_honors_retry_after(monkeypatch):
    from app.llm.claude_status import ClaudeStatus, UsageError
    monkeypatch.setattr('app.llm.claude_status.executable', lambda client, path: path)
    clock = [0]
    monkeypatch.setattr('app.llm.claude_status.time.monotonic', lambda: clock[0])
    calls = []
    def query(path):
        calls.append(path)
        raise UsageError('rate_limited', 120)
    status = ClaudeStatus(query)
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(lambda _: status.read('first'), range(8)))
    assert calls == ['first'] and all(row['state'] == 'rate_limited' for row in rows)
    clock[0] = 61
    status.read('first')
    assert calls == ['first']
    clock[0] = 121
    status.read('first')
    status.read('second')
    assert calls == ['first', 'first', 'second']


def test_network_failures_do_not_expose_secrets(monkeypatch):
    from app.llm.claude_status import ClaudeStatus
    monkeypatch.setattr('app.llm.claude_status.executable', lambda *args: 'claude.exe')
    def fail(path): raise OSError('private-token')
    result = ClaudeStatus(fail).read()
    assert result['state'] == 'error' and result['limits'] == []
    assert 'private-token' not in json.dumps(result)
