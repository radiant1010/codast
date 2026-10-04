import asyncio
from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import AgentResult, Command

class ControlledAgent:
    def __init__(self): self.calls = 0
    async def run(self, context):
        self.calls += 1
        if context.task == 'fail': raise RuntimeError('controlled failure')
        if context.task == 'wait': await asyncio.sleep(60)
        return AgentResult(adapter='mock', output='done')

def test_duplicate_requests_survive_completion_and_restart(tmp_path):
    agent=ControlledAgent()
    app=create_app(tmp_path/'ws',agent=agent)
    base='/api/projects/one'
    body={'text':'done','task':'A','action':'run','auto_route':False,'request_id':'retry-1'}
    with TestClient(app) as c:
        c.post('/api/projects',json={'name':'one'})
        first=c.post(base+'/chat',json=body).json()['run_id']
        c.get(base+'/runs/'+first+'/events')
        assert c.post(base+'/chat',json=body).json()['run_id']==first
        assert agent.calls==1
        assert c.post(base+'/chat',json={**body,'text':'changed'}).status_code==409
        assert len(c.get(base+'/messages').json()['messages'])==1
    with TestClient(create_app(tmp_path/'ws',agent=agent)) as c:
        assert c.post(base+'/chat',json=body).json()['run_id']==first
        assert agent.calls==1
        new=c.post(base+'/chat',json={**body,'request_id':'retry-2'}).json()['run_id']
        assert new!=first
        c.get(base+'/runs/'+new+'/events')
        assert agent.calls==2

def test_cancel_failure_and_orphan_recovery(tmp_path):
    agent=ControlledAgent();app=create_app(tmp_path/'ws',agent=agent)
    base='/api/projects/one'
    with TestClient(app) as c:
        c.post('/api/projects',json={'name':'one'})
        body={'text':'wait','task':'A','action':'run','request_id':'waiting'}
        run=c.post(base+'/chat',json=body).json()['run_id']
        assert c.post(base+'/chat',json=body).json()['run_id']==run
        assert c.post(base+'/chat',json={**body,'request_id':'other'}).status_code==409
        assert c.post(base+'/runs/'+run+'/cancel').status_code==200
        assert c.get(base+'/runs/'+run).json()['status']=='interrupted'
        failed=c.post(base+'/chat',json={**body,'text':'fail','request_id':'failure'}).json()['run_id']
        c.get(base+'/runs/'+failed+'/events')
        assert c.get(base+'/runs/'+failed).json()['status']=='failed'
        assert c.post(base+'/chat',json={**body,'text':'fail','request_id':'failure'}).json()['run_id']==failed
        orphan=app.state.harness.storage.start_run('one',Command(text='wait',task='A'),'mock')
    with TestClient(create_app(tmp_path/'ws',agent=agent)) as c:
        assert c.get(base+'/runs/'+orphan).json()['cancellable'] is False
        assert c.post(base+'/runs/'+orphan+'/reconcile').status_code==200
        recovered=c.post(base+'/chat',json={**body,'text':'done','request_id':'recovered'}).json()['run_id']
        c.get(base+'/runs/'+recovered+'/events')
        assert c.get(base+'/runs/'+recovered).json()['status']=='completed'

def test_concurrent_retry_reserves_one_run(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from app.core.storage import Storage, ExistingRun
    storage=Storage(tmp_path/'db.sqlite3')
    def reserve(_):
        try: return storage.start_run('one',Command(text='same',task='A'),'mock',exclusive=True,request_id='same-request')
        except ExistingRun as prior: return prior.run_id
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids=list(pool.map(reserve,range(8)))
    assert len(set(ids))==1
    assert len(storage.messages('one','A',20,0))==1
    assert len(storage.events('one',ids[0]))==1

def test_cancel_before_background_task_starts_clears_session(tmp_path):
    app=create_app(tmp_path/'ws',agent=ControlledAgent())
    s=app.state.harness;s.projects.create('one')
    cwd=str(s.projects.select('one'))
    s.storage.save_session('one','A','mock',cwd,'read-only','test-session')
    async def cancel_immediately():
        run=s.submit('one',Command(text='wait',task='A'))
        await s.cancel('one',run)
        assert s.storage.run('one',run)['status']=='interrupted'
        assert s.storage.session('one','A','mock',cwd,'read-only') is None
    asyncio.run(cancel_immediately())
