import sqlite3

from fastapi.testclient import TestClient

from app.core.storage import Storage
from app.main import create_app
from app.models.schemas import Command


def test_pin_archive_restart_restore_and_rename_preserve_data(tmp_path):
    root = tmp_path / 'ws'
    app = create_app(root)
    storage = app.state.harness.storage
    with TestClient(app) as client:
        for project in ('one', 'two'):
            client.post('/api/projects', json={'name': project})
            client.post(f'/api/projects/{project}/tasks', json={'task': 'chat'})
        storage.add_message('one', 'saved message', 'chat')
        storage.save_session('one', 'chat', 'codex', '.', 'read-only', 'fixture-native')
        assert client.patch('/api/projects/one/tasks', json={'task': 'chat', 'pinned': True, 'archived': True}).status_code == 200
        assert client.get('/api/projects/two/tasks').json()['tasks'][0]['pinned'] == 0
        assert client.patch('/api/projects/two/tasks', json={'task': 'missing', 'archived': True}).status_code == 404
    with TestClient(create_app(root)) as client:
        row = client.get('/api/projects/one/tasks').json()['tasks'][0]
        assert row['pinned'] == row['archived'] == 1
        assert client.patch('/api/projects/one/tasks', json={'task': 'chat', 'archived': False}).status_code == 200
        assert client.patch('/api/projects/one/tasks', json={'task': 'chat', 'title': 'renamed'}).status_code == 200
        row = client.get('/api/projects/one/tasks').json()['tasks'][0]
        assert row['task'] == 'renamed' and row['pinned'] == 1 and row['archived'] == 0
        assert client.get('/api/projects/one/messages?task=renamed').json()['messages'][0]['text'] == 'saved message'
        assert storage.session('one', 'renamed', 'codex', '.', 'read-only') == 'fixture-native'


def test_preferences_do_not_cancel_running_task_and_pin_sorts_first(tmp_path):
    storage = Storage(tmp_path / 'db.sqlite3')
    storage.create_task('one', 'old')
    storage.create_task('one', 'new')
    run = storage.start_run('one', Command(text='work', task='new'), 'mock')
    storage.update_task('one', 'old', pinned=True)
    storage.update_task('one', 'new', archived=True)
    assert storage.tasks('one')[0]['task'] == 'old'
    assert storage.run('one', run)['status'] == 'running'
    storage.update_task('one', 'old', pinned=False)
    assert storage.tasks('one')[0]['task'] == 'new'


def test_v5_migration_preserves_existing_chat_and_native_session(tmp_path):
    path = tmp_path / 'db.sqlite3'
    storage = Storage(path)
    storage.create_task('one', 'saved')
    storage.save_session('one', 'saved', 'codex', '.', 'read-only', 'fixture-native')
    with sqlite3.connect(path) as db:
        db.execute('DROP TABLE chat_preferences')
        db.execute('PRAGMA user_version=5')
    migrated = Storage(path)
    assert migrated.tasks('one') == [{'task': 'saved', 'count': 0, 'status': 'active', 'pinned': 0, 'archived': 0}]
    assert migrated.session('one', 'saved', 'codex', '.', 'read-only') == 'fixture-native'
    with migrated.connect() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 6
