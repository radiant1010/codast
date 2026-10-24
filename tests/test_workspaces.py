import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.core.folder_picker import FolderPicker, choose_folder


@pytest.mark.parametrize('linked', [False, True])
@pytest.mark.parametrize('name', ['가상프로젝트', '테스트-Project_1', 'ㄱㄴ_실험', '\u1100\u1161'])
def test_korean_names_support_creation_selection_and_restore(tmp_path, linked, name):
    root = tmp_path / 'managed'
    external = tmp_path / 'external'
    external.mkdir()
    original = external / 'original.txt'
    original.write_text('keep this', encoding='utf-8')
    base = '/api/projects/' + quote(name, safe='')
    with TestClient(create_app(root)) as client:
        assert client.post('/api/projects', json={'name': 'legacy'}).status_code == 201
        route, body = ('/api/workspaces', {'name': name, 'path': str(external)}) if linked else ('/api/projects', {'name': name})
        response = client.post(route, json=body)
        assert response.status_code == 201, response.text
        expected_path = str((external if linked else root / name).resolve())
        assert client.get(base + '/workspace').json()['path'] == expected_path
        assert set(client.get('/api/projects').json()['projects']) == {'legacy', name}
        selected = client.put('/api/onboarding', json={'project': name, 'client': 'codex', 'deferred': True})
        assert selected.status_code == 200, selected.text
        assert selected.json()['project'] == name
        assert client.delete(base).status_code == 200
        assert client.get('/api/projects').json()['projects'] == ['legacy']
        assert name in client.get('/api/deleted-projects').json()['projects']
        assert client.post('/api/deleted-projects/' + quote(name, safe='') + '/restore').status_code == 200
    with TestClient(create_app(root)) as client:
        assert client.get(base + '/workspace').json()['path'] == expected_path
        assert client.get('/api/onboarding').json()['project'] == name
        assert set(client.get('/api/projects').json()['projects']) == {'legacy', name}
    assert original.read_text(encoding='utf-8') == 'keep this'
    assert not (external / '.harness').exists()


def test_korean_name_support_keeps_path_and_length_restrictions(tmp_path):
    root = tmp_path / 'managed'
    external = tmp_path / 'external'
    external.mkdir()
    with TestClient(create_app(root)) as client:
        for name in ('../가상', '가상/하위', '가상\\하위', '가상:비밀', '가상.', '가상 ', '가상 프로젝트', '-가상', '가' * 65, '가\n'):
            assert client.post('/api/projects', json={'name': name}).status_code == 422
            assert client.post('/api/workspaces', json={'name': name, 'path': str(external)}).status_code == 422
        for name in ('CON', 'NUL'):
            assert client.post('/api/projects', json={'name': name}).status_code == 403
        assert client.get('/api/projects').json()['projects'] == []
    assert list(external.iterdir()) == []


def test_external_workspace_registration_and_restore(tmp_path):
    root=tmp_path/'managed'; external=tmp_path/'external';external.mkdir()
    (external/'RULES.md').write_text('# Existing rules',encoding='utf-8')
    (external/'source').mkdir();(external/'source/a.md').write_text('original',encoding='utf-8')
    with TestClient(create_app(root)) as c:
        response=c.post('/api/workspaces',json={'name':'linked','path':str(external)})
        assert response.status_code==201
        assert not (external/'.harness').exists()
        assert c.get('/api/projects/linked/workspace').json()['path']==str(external.resolve())
        assert c.get('/api/projects/linked/file?path=source/a.md').json()['content']=='original'
        assert c.get('/api/projects/linked/file?path=../outside').status_code==403
        assert c.get('/api/projects/linked/file?path=.git/config').status_code==403
        assert c.post('/api/workspaces',json={'name':'duplicate','path':str(external)}).status_code==409
        assert c.put('/api/projects/linked/settings',json={'cwd':'source'}).status_code==200
        assert c.delete('/api/projects/linked').status_code==200
        assert not (external/'.harness').exists()
        assert c.post('/api/workspaces',json={'name':'duplicate','path':str(external)}).status_code==409
        assert c.post('/api/deleted-projects/linked/restore').status_code==200
    with TestClient(create_app(root)) as c:
        assert c.get('/api/projects/linked/settings').json()['cwd']=='source'
        assert (external/'RULES.md').read_text()=='# Existing rules'
        assert c.get('/api/projects').json()['projects']==['linked']
        assert c.post('/api/workspaces',json={'name':'bad','path':str(root)}).status_code==400
        assert c.post('/api/workspaces',json={'name':'bad','path':'relative'}).status_code==400
        assert c.post('/api/workspaces',json={'name':'bad','path':str(tmp_path/'missing')}).status_code==404
        assert c.post('/api/workspaces',json={'name':'bad','path':str(external)},headers={'origin':'https://elsewhere.test'}).status_code==403


def test_missing_external_folder_can_be_removed_and_restored(tmp_path):
    folder=tmp_path/'folder';folder.mkdir()
    with TestClient(create_app(tmp_path/'managed')) as c:
        c.post('/api/workspaces',json={'name':'linked','path':str(folder)})
        folder.rmdir()
        assert c.get('/api/projects/linked/workspace').status_code==404
        assert c.delete('/api/projects/linked').status_code==200
        folder.mkdir()
        assert c.post('/api/deleted-projects/linked/restore').status_code==200
        assert c.get('/api/projects/linked/workspace').status_code==200


def test_folder_picker_selection_and_cancel(tmp_path,monkeypatch):
    with TestClient(create_app(tmp_path/'managed')) as c:
        monkeypatch.setattr('app.core.folder_picker.choose_folder',lambda:str(tmp_path))
        assert c.post('/api/workspace-folder').json()=={'path':str(tmp_path)}
        monkeypatch.setattr('app.core.folder_picker.choose_folder',lambda:None)
        assert c.post('/api/workspace-folder').json()=={'path':None}
        assert c.post('/api/workspace-folder',headers={'origin':'https://elsewhere.test'}).status_code==403
    with patch('app.core.folder_picker.os.name','nt'), patch('app.core.folder_picker.subprocess.run') as runner:
        runner.return_value=SimpleNamespace(returncode=0,stdout=json.dumps({'path':str(tmp_path)}))
        assert choose_folder()==str(tmp_path)
        assert '-STA' in runner.call_args.args[0]
        assert runner.call_args.kwargs['timeout']==60
