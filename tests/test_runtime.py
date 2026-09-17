import asyncio
import json
import sys
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import AgentResult, Command
from app.llm.cli import CliAdapter, ProcessRunner


def wait_run(client, run_id):
    for _ in range(100):
        row = client.get('/api/projects/one/runs/'+run_id).json()
        if row['status'] != 'running':
            return row
        time.sleep(.02)
    raise AssertionError('run did not finish')


def test_chat_routes_without_execution_and_asks_for_ambiguous_run(tmp_path):
    with TestClient(create_app(tmp_path/'ws')) as c:
        c.post('/api/projects', json={'name':'one'})
        base='/api/projects/one'
        first=c.post(base+'/chat', json={'text':'로그인 기능 만들자'}).json()
        assert first['routing']['task']=='로그인'
        assert c.get(base+'/runs').json()['runs']==[]
        second=c.post(base+'/chat', json={'text':'인증 오류도 확인하자'}).json()
        assert second['routing']['task']=='로그인'
        c.post(base+'/chat', json={'text':'DB 마이그레이션 만들자'})
        assert c.post(base+'/route',json={'text':'로그인 검토해줘'}).json()['task']=='로그인'
        ambiguous=c.post(base+'/chat',json={'text':'그거 계속해줘','action':'run'}).json()
        assert ambiguous['needs_selection']
        assert c.get(base+'/runs').json()['runs']==[]
        chosen=c.post(base+'/chat',json={'text':'그거 계속해줘','task':'로그인','action':'run'}).json()
        assert wait_run(c,chosen['run_id'])['status']=='completed'
        assert c.post(base+'/route',json={'text':'[DB] 스키마 검토'}).json()['task']=='DB'
        assert c.post('/api/projects/missing/route',json={'text':'hello'}).status_code==404
        c.post(base+'/chat',json={'text':'로그인 작업은 나중에 하자'})
        assert next(t for t in c.get(base+'/tasks').json()['tasks'] if t['task']=='로그인')['status']=='paused'


def test_session_resume_handoff_and_move_invalidates_native_history(tmp_path,monkeypatch):
    calls=[]
    monkeypatch.setattr('app.core.orchestrator.executable',lambda *args:sys.executable)

    async def fake(self,context,cwd,mode,session=None):
        calls.append((self.client,json.loads(context),session,mode))
        return AgentResult(adapter=self.client,output=self.client+' result',session_id=self.client+'-session',usage={'input_tokens':10})
    monkeypatch.setattr(CliAdapter,'execute',fake)
    root=tmp_path/'ws'
    with TestClient(create_app(root)) as c:
        c.post('/api/projects',json={'name':'one'})
        base='/api/projects/one'
        c.post(base+'/messages',json={'text':'로그인은 이메일 사용','task':'로그인'})
        for client in ('codex','claude','codex'):
            r=c.post(base+'/chat',json={'text':'검토','task':'로그인','client':client,'action':'run'}).json()
            assert wait_run(c,r['run_id'])['status']=='completed'
        assert calls[0][2] is None
        assert calls[1][2] is None
        assert any(h['result']=='codex result' for h in calls[1][1]['history'])
        assert calls[2][2]=='codex-session'
        assert any(h['result']=='claude result' for h in calls[2][1]['history'])
    with TestClient(create_app(root)) as c:
        r=c.post(base+'/chat',json={'text':'이어서','task':'로그인','client':'codex','action':'run'}).json()
        assert wait_run(c,r['run_id'])['metadata']['resumed']
        assert calls[-1][2]=='codex-session'
        assert c.patch(base+'/tasks',json={'task':'로그인','title':'인증 개선','status':'paused'}).status_code==200
        r=c.post(base+'/chat',json={'text':'검토','task':'인증 개선','client':'codex','action':'run'}).json()
        assert wait_run(c,r['run_id'])['status']=='completed'
        assert calls[-1][2] is None


def test_background_cancel_and_project_exclusion(tmp_path):
    class Slow:
        async def run(self,context):
            await asyncio.sleep(30)
            return AgentResult(adapter='mock',output='done')
    with TestClient(create_app(tmp_path/'ws',Slow())) as c:
        for name in ('one','two'):
            c.post('/api/projects',json={'name':name})
        base='/api/projects/one'
        r=c.post(base+'/chat',json={'text':'run','task':'work','action':'run'}).json()
        assert c.post(base+'/chat',json={'text':'run2','task':'work','action':'run'}).status_code==409
        assert c.post(base+'/chat',json={'text':'메모','task':'work'}).status_code==200
        assert c.get('/api/projects/two/runs/'+r['run_id']).status_code==404
        assert c.post(base+'/runs/'+r['run_id']+'/reconcile').status_code==409
        assert c.post(base+'/runs/'+r['run_id']+'/cancel').status_code==200
        assert wait_run(c,r['run_id'])['status']=='interrupted'


def test_cli_protocol_and_permission_arguments():
    adapter=CliAdapter('codex','codex.exe')
    args=adapter.arguments('read-only','known-id')
    assert 'known-id' in args and '--last' not in args
    assert 'sandbox_mode="read-only"' in args
    assert not any('bypass' in x for x in args)
    events=[{'type':'thread.started','thread_id':'test-id'},
            {'type':'item.completed','item':{'type':'agent_message','text':'done'}},
            {'type':'turn.completed','usage':{'input_tokens':3}}]
    result=adapter.parse('\n'.join(map(json.dumps,events)))
    assert result.session_id=='test-id' and result.output=='done'
    with pytest.raises(ValueError):
        adapter.parse('{}')
    with pytest.raises(RuntimeError):
        adapter.parse('{"type":"turn.failed","error":"auth failed"}')
    claude=CliAdapter('claude','claude.exe')
    assert 'plan' in claude.arguments('read-only')
    assert 'acceptEdits' in claude.arguments('workspace-write')
    assert claude.parse('{"type":"result","subtype":"success","result":"ok","session_id":"c1"}').session_id=='c1'
    with pytest.raises(RuntimeError):
        claude.parse('{"subtype":"error_max_turns","is_error":true,"result":"failed"}')


def test_process_runner_stdin_timeout_and_cancel(tmp_path):
    async def scenario():
        runner=ProcessRunner()
        code,out,err=await runner.run([sys.executable,'-c','import sys; print(sys.stdin.read())'],str(tmp_path),'hello')
        assert code==0 and out.strip()=='hello'
        with pytest.raises(TimeoutError):
            await runner.run([sys.executable,'-c','import time; time.sleep(30)'],str(tmp_path),timeout=.2)
        task=asyncio.create_task(runner.run([sys.executable,'-c','import time; time.sleep(30)'],str(tmp_path)))
        await asyncio.sleep(.2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(scenario())


def test_permission_sessions_receive_intervening_results(tmp_path, monkeypatch):
    calls=[]
    monkeypatch.setattr('app.core.orchestrator.executable',lambda *args:sys.executable)
    async def fake(self,context,cwd,mode,session=None):
        calls.append((json.loads(context),session))
        return AgentResult(adapter='codex',output=mode+' result',session_id=mode+'-session')
    monkeypatch.setattr(CliAdapter,'execute',fake)
    with TestClient(create_app(tmp_path/'ws')) as c:
        c.post('/api/projects',json={'name':'one'})
        for mode in ('read-only','workspace-write','read-only'):
            r=c.post('/api/projects/one/chat',json={'text':'검토','task':'work','client':'codex','action':'run','mode':mode}).json()
            assert wait_run(c,r['run_id'])['status']=='completed'
        assert calls[-1][1]=='read-only-session'
        assert any(h['result']=='workspace-write result' for h in calls[-1][0]['history'])


def test_task_merge_and_completed_topic_is_not_silently_reopened(tmp_path):
    with TestClient(create_app(tmp_path/'ws')) as c:
        c.post('/api/projects',json={'name':'one'})
        base='/api/projects/one'
        for task in ('로그인','인증 개선'):
            c.post(base+'/messages',json={'text':'내용','task':task})
        assert c.patch(base+'/tasks',json={'task':'로그인','title':'인증 개선','status':'done'}).status_code==200
        tasks=c.get(base+'/tasks').json()['tasks']
        assert len(tasks)==1 and tasks[0]['count']==2 and tasks[0]['status']=='done'
        r=c.post(base+'/route',json={'text':'인증 문제 수정'}).json()
        assert r['kind']=='new'


def test_missing_client_does_not_fallback_to_mock(tmp_path, monkeypatch):
    monkeypatch.setattr('app.llm.cli.discovery_candidates',lambda *args:iter(()))
    with TestClient(create_app(tmp_path/'ws')) as c:
        c.post('/api/projects',json={'name':'one'})
        response=c.post('/api/projects/one/chat',json={'text':'run','task':'one','client':'claude','action':'run'})
        assert response.status_code==404
        assert c.get('/api/projects/one/runs').json()['runs']==[]


def test_shutdown_marks_background_run_interrupted(tmp_path):
    class Slow:
        async def run(self,context):
            await asyncio.sleep(30)
    app=create_app(tmp_path/'ws',Slow())
    with TestClient(app) as c:
        c.post('/api/projects',json={'name':'one'})
        r=c.post('/api/projects/one/chat',json={'text':'run','task':'one','action':'run'}).json()
    assert app.state.harness.storage.run('one',r['run_id'])['status']=='interrupted'
