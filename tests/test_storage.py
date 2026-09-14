import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from app.main import create_app
from app.core.storage import Storage
from app.models.schemas import Command


def test_restart_restores_settings_and_history(tmp_path):
    root = tmp_path / 'workspaces'
    with TestClient(create_app(root)) as client:
        client.post('/api/projects', json={'name': 'one'})
        client.post('/api/projects', json={'name': 'two'})
        client.put('/api/projects/one/file', json={'path': 'source/a.py', 'content': 'print(1)'})
        settings = {'cwd': 'source', 'context_paths': ['source/a.py'], 'client': 'mock', 'mode': 'read-only'}
        assert client.put('/api/projects/one/settings', json=settings).status_code == 200
        result = client.post('/api/projects/one/commands', json={'text': "it's a task; DROP TABLE runs;", **settings})
        assert result.status_code == 200
        run_id = result.json()['run_id']
    with TestClient(create_app(root)) as client:
        assert client.get('/api/projects/one/settings').json() == settings
        assert client.get('/api/projects/two/settings').json() == {'cwd': '.', 'context_paths': [], 'client': 'mock', 'mode': 'read-only'}
        records = client.get('/api/projects/one/runs').json()['runs']
        assert len(records) == 1
        assert records[0]['id'] == run_id
        assert records[0]['status'] == 'completed'
        assert records[0]['finished_at']
        assert records[0]['command']['text'] == "it's a task; DROP TABLE runs;"
        assert records[0]['output'] == result.json()['output']
        assert client.get('/api/projects/two/runs').json() == {'runs': []}
        assert client.get('/api/projects').json()['projects'] == ['one', 'two']
        assert client.get('/api/projects/missing/runs').status_code == 404
        assert client.get('/api/projects/one/runs?limit=101').status_code == 422
        assert client.get('/api/projects/one/runs?offset=-1').status_code == 422


def test_failure_and_cancellation_are_recorded(tmp_path):
    class BrokenAgent:
        async def run(self, context):
            raise ValueError('adapter failed')

    app = create_app(tmp_path / 'workspaces', BrokenAgent())
    with TestClient(app) as client:
        client.post('/api/projects', json={'name': 'sample'})
        assert client.post('/api/projects/sample/commands', json={'text': 'run'}).status_code == 400
        run = client.get('/api/projects/sample/runs').json()['runs'][0]
        assert run['status'] == 'failed'
        assert run['error'] == 'adapter failed'

    class CancelledAgent:
        async def run(self, context):
            raise asyncio.CancelledError()

    app.state.harness.agent = CancelledAgent()
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(app.state.harness.execute('sample', Command(text='cancel')))
    assert app.state.harness.storage.runs('sample', 1, 0)[0]['status'] == 'interrupted'


def test_settings_validate_paths_and_origin(tmp_path):
    with TestClient(create_app(tmp_path / 'workspaces')) as client:
        client.post('/api/projects', json={'name': 'sample'})
        for settings in ({'cwd': '../outside'}, {'context_paths': ['.env']}, {'context_paths': ['.harness/harness.sqlite3']}):
            assert client.put('/api/projects/sample/settings', json=settings).status_code == 403
        assert client.put('/api/projects/sample/settings', json={'cwd': 'missing'}).status_code == 404
        assert client.put('/api/projects/sample/settings', json={'cwd': '.'}, headers={'Origin': 'https://evil.example'}).status_code == 403
        assert client.get('/api/projects/sample/settings').json() == {'cwd': '.', 'context_paths': [], 'client': 'mock', 'mode': 'read-only'}


def test_concurrent_writes_and_pagination(tmp_path):
    storage = Storage(tmp_path / 'db.sqlite3')

    def run(index):
        run_id = storage.start_run('sample', Command(text=str(index)), 'mock')
        storage.finish_run(run_id, 'completed', output=str(index))

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(run, range(12)))
    records = storage.runs('sample', 20, 0)
    assert len(records) == 12
    assert all(r['status'] == 'completed' for r in records)
    assert storage.runs('sample', 5, 5) == records[5:10]
    # Opening storage again must never relabel a live worker's running task.
    live = storage.start_run('sample', Command(text='live'), 'mock')
    reopened = Storage(storage.path)
    assert reopened.runs('sample', 1, 0)[0]['id'] == live
    assert reopened.runs('sample', 1, 0)[0]['status'] == 'running'
