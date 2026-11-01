import json
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.core import claude_threads


def test_claude_preview_attach_and_project_boundary(tmp_path, monkeypatch):
    home = tmp_path/'claude'
    monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(home))
    folder = home/'projects'/'test'
    folder.mkdir(parents=True)
    app = create_app(tmp_path/'ws')
    with TestClient(app) as c:
        c.post('/api/projects', json={'name':'one'})
        c.post('/api/projects', json={'name':'two'})
        root = app.state.harness.projects.select('one')
        identity = str(uuid4())
        rows = [{'type':'user','cwd':str(root),'sessionId':identity,'message':{'content':'hello'}},
                {'type':'assistant','cwd':str(root),'sessionId':identity,'message':{'content':[
                    {'type':'thinking','thinking':'private reasoning'}, {'type':'text','text':'answer'},
                    {'type':'tool_use','name':'private tool'}]}}]
        (folder/(identity+'.jsonl')).write_text('\n'.join(map(json.dumps,rows)), encoding='utf-8')
        base='/api/projects/one/native-threads/claude'
        assert c.get(base).json()['threads'][0]['id']==identity
        preview=c.get(base+'/'+identity).json()
        assert preview['messages']==[{'role':'user','text':'hello'},{'role':'assistant','text':'answer'}]
        assert 'private' not in json.dumps(preview)
        assert c.get('/api/projects/two/native-threads/claude').json()['threads']==[]
        assert c.get('/api/projects/two/native-threads/claude/'+identity).status_code==404
        assert c.post(base+'/'+identity+'/attach',json={'task':'imported'}).json()['client']=='claude'
        assert app.state.harness.storage.session('one','imported','claude',str(root),'read-only')==identity
        assert c.post(base+'/'+identity+'/attach',json={'task':'imported'}).status_code==409
        assert c.get('/api/projects/one/native-threads/unknown').status_code==400


def test_foreign_large_transcript_does_not_block_project_listing(tmp_path, monkeypatch):
    monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(tmp_path/'claude'))
    folder = claude_threads.transcript_root()/'fixture'
    folder.mkdir(parents=True)
    selected, foreign = str(uuid4()), str(uuid4())
    for identity, root in ((selected, tmp_path), (foreign, tmp_path/'other')):
        path = folder/(identity+'.jsonl')
        path.write_text(json.dumps({'type':'user', 'cwd':str(root), 'sessionId':identity, 'message':{'content':'hello'}})+'\n', encoding='utf-8')
        if identity == foreign:
            with path.open('ab') as stream:
                stream.truncate(16 * 1024 * 1024 + 1)
    assert [row['id'] for row in claude_threads.list_threads(tmp_path)['threads']] == [selected]
    with pytest.raises(FileNotFoundError):
        claude_threads.read_thread(tmp_path, foreign)
    with pytest.raises(ValueError, match='16 MiB'):
        claude_threads.read_thread(tmp_path/'other', foreign)


def test_large_transcript_without_project_metadata_still_has_read_limit(tmp_path):
    path = tmp_path/(str(uuid4())+'.jsonl')
    with path.open('wb') as stream:
        stream.truncate(16 * 1024 * 1024 + 1)
    with pytest.raises(ValueError, match='16 MiB'):
        claude_threads.read_file(path, tmp_path)
