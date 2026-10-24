import json
from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient
from app.main import create_app
from app.llm.codex_status import CodexStatus, normalize, query_status


def test_default_model_uses_effective_config_not_catalog_default(monkeypatch):
    calls = []
    def query(path, requests):
        calls.extend(requests)
        return [{'result': {'data': [{'model': 'catalog-model', 'isDefault': True}]}},
                {'error': {}}, {'result': {'config': {'model': 'configured-model', 'secret': 'private'}}}]
    monkeypatch.setattr('app.llm.codex_status.query_readonly', query)
    result = query_status('codex', cwd='C:/fixture/project')
    assert result['default_model'] == 'configured-model'
    assert calls[-1] == ('config/read', {'includeLayers': False, 'cwd': 'C:/fixture/project'})
    assert 'private' not in json.dumps(result)


def test_unknown_configuration_does_not_claim_catalog_model(monkeypatch):
    config = {'error': {}}
    monkeypatch.setattr('app.llm.codex_status.query_readonly', lambda *args: [
        {'result': {'data': [{'model': 'catalog-model', 'isDefault': True}]}}, {'error': {}}, config])
    assert query_status('codex')['default_model'] is None
    config.clear()
    config['result'] = {'config': {'model': None}}
    assert query_status('codex')['default_model'] == 'catalog-model'


def test_effective_effort_honors_config_and_model_support(monkeypatch):
    config = {'model': 'strong', 'model_reasoning_effort': 'xhigh'}
    models = [
        {'model': 'strong', 'defaultReasoningEffort': 'medium', 'supportedReasoningEfforts': [
            {'reasoningEffort': 'medium'}, {'reasoningEffort': 'xhigh'}]},
        {'model': 'small', 'defaultReasoningEffort': 'low', 'supportedReasoningEfforts': [
            {'reasoningEffort': 'low'}]}]
    monkeypatch.setattr('app.llm.codex_status.query_readonly', lambda *args: [
        {'result': {'data': models}}, {'error': {}}, {'result': {'config': config}}])
    rows = query_status('codex')['models']
    assert rows[0]['effectiveReasoningEffort'] == 'xhigh'
    assert 'effectiveReasoningEffort' not in rows[1]
    config['model_reasoning_effort'] = None
    assert [row['effectiveReasoningEffort'] for row in query_status('codex')['models']] == ['medium', 'low']


def test_failed_config_lookup_does_not_present_catalog_effort_as_effective(monkeypatch):
    monkeypatch.setattr('app.llm.codex_status.query_readonly', lambda *args: [
        {'result': {'data': [{'model': 'strong', 'defaultReasoningEffort': 'medium',
                             'supportedReasoningEfforts': [{'reasoningEffort': 'medium'}]}]}},
        {'error': {}}, {'error': {}}])
    assert 'effectiveReasoningEffort' not in query_status('codex')['models'][0]


def test_default_model_cache_is_scoped_to_workspace(monkeypatch):
    monkeypatch.setattr('app.llm.codex_status.executable', lambda client, path: path)
    calls = []
    def query(path, cwd=None):
        calls.append((path, cwd))
        return {'models_state': 'available', 'limits_state': 'available', 'default_model': cwd}
    status = CodexStatus(query)
    assert status.read('codex', cwd='first')['default_model'] == 'first'
    status.read('codex', cwd='first')
    assert status.read('codex', cwd='second')['default_model'] == 'second'
    assert calls == [('codex', 'first'), ('codex', 'second')]


def test_model_lookup_uses_registered_workspace_and_rejects_escape(tmp_path):
    app = create_app(tmp_path / 'projects', db_path=tmp_path / 'db.sqlite3')
    calls = []
    def read(path, cwd=None):
        calls.append(cwd)
        return {'default_model': 'fixture-model'}
    app.state.codex_status.read = read
    external = tmp_path / 'external'
    (external / 'sub').mkdir(parents=True)
    with TestClient(app) as client:
        assert client.post('/api/workspaces', json={'name': 'sample', 'path': str(external)}).status_code == 201
        result = client.get('/api/clients/codex/status', params={'project': 'sample', 'cwd': 'sub'})
        assert result.json()['default_model'] == 'fixture-model'
        assert calls == [str(external / 'sub')]
        assert client.get('/api/clients/codex/status', params={'project': 'sample', 'cwd': '../outside'}).status_code == 403
        assert client.get('/api/clients/codex/status', params={'project': 'sample', 'cwd': 'missing'}).status_code == 404
        assert len(calls) == 1


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
