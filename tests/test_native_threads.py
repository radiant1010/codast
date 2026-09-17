from pathlib import Path
import pytest
from app.core import native_threads
from app.core.storage import Storage
from app.models.schemas import Command
import asyncio
import json
import sys
import time
from fastapi.testclient import TestClient
from app.main import create_app
from app.llm.cli import CliAdapter
from app.models.schemas import AgentResult


def test_thread_preview_scope(monkeypatch,tmp_path):
    identity='00000000-0000-4000-8000-000000000001'
    monkeypatch.setattr(native_threads,'request',lambda *args: {'thread': {'id':identity,'cwd':str(tmp_path),'turns':[{'items':[{'type':'agentMessage','text':'hello'},{'type':'reasoning','text':'hidden'}]}]}})
    result=native_threads.read_thread(tmp_path,identity)
    assert result['messages']==[{'role':'assistant','text':'hello'}]
    assert result['live_state']=='unknown'
    with pytest.raises(PermissionError):native_threads.read_thread(tmp_path/'other',identity)


def test_attach_atomic_and_preserves_existing(tmp_path):
    storage=Storage(tmp_path/'db.sqlite3')
    storage.attach_native_thread('project','imported',str(tmp_path),'native-test')
    assert storage.session('project','imported','codex',str(tmp_path),'read-only')=='native-test'
    assert len(storage.messages('project','imported',20,0))==1
    with pytest.raises(FileExistsError):storage.attach_native_thread('project','imported',str(tmp_path),'other')
    assert storage.session('project','imported','codex',str(tmp_path),'read-only')=='native-test'
    storage.start_run('project',Command(text='test',task='busy'),'mock')
    with pytest.raises(FileExistsError):storage.attach_native_thread('project','another',str(tmp_path),'another')
    assert storage.session('project','another','codex',str(tmp_path),'read-only') is None


@pytest.mark.parametrize('route', ['native-threads/codex', 'codex-threads'])
def test_import_resume_and_restart_preserve_session_and_records(tmp_path, monkeypatch, route):
    identity = '00000000-0000-4000-8000-000000000001'
    calls = []
    app = create_app(tmp_path/'ws')
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)

    def request(configured, method, params):
        thread = {'id': identity, 'cwd': str(app.state.harness.projects.select('one')),
                  'turns': [{'items': [{'type': 'agentMessage', 'text': 'native-only history'}]}]}
        return {'data': [thread]} if method == 'thread/list' else {'thread': thread}

    async def execute(self, context, cwd, mode, session=None):
        calls.append((session, json.loads(context)))
        self.on_event('assistant', 'resumed answer')
        return AgentResult(adapter='codex', output='resumed answer', session_id=session or 'new-session',
                           usage={'input_tokens': 5, 'output_tokens': 2})

    monkeypatch.setattr(native_threads, 'request', request)
    monkeypatch.setattr(CliAdapter, 'execute', execute)
    base = '/api/projects/one'

    def run(c, task):
        response = c.post(base+'/chat', json={'text': 'continue', 'task': task, 'client': 'codex',
                                              'action': 'run', 'auto_route': False})
        assert response.status_code == 200
        for _ in range(100):
            row = c.get(base+'/runs/'+response.json()['run_id']).json()
            if row['status'] != 'running':
                assert row['status'] == 'completed'
                return row
            time.sleep(.01)
        pytest.fail('run did not finish')

    with TestClient(app) as c:
        c.post('/api/projects', json={'name': 'one'})
        c.post('/api/projects', json={'name': 'two'})
        assert c.get(base+'/'+route).json()['threads'][0]['id'] == identity
        assert c.get(base+'/'+route+'/'+identity).json()['messages'][0]['text'] == 'native-only history'
        assert c.get('/api/projects/two/'+route+'/'+identity).status_code == 403
        assert c.post('/api/projects/two/'+route+'/'+identity+'/attach', json={'task': 'imported'}).status_code == 403
        assert c.post(base+'/'+route+'/'+identity+'/attach', json={'task': 'imported'}).status_code == 200
        assert 'native-only history' not in c.get(base+'/messages').text
        assert c.post(base+'/'+route+'/'+identity+'/attach', json={'task': 'imported'}).status_code == 409
        row = run(c, 'imported')
        assert calls[-1][0] == identity
        assert row['metadata']['resumed'] and row['metadata']['session_id'] == identity
        assert row['metadata']['usage']['input_tokens'] == 5
        assert 'resumed answer' in c.get(base+'/runs/'+row['id']+'/events').text
        run(c, 'other-chat')
        assert calls[-1][0] is None
        row = run(c, 'imported')
        assert calls[-1][0] == identity and calls[-1][1]['history'] == []

    with TestClient(create_app(tmp_path/'ws')) as c:
        messages = c.get(base+'/messages?task=imported').json()['messages']
        assert len(messages) == 3
        assert run(c, 'imported')['metadata']['session_id'] == identity


@pytest.mark.parametrize('outcome', ['failed', 'interrupted'])
def test_imported_session_failure_or_cancel_invalidates_resume(tmp_path, monkeypatch, outcome):
    app = create_app(tmp_path/'ws')
    s = app.state.harness
    s.projects.create('one')
    root = s.projects.select('one')
    s.storage.attach_native_thread('one', 'imported', str(root), 'native-test')
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)

    async def execute(self, *args):
        if outcome == 'interrupted':
            raise asyncio.CancelledError()
        raise RuntimeError('native resume failed')

    monkeypatch.setattr(CliAdapter, 'execute', execute)
    command = Command(text='continue', task='imported', client='codex')
    with pytest.raises(asyncio.CancelledError if outcome == 'interrupted' else RuntimeError):
        asyncio.run(s.execute('one', command))
    assert s.storage.session('one', 'imported', 'codex', str(root), 'read-only') is None
    assert s.storage.messages('one', 'imported', 20, 0)[0]['status'] == outcome
