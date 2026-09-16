import json
from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient
from app.main import create_app
from app.llm.codex_status import CodexStatus, normalize


def test_normalize_preserves_zero_and_filters_account_secrets():
    result = normalize({'result': {'data': [{'id': 'm', 'model': 'm', 'isDefault': True}]}},
                       {'result': {'accountId': 'secret', 'rateLimitsByLimitId': {'codex': {
                           'credits': {'balance': 'secret'}, 'primary': {
                               'usedPercent': 0, 'windowDurationMins': 300, 'resetsAt': 123}}}}})
    assert result['limits'][0]['usedPercent'] == 0
    assert result['limits'][0]['windowDurationMins'] == 300
    assert 'secret' not in json.dumps(result)
    assert normalize({'error': {}}, {'result': {}})['limits_state'] == 'unavailable'


def test_concurrent_cache_and_path_change(monkeypatch):
    monkeypatch.setattr('app.llm.codex_status.executable', lambda client, path: path)
    calls = []
    def query(path):
        calls.append(path)
        return normalize({'result': {'data': []}}, {'error': {}})
    status = CodexStatus(query)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: status.read('first'), range(8)))
    assert calls == ['first']
    assert all(row['state'] == 'partial' for row in results)
    status.read('second')
    assert calls == ['first', 'second']


def test_failure_is_cached_and_api_is_read_only(tmp_path, monkeypatch):
    monkeypatch.setattr('app.llm.codex_status.executable', lambda *args: 'codex')
    calls = []
    def fail(path):
        calls.append(path)
        raise OSError('private details')
    app = create_app(tmp_path / 'projects', db_path=tmp_path / 'db.sqlite3')
    app.state.codex_status = CodexStatus(fail)
    with TestClient(app) as client:
        first = client.get('/api/clients/codex/status').json()
        second = client.get('/api/clients/codex/status').json()
        assert first == second
        assert first['state'] == 'error'
        assert 'private' not in json.dumps(first)
        assert client.get('/api/session-overview').json()['running'] == []
    assert len(calls) == 1
