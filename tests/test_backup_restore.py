"""DB snapshot recovery with synthetic data; native CLI validity is out of scope."""
import json
import sqlite3
import sys
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from app.core.storage import Storage
from app.llm.cli import CliAdapter
from app.main import create_app
from app.models.schemas import AgentResult, Command
from tests.test_runtime import wait_run


def backup(source, destination):
    with closing(sqlite3.connect(source)) as src, closing(sqlite3.connect(destination)) as dst:
        src.backup(dst)
        assert dst.execute('PRAGMA integrity_check').fetchone() == ('ok',)
        assert dst.execute('PRAGMA foreign_key_check').fetchall() == []


@pytest.mark.parametrize('agent', ['codex', 'claude'])
def test_backup_restores_question_reply_and_native_connection(tmp_path, monkeypatch, agent):
    calls = []
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)

    async def execute(self, context, cwd, mode, session=None):
        calls.append((self.client, json.loads(context), str(cwd), mode, session))
        question = '```codast-question\n{"question":"Choose format","choices":["CSV","JSON"]}\n```'
        return AgentResult(adapter=self.client, output=question if len(calls) == 1 else 'continued',
                           session_id='fixture-native', usage={'input_tokens': 12, 'output_tokens': 3})

    monkeypatch.setattr(CliAdapter, 'execute', execute)
    root = tmp_path / 'workspace'
    source, snapshot, restored = (tmp_path / name for name in ('source.db', 'snapshot.db', 'restored.db'))
    base = '/api/projects/one'
    app = create_app(root, db_path=source)
    with TestClient(app) as client, closing(sqlite3.connect(source)) as keeper:
        # Keep the WAL open and disable checkpointing on the connection doing the final write.
        keeper.execute('PRAGMA wal_autocheckpoint=0')
        assert client.post('/api/projects', json={'name': 'one'}).status_code == 201
        payload = {'text': 'ask', 'task': 'original', 'client': agent, 'action': 'run', 'request_id': 'ask-once'}
        run = client.post(base + '/chat', json=payload).json()['run_id']
        record = wait_run(client, run)
        assert record['status'] == 'completed'
        chat = record['command']['chat_id']
        payload['chat_id'] = chat
        assert client.patch(base + '/tasks', json={'task': 'original', 'chat_id': chat, 'title': 'renamed', 'pinned': True}).status_code == 200
        assert client.post(base + '/tasks', json={'task': 'empty'}).status_code == 201
        keeper.execute('INSERT OR REPLACE INTO rulebook_settings VALUES (?, ?)', ('one', '{"books":[]}'))
        keeper.commit()
        assert source.with_name(source.name + '-wal').stat().st_size > 0
        expected = {route: client.get(base + route, params={'chat_id': chat} if route in ('/messages', '/questions') else {}).json()
                    for route in ('/tasks', '/messages', '/questions', '/runs/' + run)}
        events = app.state.harness.storage.events('one', run)
        backup(source, snapshot)
        # A later source change must not appear in the restored snapshot.
        app.state.harness.storage.add_message('one', 'after backup', 'renamed')

    backup(snapshot, restored)
    restored_app = create_app(root, db_path=restored)
    with TestClient(restored_app) as client:
        assert len(calls) == 1
        for route, value in expected.items():
            assert client.get(base + route, params={'chat_id': chat} if route in ('/messages', '/questions') else {}).json() == value
        storage = restored_app.state.harness.storage
        assert storage.events('one', run) == events
        assert storage.rulebook_settings('one') == {'books': []}
        assert client.post(base + '/chat', json=payload).json()['run_id'] == run
        assert len(calls) == 1
        reply = {'answer': 'CSV', 'request_id': 'reply-once'}
        response = client.post(base + '/runs/' + run + '/reply', json=reply)
        assert response.status_code == 200
        follow = response.json()['run_id']
        assert wait_run(client, follow)['status'] == 'completed'
        assert calls[1][0] == agent and calls[1][2:] == (calls[0][2], 'read-only', 'fixture-native')
        assert 'CSV' in calls[1][1]['task']
        assert client.post(base + '/runs/' + run + '/reply', json=reply).json()['run_id'] == follow
        assert len(calls) == 2
    with TestClient(create_app(root, db_path=restored)) as client:
        assert client.get(base + '/questions', params={'chat_id': chat}).json()['messages'] == []
        assert client.post(base + '/runs/' + run + '/reply', json=reply).json()['run_id'] == follow
        assert len(calls) == 2
    assert Storage(source).run('one', run)['metadata'].get('reply_run_id') is None


def test_restore_running_record_does_not_restart_or_claim_completion(tmp_path, monkeypatch):
    async def unexpected_execute(*args, **kwargs):
        pytest.fail('Restoring a database must not execute a CLI')

    monkeypatch.setattr(CliAdapter, 'execute', unexpected_execute)
    root = tmp_path / 'workspace'
    source, restored = tmp_path / 'source.db', tmp_path / 'restored.db'
    with TestClient(create_app(root, db_path=source)) as client:
        assert client.post('/api/projects', json={'name': 'one'}).status_code == 201
    storage = Storage(source)
    run = storage.start_run('one', Command(text='fixture running', task='chat', client='codex'), 'codex')
    storage.append_event(run, 'output', 'fixture progress')
    backup(source, restored)
    app = create_app(root, db_path=restored)
    with TestClient(app) as client:
        base = '/api/projects/one/runs/' + run
        assert client.get(base).json()['status'] == 'running'
        response = client.get(base + '/events')
        assert 'fixture progress' in response.text
        assert 'event: detached' in response.text
        assert 'event: end' not in response.text
        assert client.get(base).json()['status'] == 'running'
        assert app.state.harness.active == {}
