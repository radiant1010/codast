import json
from uuid import uuid4
from fastapi.testclient import TestClient
from app.main import create_app


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
