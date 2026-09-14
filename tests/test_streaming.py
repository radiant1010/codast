import asyncio
import json
import sys
import threading

import pytest
from fastapi.testclient import TestClient

from app.core.commands import parse_command
from app.core.storage import Storage
from app.llm.cli import CliAdapter, ProcessRunner
from app.main import create_app
from app.models.schemas import AgentResult, Command


def test_reserved_commands_are_explicit():
    assert parse_command(' /claude\n설계 검토 ') == ('claude', '설계 검토')
    assert parse_command('일반 메모') == (None, '일반 메모')
    for text in ('/codex', '/shell rm', '/codexx 요청'):
        with pytest.raises(ValueError):
            parse_command(text)


def test_live_events_and_replay_with_agent_override(tmp_path, monkeypatch):
    emitted, release = threading.Event(), threading.Event()
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)
    calls = []
    async def execute(self, context, cwd, mode, session=None):
        calls.append((self.client, json.loads(context)))
        self.on_event('tool', '실제 테스트 도구 이벤트')
        emitted.set()
        await asyncio.to_thread(release.wait, 5)
        return AgentResult(adapter=self.client, output='검토 완료')
    monkeypatch.setattr(CliAdapter, 'execute', execute)
    app = create_app(tmp_path/'ws')
    with TestClient(app) as c:
        for name in ('one', 'two'):
            c.post('/api/projects', json={'name':name})
        base = '/api/projects/one'
        c.put(base+'/file', json={'path':'input.md', 'content':'요구사항'})
        response = c.post(base+'/chat', json={'text':'/claude 설계 검토', 'client':'codex',
            'task':'설계', 'context_paths':['input.md'], 'action':'note'})
        run_id = response.json()['run_id']
        try:
            assert emitted.wait(3)
            assert app.state.harness.storage.run('one',run_id)['status']=='running'
            events = app.state.harness.storage.events('one',run_id)
            assert events[-1]['kind']=='tool'
            assert calls[0][0]=='claude'
            assert calls[0][1]['task']=='설계 검토'
            assert calls[0][1]['files'][0]['content']=='요구사항'
            assert c.get(base+'/messages').json()['messages'][0]['text']=='/claude 설계 검토'
            assert c.get('/api/projects/two/runs/'+run_id+'/events').status_code==404
        finally:
            release.set()
        # Streaming response drains the live run through its terminal event.
        response = c.get(base+'/runs/'+run_id+'/events')
        rows = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ') and '"seq"' in line]
        assert rows[-1]['text']=='completed'
        assert [r['seq'] for r in rows] == sorted(set(r['seq'] for r in rows))
        replay = c.get(base+'/runs/'+run_id+'/events', headers={'Last-Event-ID':str(rows[-2]['seq'])})
        assert replay.text.count('event: run_event')==1
        assert 'event: end' in replay.text
        assert c.get(base+'/runs/'+run_id+'/events',headers={'Last-Event-ID':'bad'}).status_code==400
        before = len(c.get(base+'/runs').json()['runs'])
        assert c.post(base+'/chat',json={'text':'/unknown 요청'}).status_code==400
        assert len(c.get(base+'/runs').json()['runs'])==before


def test_process_line_arrives_before_process_exit(tmp_path):
    marker = tmp_path/'ack'
    script = "import sys,time,pathlib; sys.stdout.buffer.write('한글\\n'.encode()); sys.stdout.flush(); p=pathlib.Path(sys.argv[1]); deadline=time.time()+3\nwhile not p.exists() and time.time()<deadline: time.sleep(.01)\nsys.exit(0 if p.exists() else 7)"
    seen=[]
    def line(channel, text):
        seen.append((channel,text))
        marker.write_text('received')
    result=asyncio.run(ProcessRunner().run([sys.executable,'-c',script,str(marker)],str(tmp_path),on_line=line))
    assert result[0]==0
    assert seen==[('stdout','한글')]


def test_protocol_events_exclude_reasoning_and_deduplicate_snapshots():
    adapter=CliAdapter('codex','unused'); output=[]
    adapter.on_event=lambda kind,text:output.append((kind,text))
    for kind,text in [('item.updated','안'),('item.completed','안녕')]:
        adapter.stream_line('stdout',json.dumps({'type':kind,'item':{'id':'a','type':'agent_message','text':text}}))
    adapter.stream_line('stdout',json.dumps({'type':'item.completed','item':{'type':'reasoning','text':'private'}}))
    assert output==[('assistant','안'),('assistant','녕')]
    claude=CliAdapter('claude','unused');claude.on_event=adapter.on_event
    claude.stream_line('stdout',json.dumps({'type':'stream_event','event':{'delta':{'type':'text_delta','text':'hello'}}}))
    final={'type':'result','subtype':'success','result':'hello','session_id':'c'}
    assert claude.parse(json.dumps({'type':'system','subtype':'init'})+'\n'+json.dumps(final)).output=='hello'
    assert output[-1]==('assistant','hello')
    assert 'stream-json' in claude.arguments('read-only')


def test_v3_upgrade_preserves_runs_and_event_limit(tmp_path):
    storage=Storage(tmp_path/'db.sqlite3')
    run_id=storage.start_run('one',Command(text='old'),'mock')
    with storage.connect() as db:
        db.execute('DROP TABLE run_events')
        db.execute('PRAGMA user_version=3')
    upgraded=Storage(storage.path)
    assert upgraded.run('one',run_id)['command']['text']=='old'
    with upgraded.connect() as db:
        db.executemany('INSERT INTO run_events(run_id,kind,text,created_at) VALUES (?,?,?,?)',[(run_id,'output','x','now')]*4096)
    upgraded.append_event(run_id,'output','over limit')
    upgraded.append_event(run_id,'output','discard')
    upgraded.finish_run(run_id,'interrupted',error='cancelled')
    with upgraded.connect() as db:
        rows=db.execute('SELECT kind,text FROM run_events ORDER BY seq DESC LIMIT 3').fetchall()
    assert tuple(rows[0])==('status','interrupted')
    assert rows[1]['kind']=='warning'
    assert tuple(rows[2])==('output','x')
