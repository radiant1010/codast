import json
import sys
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import AgentResult
from app.llm.cli import CliAdapter
from app.core.questions import parse_question
from tests.test_runtime import wait_run

QUESTION='```codast-question\n'+json.dumps({'question':'Which format?','choices':['CSV','JSON']})+'\n```'


def test_question_protocol_requires_explicit_complete_valid_output():
    assert parse_question(QUESTION)['choices']==['CSV','JSON']
    for output in ['Which format?', 'Example: '+QUESTION, QUESTION+' explanation', '```codast-question\n{"question":""}\n```', '```codast-question\n{"question":"ok","choices":["x"],"approve":true}\n```']:
        assert parse_question(output) is None


@pytest.mark.parametrize('agent',['codex','claude'])
def test_question_restart_reply_identity_permissions_and_duplicate(tmp_path,monkeypatch,agent):
    calls=[]
    monkeypatch.setattr('app.core.orchestrator.executable',lambda *args:sys.executable)
    async def execute(self,context,cwd,mode,session=None):
        calls.append((self.client,json.loads(context),cwd,mode,session))
        return AgentResult(adapter=self.client,output=QUESTION if len(calls)==1 else 'continued',session_id='fixture-native')
    monkeypatch.setattr(CliAdapter,'execute',execute)
    root=tmp_path/'ws';base='/api/projects/one'
    with TestClient(create_app(root)) as client:
        for project in ('one','two'):client.post('/api/projects',json={'name':project})
        run=client.post(base+'/chat',json={'text':'ask','task':'chat','client':agent,'action':'run'}).json()['run_id']
        row=wait_run(client,run);chat=row['command']['chat_id']
        assert row['metadata']['question']['question']=='Which format?'
        assert len(calls)==1  # No automatic continuation.
        assert client.get('/api/notifications').json()['events'][0]['awaiting_answer']==1
    with TestClient(create_app(root)) as client:
        assert len(client.get(base+'/questions',params={'chat_id':chat}).json()['messages'])==1
        assert client.get('/api/projects/two/questions',params={'chat_id':chat}).status_code==404
        assert client.patch(base+'/tasks',json={'task':'chat','title':'renamed'}).status_code==200
        reply={'answer':'CSV','request_id':'reply-once'}
        assert client.post('/api/projects/two/runs/'+run+'/reply',json=reply).status_code==404
        assert client.post(base+'/runs/'+run+'/reply',json={**reply,'mode':'workspace-write'}).status_code==422
        response=client.post(base+'/runs/'+run+'/reply',json=reply)
        assert response.status_code==200
        follow=response.json()['run_id'];assert wait_run(client,follow)['status']=='completed'
        assert client.post(base+'/runs/'+run+'/reply',json=reply).json()['run_id']==follow
        assert client.post(base+'/runs/'+run+'/reply',json={**reply,'request_id':'different'}).status_code==409
        assert client.post(base+'/runs/'+run+'/reply',json={**reply,'answer':'JSON'}).status_code==409
        assert len(calls)==2 and calls[1][0]==agent and calls[1][3]=='read-only' and calls[1][4]=='fixture-native'
        assert 'CSV' in calls[1][1]['task'] and 'Which format?' in calls[1][1]['task']
        assert client.get(base+'/questions',params={'chat_id':chat}).json()['messages']==[]
        assert client.get(base+'/runs/'+run).json()['metadata']['reply_run_id']==follow
        assert client.get(base+'/runs/'+follow).json()['command']['task']=='renamed'


def test_new_request_supersedes_old_question_and_failed_preparation_keeps_it(tmp_path,monkeypatch):
    monkeypatch.setattr('app.core.orchestrator.executable',lambda *args:sys.executable)
    async def execute(self,*args,**kwargs):return AgentResult(adapter='codex',output=QUESTION,session_id='fixture')
    monkeypatch.setattr(CliAdapter,'execute',execute)
    with TestClient(create_app(tmp_path/'ws')) as client:
        client.post('/api/projects',json={'name':'one'});base='/api/projects/one'
        body={'text':'ask','task':'chat','client':'codex','action':'run'}
        run=client.post(base+'/chat',json=body).json()['run_id'];chat=wait_run(client,run)['command']['chat_id']
        def missing(*args):raise FileNotFoundError('missing client')
        monkeypatch.setattr('app.core.orchestrator.executable',missing)
        reply={'answer':'answer','request_id':'answer'}
        assert client.post(base+'/runs/'+run+'/reply',json=reply).status_code==404
        assert len(client.get(base+'/questions',params={'chat_id':chat}).json()['messages'])==1
        monkeypatch.setattr('app.core.orchestrator.executable',lambda *args:sys.executable)
        new=client.post(base+'/chat',json=body).json()['run_id'];wait_run(client,new)
        assert client.post(base+'/runs/'+run+'/reply',json=reply).status_code==409
        assert client.get(base+'/questions',params={'chat_id':chat}).json()['messages'][0]['run_id']==new
