import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.mark.parametrize('linked', [False, True])
def test_rename_preserves_workspace_history_settings_and_restore(tmp_path, linked):
    root = tmp_path / 'managed'
    external = tmp_path / 'external'
    external.mkdir()
    with TestClient(create_app(root)) as client:
        if linked:
            assert client.post('/api/workspaces', json={'name': 'original', 'path': str(external)}).status_code == 201
        else:
            assert client.post('/api/projects', json={'name': 'original'}).status_code == 201
        base = '/api/projects/original'
        client.put(base + '/file', json={'path': 'keep.txt', 'content': 'original content'})
        client.put(base + '/settings', json={'client': 'mock', 'mode': 'read-only'})
        client.put('/api/onboarding', json={'project': 'original', 'client': 'codex', 'deferred': True})
        run = client.post(base + '/commands', json={'text': 'saved command', 'task': 'saved chat'}).json()
        before = {key: client.get(base + '/' + key).json() for key in ('workspace', 'settings', 'messages', 'tasks', 'runs')}
        renamed = client.patch(base, json={'name': '수정한프로젝트'})
        assert renamed.status_code == 200, renamed.text
        assert renamed.json() == {'name': 'original', 'display_name': '수정한프로젝트'}
        assert client.get('/api/projects').json() == {'projects': ['original'], 'names': {'original': '수정한프로젝트'}}
        for key, value in before.items():
            assert client.get(base + '/' + key).json() == value
        assert client.get(base + '/runs').json()['runs'][0]['id'] == run['run_id']
        assert client.get(base + '/file?path=keep.txt').json()['content'] == 'original content'
        assert client.delete(base).status_code == 200
        assert client.get('/api/deleted-projects').json()['names']['original'] == '수정한프로젝트'
        assert client.post('/api/deleted-projects/original/restore').status_code == 200
    with TestClient(create_app(root)) as client:
        assert client.get('/api/projects').json()['names']['original'] == '수정한프로젝트'
        assert client.get(base + '/workspace').json() == before['workspace']
        assert client.get('/api/onboarding').json()['project'] == 'original'
        assert client.patch(base, json={'name': '수정한프로젝트'}).status_code == 200
        assert client.patch(base, json={'name': 'Original'}).status_code == 200
    assert (root / 'original').is_dir()
    assert not (root / '수정한프로젝트').exists()
    assert not (external / '.harness').exists()


def test_project_names_reject_collisions_invalid_input_and_cross_origin(tmp_path):
    external = tmp_path / 'external'
    external.mkdir()
    with TestClient(create_app(tmp_path / 'managed')) as client:
        for name in ('one', 'two'):
            client.post('/api/projects', json={'name': name})
        base = '/api/projects/one'
        assert client.patch('/api/projects/two', json={'name': '다른이름'}).status_code == 200
        for name in ('two', 'TWO', '다른이름'):
            assert client.patch(base, json={'name': name}).status_code == 409
        client.delete('/api/projects/two')
        assert client.patch(base, json={'name': '다른이름'}).status_code == 409
        assert client.post('/api/projects', json={'name': '다른이름'}).status_code == 409
        assert client.post('/api/workspaces', json={'name': '다른이름', 'path': str(external)}).status_code == 409
        for name in ('', '../outside', '가상/하위', '가상\\하위', '가상\n', '가' * 65):
            assert client.patch(base, json={'name': name}).status_code == 422
        assert client.patch(base, json={'name': 'CON'}).status_code == 403
        assert client.patch(base, json={'name': '변경'}, headers={'origin': 'https://elsewhere.test'}).status_code == 403
        assert client.patch('/api/projects/missing', json={'name': '변경'}).status_code == 404
        assert client.patch('/api/projects/two', json={'name': '변경'}).status_code == 404
        assert client.get('/api/projects').json()['names']['one'] == 'one'
        assert client.patch(base, json={'name': '가'}).status_code == 200
        assert client.post('/api/projects', json={'name': '\u1100\u1161'}).status_code == 409


def test_concurrent_name_changes_cannot_claim_the_same_label(tmp_path):
    with TestClient(create_app(tmp_path / 'managed')) as client:
        for name in ('one', 'two'):
            client.post('/api/projects', json={'name': name})
        ready = Barrier(2)

        def rename(name):
            ready.wait(timeout=5)
            return client.patch('/api/projects/' + name, json={'name': '공통이름'}).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            assert sorted(pool.map(rename, ('one', 'two'))) == [200, 409]
        assert list(client.get('/api/projects').json()['names'].values()).count('공통이름') == 1


def test_running_project_can_change_its_label_without_interrupting_the_run(tmp_path):
    class Slow:
        async def run(self, context):
            await asyncio.sleep(30)

    with TestClient(create_app(tmp_path / 'managed', Slow())) as client:
        client.post('/api/projects', json={'name': 'one'})
        run = client.post('/api/projects/one/chat', json={'text': 'test', 'action': 'run'}).json()['run_id']
        assert client.patch('/api/projects/one', json={'name': '변경'}).status_code == 200
        assert client.get('/api/projects/one/runs/' + run).json()['status'] == 'running'
        assert client.post('/api/projects/one/runs/' + run + '/cancel').status_code == 200


def test_failed_name_save_keeps_previous_label_and_removes_temporary_file(tmp_path, monkeypatch):
    app = create_app(tmp_path / 'managed')
    with TestClient(app) as client:
        client.post('/api/projects', json={'name': 'one'})
        assert client.patch('/api/projects/one', json={'name': '기존이름'}).status_code == 200
        original = Path.replace

        def fail_name_save(path, target):
            if Path(target).name == 'project-name.json':
                raise OSError('test write failure')
            return original(path, target)

        monkeypatch.setattr(Path, 'replace', fail_name_save)
        response = client.patch('/api/projects/one', json={'name': '새이름'})
        assert response.status_code == 400
        assert '저장' in response.json()['detail']
        assert client.get('/api/projects').json()['names']['one'] == '기존이름'
        assert not (app.state.harness.projects.entry('one') / '.harness/project-name.tmp').exists()
