import sqlite3

from fastapi.testclient import TestClient

from app.main import create_app
from app.core.storage import Storage


def test_conversation_persistence_routing_and_project_boundary(tmp_path):
    root = tmp_path / 'workspaces'
    with TestClient(create_app(root)) as client:
        for name in ('one', 'two'):
            assert client.post('/api/projects', json={'name': name}).status_code == 201
        base = '/api/projects/one'
        note = client.post(base + '/messages', json={'text': '나중에 로그인 개선', 'task': ' 로그인 '}).json()['id']
        assert client.get(base + '/runs').json()['runs'] == []
        client.post(base + '/messages', json={'text': '어디에 속할까'})
        run = client.post(base + '/commands', json={'text': '로그인 검토', 'task': '로그인'}).json()
        messages = client.get(base + '/messages?task=로그인').json()['messages']
        assert len(messages) == 2
        assert messages[0]['run_id'] == run['run_id']
        assert messages[0]['output'] == run['output']
        assert len(client.get(base + '/messages?task=').json()['messages']) == 1
        assert client.patch('/api/projects/two/messages/' + note, json={'task': '탈취'}).status_code == 404
        assert client.get('/api/projects/two/messages').json()['messages'] == []
        assert client.patch(base + '/messages/' + note, json={'task': '백로그'}).status_code == 200
        assert len(client.get(base + '/messages?task=로그인').json()['messages']) == 1
        assert client.get(base + '/messages?limit=1&offset=1').json()['messages'][0]['text'] == '어디에 속할까'
        assert client.post(base + '/messages', json={'text': '   '}).status_code == 422
        assert client.post(base + '/messages', json={'text': 'x'}, headers={'Origin': 'https://evil.example'}).status_code == 403
        assert client.get('/api/projects/missing/messages').status_code == 404
    with TestClient(create_app(root)) as client:
        assert len(client.get(base + '/messages').json()['messages']) == 3
        assert client.get(base + '/messages?task=백로그').json()['messages'][0]['id'] == note


def test_v1_migration_preserves_existing_records(tmp_path):
    path = tmp_path / 'old.sqlite3'
    with sqlite3.connect(path) as db:
        db.executescript('''
            CREATE TABLE project_settings(project TEXT PRIMARY KEY,settings TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE runs(id TEXT PRIMARY KEY,project TEXT NOT NULL,command TEXT NOT NULL,
                adapter TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,
                finished_at TEXT,output TEXT,error TEXT);
            PRAGMA user_version=1;
        ''')
        db.execute('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)',
                   ('old', 'one', '{"text":"old task"}', 'mock', 'completed', '2026-09-13', None, 'result', None))
        db.execute('INSERT INTO project_settings VALUES (?,?,?)', ('one', '{"cwd":"."}', '2026-09-13'))
    storage = Storage(path)
    assert storage.settings('one') == {'cwd': '.'}
    assert storage.runs('one', 20, 0)[0]['output'] == 'result'
    messages = storage.messages('one', None, 20, 0)
    assert messages[0]['text'] == 'old task'
    assert messages[0]['task'] == ''
    assert messages[0]['output'] == 'result'
    assert len(Storage(path).messages('one', None, 20, 0)) == 1


def test_failed_execution_visible_in_conversation(tmp_path):
    class BrokenAgent:
        async def run(self, context):
            raise ValueError('failed')

    with TestClient(create_app(tmp_path / 'workspaces', BrokenAgent())) as client:
        client.post('/api/projects', json={'name': 'one'})
        assert client.post('/api/projects/one/commands', json={'text': 'run', 'task': 'test'}).status_code == 400
        message = client.get('/api/projects/one/messages?task=test').json()['messages'][0]
        assert message['status'] == 'failed'
        assert message['error'] == 'failed'
