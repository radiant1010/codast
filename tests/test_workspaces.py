import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.main import create_app
from app.core.folder_picker import FolderPicker, choose_folder


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
        assert runner.call_args.kwargs['timeout']==180
