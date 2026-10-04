"""Parallel requirement work, using real API, vault and DB with only CLI replaced."""
import asyncio
import json
import time
from hashlib import sha256
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import AgentResult


@pytest.fixture
def parallel(tmp_path, monkeypatch):
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *a: 'fake-cli')
    app = create_app(tmp_path / 'projects', db_path=tmp_path / 'db.sqlite3')
    with TestClient(app) as client:
        client.post('/api/projects', json={'name': 'sample'})
        cid = client.put('/api/projects/sample/document-vault', json={'path': str(tmp_path / 'vault' / '.codast-documents'), 'mode': 'create'}).json()['binding']['connection_id']
        vault = app.state.document_vault
        d = vault.create('sample', cid, '가상 요구사항', 'REQ-001: 이름은 필수이며 공백만 입력하면 저장하지 않는다.')
        d = vault.change('sample', cid, d['id'], d['revision'], 'submitted', reason='가상 검토')
        d = vault.change('sample', cid, d['id'], d['revision'], 'approved', number=1, comment='가상 승인')
        source = dict(kind='document', identity=d['id'], version=1, expected_revision=d['revision'], sha256=sha256(d['content'].encode()).hexdigest())
        config = dict(connection_id=cid, request_id=uuid4().hex, title='설계와 테스트', source=source)
        base = '/api/projects/sample/workflows'
        response = client.post(base + '/parallel', json=config)
        assert response.status_code == 201, response.text
        yield client, app, base + '/' + response.json()['id'], cid, response.json(), config


def act(f, state, action, **kw):
    client, _, url, cid, *_ = f
    return client.post(url + '/parallel', json=dict(connection_id=cid, expected_revision=state['revision'], action=action, **kw))


def read(f):
    client, _, url, cid, *_ = f
    return client.get(url, params={'connection_id': cid}).json()


def wait(f):
    for _ in range(200):
        s = read(f)
        if s['status'] != 'running':
            return s
        time.sleep(.01)
    raise AssertionError('parallel work did not finish')


def test_overlap_fixed_inputs_separate_results_and_duplicate_requests(parallel, monkeypatch):
    f = parallel
    client, app, url, cid, s, config = f
    executing = 0
    peak = 0
    async def execute(self, context, cwd, mode, session=None):
        nonlocal executing, peak
        data = json.loads(context)
        assert mode == 'read-only' and session is None and data['history'] == []
        assert data['files'][0]['content'] == 'REQ-001: 이름은 필수이며 공백만 입력하면 저장하지 않는다.'
        executing += 1
        peak = max(peak, executing)
        await asyncio.sleep(.15)
        executing -= 1
        role = '설계' if '역할: 설계 작성' in data['task'] else '테스트'
        return AgentResult(adapter='codex', output=role + ' 결과', session_id=role + '-session')
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', execute)
    assert client.post(url.rsplit('/', 1)[0] + '/parallel', json=config).json()['id'] == s['id']
    started = act(f, s, 'start').json()
    assert act(f, s, 'start').status_code == 409
    assert client.post('/api/projects/sample/chat', json={'text':'일반 요청','action':'run','client':'codex'}).status_code == 409
    assert len({x['attempts'][0]['run_id'] for x in started['steps']}) == 2
    s = wait(f)
    assert peak == 2 and s['status'] == 'review'
    assert [x['attempts'][0]['output'] for x in s['steps']] == ['설계 결과', '테스트 결과']
    assert len({x['attempts'][0]['metadata']['chat_id'] for x in s['steps']}) == 2
    assert len({x['attempts'][0]['metadata']['session_id'] for x in s['steps']}) == 2
    assert s['source']['sha256'] == config['source']['sha256']
    for step in s['steps']:
        rid = step['attempts'][0]['run_id']
        assert client.get('/api/projects/sample/runs/' + rid + '/events').status_code == 200
        assert all(e['run_id'] == rid for e in app.state.harness.storage.events('sample', rid))


@pytest.mark.parametrize('outcome', ['failure', 'cancel', 'question'])
def test_independent_states_and_single_role_retry(parallel, monkeypatch, outcome):
    f = parallel
    client, app, url, cid, s, _ = f
    async def execute(self, context, cwd, mode, session=None):
        task = json.loads(context)['task']
        if '역할: 설계 작성' in task and '사용자 답변 또는 수정 의견:\n답변' not in task:
            if outcome == 'failure':
                await asyncio.sleep(.04)
                raise RuntimeError('가상 설계 실패')
            if outcome == 'cancel':
                await asyncio.sleep(10)
            if outcome == 'question':
                return AgentResult(adapter='codex', output='```codast-question\n{"question":"저장 형식은?","choices":["텍스트"]}\n```')
        await asyncio.sleep(.08)
        return AgentResult(adapter='codex', output='확인 가능한 결과')
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', execute)
    started = act(f, s, 'start').json()
    if outcome == 'cancel':
        rid = started['steps'][0]['attempts'][0]['run_id']
        assert client.post('/api/projects/sample/runs/' + rid + '/cancel').status_code == 200
    s = wait(f)
    assert s['steps'][0]['status'] == {'failure':'failed','cancel':'cancelled','question':'question'}[outcome]
    assert s['steps'][1]['status'] == 'review'
    successful = s['steps'][1]['attempts'][0].copy()
    if outcome == 'question':
        assert act(f, s, 'approve', role=0).status_code == 409
        assert act(f, s, 'retry', role=0).status_code == 400
    assert act(f, s, 'retry', role=0, comment='답변').status_code == 200
    assert act(f, s, 'retry', role=0, comment='중복').status_code == 409
    s = wait(f)
    assert s['steps'][0]['status'] == 'review'
    assert s['steps'][1]['attempts'] == [successful]
    s = act(f, s, 'approve', role=0).json()
    assert s['steps'][1]['status'] == 'review'
    assert act(f, s, 'approve', role=1).json()['status'] == 'done'


def test_stale_input_before_start_and_frozen_retry(parallel, monkeypatch):
    f = parallel
    client, app, _, cid, s, config = f
    vault = app.state.document_vault
    src = config['source']
    d = vault.read('sample', cid, src['identity'])
    vault.change('sample', cid, d['id'], d['revision'], 'saved', title=d['title'], content='변경한 초안')
    assert act(f, s, 'start').status_code == 409
    assert not app.state.harness.storage.runs('sample', 100, 0)


def test_restored_results_and_unowned_runs_are_never_replayed(parallel, monkeypatch):
    f = parallel
    _, app, _, cid, s, _ = f
    async def execute(self, *a, **kw):
        await asyncio.sleep(10)
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', execute)
    started = act(f, s, 'start').json()
    from app.core.orchestrator import Orchestrator
    from app.core.workflows import Workflows
    h = app.state.harness
    restored_h = Orchestrator(h.projects, h.policy, h.files, h.agent, h.storage)
    restored = Workflows(app.state.document_vault, restored_h).read('sample', cid, s['id'])
    assert restored['status'] == 'running'
    assert all(step['cancellable'] is False for step in restored['steps'])
    assert len(h.storage.runs('sample', 100, 0)) == 2
    assert all(step['attempts'][0]['run_id'] == started['steps'][i]['attempts'][0]['run_id'] for i, step in enumerate(restored['steps']))


def test_changed_source_is_not_substituted_on_retry_and_restart(parallel, monkeypatch):
    f = parallel
    client, app, url, cid, s, config = f
    async def execute(self, context, *args):
        data = json.loads(context)
        assert data['files'][0]['content'] == 'REQ-001: 이름은 필수이며 공백만 입력하면 저장하지 않는다.'
        return AgentResult(adapter='codex', output='REQ-001 결과')
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', execute)
    act(f, s, 'start')
    s = wait(f)
    doc = app.state.document_vault.read('sample', cid, config['source']['identity'])
    app.state.document_vault.change('sample', cid, doc['id'], doc['revision'], 'saved', title=doc['title'], content='새 요구사항')
    assert act(f, s, 'retry', role=0, comment='근거 보완').status_code == 200
    s = wait(f)
    assert len(s['steps'][1]['attempts']) == 1
    h = app.state.harness
    reopened = create_app(h.projects.root, db_path=h.storage.path)
    restored = reopened.state.workflows.read('sample', cid, s['id'])
    assert restored['source']['content'].startswith('REQ-001:')
    assert restored['steps'][0]['attempts'][-1]['output'] == 'REQ-001 결과'
    assert restored['steps'][1]['attempts'][0]['output'] == 'REQ-001 결과'


def test_unapproved_wrong_hash_and_conflicting_request_are_rejected(parallel):
    client, app, url, cid, s, config = parallel
    base = url.rsplit('/', 1)[0] + '/parallel'
    bad = dict(config, request_id=uuid4().hex, source=dict(config['source'], sha256='0'*64))
    assert client.post(base, json=bad).status_code == 409
    assert client.post(base, json=dict(config, title='다른 작업')).status_code == 409
    bad['source'] = dict(config['source'], version=2)
    assert client.post(base, json=bad).status_code == 409
    assert not app.state.harness.storage.runs('sample', 100, 0)


def test_normal_chat_blocks_parallel_and_question_reply_cannot_bypass_scope(parallel, monkeypatch):
    f = parallel
    client, app, url, cid, s, _ = f
    async def execute(self, *a, **kw):
        await asyncio.sleep(10)
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', execute)
    normal = client.post('/api/projects/sample/chat', json={'text':'일반 실행','action':'run','client':'codex'}).json()['run_id']
    act(f, s, 'start')
    s = read(f)
    assert [step['status'] for step in s['steps']] == ['failed', 'failed']
    assert len(app.state.harness.storage.runs('sample', 100, 0)) == 1
    client.post('/api/projects/sample/runs/' + normal + '/cancel')
    async def question(self, *a, **kw):
        return AgentResult(adapter='codex', output='```codast-question\n{"question":"형식은?"}\n```')
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', question)
    act(f, s, 'retry', role=0)
    s = wait(f)
    rid = s['steps'][0]['attempts'][-1]['run_id']
    assert client.post('/api/projects/sample/runs/' + rid + '/reply', json={'answer':'텍스트','request_id':uuid4().hex}).status_code == 409


def test_crash_between_launches_preserves_completed_peer_and_requires_explicit_retry(parallel):
    f = parallel
    _, app, _, cid, s, _ = f
    vault = app.state.document_vault
    with vault.opened('sample', cid) as (root, catalog):
        s['fixed_at'] = '2026-10-04T00:00:00+00:00'
        s['steps'][0].update(status='running', attempts=[{'run_id':'0'*64, 'version':1}])
        s['steps'][1].update(status='review', attempts=[{'run_id':'1'*64, 'version':1, 'output':'완료한 테스트 정의', 'status':'review'}])
        app.state.workflows.save(root, catalog, s)
    restored = read(f)
    assert restored['steps'][0]['status'] == 'failed'
    assert restored['steps'][1]['attempts'][0]['output'] == '완료한 테스트 정의'
    assert not app.state.harness.storage.runs('sample', 100, 0)


def test_two_slot_scope_rejects_third_and_wrong_role(parallel):
    from app.models.schemas import Command
    _, app, _, _, s, _ = parallel
    storage = app.state.harness.storage
    for role in (0, 1):
        storage.start_run('sample', Command(text='역할 실행', task=str(role), client='codex', fresh=True), 'codex', exclusive=True,
                          initial_metadata={'parallel_group':s['id'], 'parallel_role':role}, parallel_scope=(s['id'],role))
    with pytest.raises(FileExistsError):
        storage.start_run('sample', Command(text='세 번째', client='codex', fresh=True), 'codex', exclusive=True, parallel_scope=(s['id'],0))
    assert len(storage.runs('sample', 100, 0)) == 2


def test_cross_kind_request_collision_is_conflict(parallel):
    client, _, url, cid, _, config = parallel
    response=client.post(url.rsplit('/',1)[0],json={'connection_id':cid,'request_id':config['request_id'],'title':'순차','steps':[{'title':'분석','client':'codex','instruction':'분석'}]})
    assert response.status_code == 409


def test_manual_retry_with_vault_and_replaced_db(parallel, tmp_path, monkeypatch):
    _, app, _, cid, s, _ = parallel
    vault=app.state.document_vault
    with vault.opened('sample',cid) as (root,catalog):
        s['fixed_at']='2026-10-04T00:00:00+00:00'
        s['steps'][0].update(status='running',chat_id='a'*32,attempts=[{'run_id':'0'*64,'version':1,'status':'running'}])
        app.state.workflows.save(root,catalog,s)
    replacement=create_app(app.state.harness.projects.root,db_path=tmp_path/'replacement.sqlite3')
    async def execute(self,*a,**kw):
        return AgentResult(adapter='codex',output='가상 복구 결과')
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute',execute)
    with TestClient(replacement) as client:
        state=replacement.state.workflows.read('sample',cid,s['id'])
        assert state['steps'][0]['status']=='failed'
        assert not replacement.state.harness.storage.runs('sample',100,0)
        response=client.post('/api/projects/sample/workflows/'+s['id']+'/parallel',json={'connection_id':cid,'expected_revision':state['revision'],'action':'retry','role':0})
        assert response.status_code==200,response.text
        for _ in range(100):
            state=replacement.state.workflows.read('sample',cid,s['id'])
            if state['status']!='running':break
            time.sleep(.01)
        assert state['steps'][0]['status']=='review'
        assert len(state['steps'][1]['attempts'])==0


@pytest.mark.parametrize('preserve_chat', [False, True])
def test_vault_only_question_can_receive_answer_after_db_loss(parallel, tmp_path, monkeypatch, preserve_chat):
    _, app, _, cid, s, _ = parallel
    vault=app.state.document_vault
    with vault.opened('sample',cid) as (root,catalog):
        s['fixed_at']='2026-10-04T00:00:00+00:00'
        s['steps'][0].update(status='question',chat_id='a'*32,attempts=[{'run_id':'0'*64,'version':1,'status':'question','output':'저장 형식은?','metadata':{'question':{'question':'저장 형식은?'}}}])
        app.state.workflows.save(root,catalog,s)
    replacement=create_app(app.state.harness.projects.root,db_path=tmp_path/'question-replacement.sqlite3')
    if preserve_chat:
        chat=replacement.state.harness.storage.resolve_chat('sample',s['id']+' / 0')
        with vault.opened('sample',cid) as (root,catalog):
            s['steps'][0]['chat_id']=chat['id']
            app.state.workflows.save(root,catalog,s)
    async def execute(self,context,*a,**kw):
        data=json.loads(context)
        assert '텍스트' in data['task']
        assert data['files'][1]['content']=='저장 형식은?'
        return AgentResult(adapter='codex',output='답변을 반영한 결과')
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute',execute)
    with TestClient(replacement) as client:
        state=replacement.state.workflows.read('sample',cid,s['id'])
        response=client.post('/api/projects/sample/workflows/'+s['id']+'/parallel',json={'connection_id':cid,'expected_revision':state['revision'],'action':'retry','role':0,'comment':'텍스트'})
        assert response.status_code==200,response.text
        for _ in range(100):
            state=replacement.state.workflows.read('sample',cid,s['id'])
            if state['status']!='running':break
            time.sleep(.01)
        assert state['steps'][0]['status']=='review'


def test_approved_sequential_result_can_be_common_input(parallel, monkeypatch):
    f=parallel
    client, app, url, cid, _, _=f
    async def execute(self,*a,**kw):
        return AgentResult(adapter='codex',output='REQ-002: 승인 결과')
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute',execute)
    wf=app.state.workflows.create('sample',cid,'순차 분석',[{'title':'분석','client':'codex','instruction':'분석'}],[],uuid4().hex)
    base='/api/projects/sample/workflows/'+wf['id']
    client.post(base,json={'connection_id':cid,'expected_revision':wf['revision'],'action':'run','instruction':'분석'})
    for _ in range(100):
        wf=client.get(base,params={'connection_id':cid}).json()
        if wf['status']!='running':break
        time.sleep(.01)
    wf=client.post(base,json={'connection_id':cid,'expected_revision':wf['revision'],'action':'approve'}).json()
    response=client.post('/api/projects/sample/workflows/parallel',json={'connection_id':cid,'request_id':uuid4().hex,'title':'후속 설계','source':{'kind':'workflow','identity':wf['id'],'step':0,'version':1,'expected_revision':wf['revision'],'sha256':sha256('REQ-002: 승인 결과'.encode()).hexdigest()}})
    assert response.status_code==201,response.text
    p=response.json()
    assert p['source']['content']=='REQ-002: 승인 결과'
    assert client.post('/api/projects/sample/workflows/'+p['id']+'/parallel',json={'connection_id':cid,'expected_revision':p['revision'],'action':'start'}).status_code==200
