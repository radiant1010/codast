import asyncio
from fastapi.testclient import TestClient
from app.main import create_app


def test_project_delete_restore_preserves_files_and_history(tmp_path):
    root=tmp_path/'ws'
    with TestClient(create_app(root)) as c:
        for name in ('one','two'):
            assert c.post('/api/projects',json={'name':name}).status_code==201
        c.put('/api/projects/one/file',json={'path':'source/keep.md','content':'keep this'})
        result=c.post('/api/projects/one/commands',json={'text':'test','task':'test'}).json()
        assert c.delete('/api/projects/one').json()=={'deleted':True,'recoverable':True}
        assert c.get('/api/projects').json()['projects']==['two']
        assert c.get('/api/deleted-projects').json()['projects']==['one']
        for path in ('settings','files','messages','runs'):
            assert c.get('/api/projects/one/'+path).status_code==404
        assert c.post('/api/projects/one/chat',json={'text':'test','action':'run'}).status_code==404
        assert c.post('/api/projects',json={'name':'one'}).status_code==409
        assert (root/'one/source/keep.md').read_text()=='keep this'
    with TestClient(create_app(root)) as c:
        assert c.get('/api/deleted-projects').json()['projects']==['one']
        assert c.post('/api/deleted-projects/one/restore').status_code==200
        assert c.get('/api/projects').json()['projects']==['one','two']
        assert c.get('/api/projects/one/runs').json()['runs'][0]['id']==result['run_id']
        assert c.get('/api/projects/one/file?path=source/keep.md').json()['content']=='keep this'
        assert c.get('/api/deleted-projects').json()['projects']==[]
        assert c.delete('/api/projects/missing').status_code==404
        assert c.delete('/api/projects/one',headers={'origin':'https://example.com'}).status_code==403
        assert c.get('/api/projects/one/file?path=.harness/deleted.json').status_code==403


def test_project_delete_refuses_active_and_unconfirmed_runs(tmp_path):
    class Slow:
        async def run(self,context):
            await asyncio.sleep(30)
    app=create_app(tmp_path/'ws',Slow())
    with TestClient(app) as c:
        c.post('/api/projects',json={'name':'one'})
        run=c.post('/api/projects/one/chat',json={'text':'test','action':'run'}).json()['run_id']
        assert c.delete('/api/projects/one').status_code==409
        assert c.post('/api/projects/one/runs/'+run+'/cancel').status_code==200
        assert c.delete('/api/projects/one').status_code==200
