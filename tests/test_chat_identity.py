import json
import sqlite3
import sys

import pytest
from fastapi.testclient import TestClient

from app.core.storage import Storage
from app.main import create_app
from app.llm.cli import CliAdapter
from app.models.schemas import AgentResult
from tests.test_runtime import wait_run


def test_real_v7_migration_preserves_messages_sessions_and_identity(tmp_path):
    path = tmp_path / 'db.sqlite3'
    storage = Storage(path)
    storage.add_message('one', 'keep message', 'old')
    for agent in ('codex', 'claude'):
        storage.save_session('one', 'old', agent, '.', 'read-only', agent + '-native')
    storage.update_task('one', 'old', pinned=True, archived=True)
    storage.save_rulebook_settings('one', {'books': []})
    with sqlite3.connect(path) as db:
        db.execute('DROP INDEX messages_chat_id')
        db.execute('DROP INDEX client_sessions_chat_id')
        db.execute('ALTER TABLE messages DROP COLUMN chat_id')
        db.execute('ALTER TABLE client_sessions DROP COLUMN chat_id')
        db.execute('DROP TABLE chats')
        db.execute('PRAGMA user_version=7')
    migrated = Storage(path)
    chat = migrated.tasks('one')[0]
    assert chat['pinned'] == chat['archived'] == 1
    assert migrated.rulebook_settings('one') == {'books': []}
    assert migrated.messages('one', None, 20, 0, chat['id'])[0]['text'] == 'keep message'
    restarted = Storage(path)
    assert restarted.tasks('one')[0]['id'] == chat['id']
    for agent in ('codex', 'claude'):
        assert restarted.session('one', '', agent, '.', 'read-only', chat_id=chat['id']) == agent + '-native'


@pytest.mark.parametrize('agent', ['codex', 'claude'])
def test_identity_survives_rename_restart_session_rotation_and_failure(tmp_path, monkeypatch, agent):
    calls = []
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)

    async def execute(self, context, cwd, mode, session=None):
        calls.append((json.loads(context), session, mode))
        if len(calls) == 5:
            raise RuntimeError('fixture interrupted native session')
        return AgentResult(adapter=self.client, output='result-' + str(len(calls)), session_id='native-' + str(len(calls)))

    monkeypatch.setattr(CliAdapter, 'execute', execute)
    root = tmp_path / 'ws'
    base = '/api/projects/one'
    payload = {'text': 'continue', 'task': 'original', 'client': agent, 'action': 'run', 'request_id': 'stable-request'}
    with TestClient(create_app(root)) as client:
        for name in ('one', 'two'):
            client.post('/api/projects', json={'name': name})
        chat_id = client.post(base + '/tasks', json={'task': 'original'}).json()['id']
        payload['chat_id'] = chat_id
        first = client.post(base + '/chat', json=payload).json()['run_id']
        assert wait_run(client, first)['status'] == 'completed'
        assert client.patch(base + '/tasks', json={'task': 'original', 'chat_id': chat_id, 'title': 'renamed'}).status_code == 200
        other_id = client.post(base + '/tasks', json={'task': 'original'}).json()['id']
        assert other_id != chat_id
        assert client.post('/api/projects/two/chat', json=payload).status_code == 404
        assert client.get('/api/projects/two/messages', params={'chat_id': chat_id}).status_code == 404
    with TestClient(create_app(root)) as client:
        # The old displayed title and a reused title must not redirect a retry.
        assert client.post(base + '/chat', json=payload).json()['run_id'] == first
        assert len(calls) == 1
        assert client.post(base + '/chat', json={**payload, 'chat_id': other_id}).status_code == 409
        payload.pop('request_id')
        for overrides in ({}, {}, {'fresh': True}, {}, {}):
            result = client.post(base + '/chat', json={**payload, **overrides})
            assert result.status_code == 200
            row = wait_run(client, result.json()['run_id'])
            assert row['status'] == ('failed' if len(calls) == 5 else 'completed')
            assert row['command']['chat_id'] == chat_id
            assert row['command']['task'] == 'renamed'
        assert [call[1] for call in calls] == [None, 'native-1', 'native-2', None, 'native-4', None]
        assert any(h['result'] == 'result-3' for h in calls[3][0]['history'])
        assert any(h['result'] == 'result-4' for h in calls[5][0]['history'])
        assert len(client.get(base + '/messages', params={'chat_id': chat_id}).json()['messages']) == 6
        assert client.get(base + '/messages', params={'chat_id': other_id}).json()['messages'] == []
        assert {r['id']: r['task'] for r in client.get(base + '/tasks').json()['tasks']}[chat_id] == 'renamed'
