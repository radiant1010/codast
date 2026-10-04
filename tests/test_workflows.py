import asyncio
import json
import io
from hashlib import sha256
from zipfile import ZipFile
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import AgentResult


@pytest.fixture
def flow(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *a: 'fake-cli')

    async def execute(self, context, cwd, mode, session=None):
        seen.append(json.loads(context))
        await asyncio.sleep(.03)
        return AgentResult(adapter=self.client, output='결과 v'+str(len(seen))+' <script>unsafe</script>')

    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', execute)
    app = create_app(tmp_path / 'projects', db_path=tmp_path / 'db.sqlite3')
    with TestClient(app) as client:
        client.post('/api/projects', json={'name': 'sample'})
        root = tmp_path / 'artifacts' / '.codast-documents'
        cid = client.put('/api/projects/sample/document-vault', json={'path': str(root), 'mode': 'create'}).json()['binding']['connection_id']
        base = '/api/projects/sample/workflows'
        config = dict(connection_id=cid, request_id=uuid4().hex, title='로그인', materials=[], steps=[
            dict(title='연결', client='codex', instruction='요구사항을 연결하라'),
            dict(title='테스트', client='claude', instruction='테스트를 작성하라')])
        s = client.post(base, json=config).json()
        yield client, app, base+'/'+s['id'], cid, s, seen, config


def change(flow, s, action, **extra):
    client, _, url, cid, *_ = flow
    return client.post(url, json=dict(connection_id=cid, expected_revision=s['revision'], action=action, **extra))


def wait(flow):
    client, _, url, cid, *_ = flow
    for _ in range(100):
        s = client.get(url, params={'connection_id': cid}).json()
        if s['status'] != 'running':
            return s
        time.sleep(.01)
    raise AssertionError('run did not finish')


def test_revision_approval_handoff_and_idempotency(flow):
    client, app, url, cid, s, seen, config = flow
    assert client.get(url+'/export', params={'connection_id': cid}).status_code == 409
    assert change(flow, s, 'approve').status_code == 409
    assert client.post(url.rsplit('/', 1)[0], json=config).json()['id'] == s['id']
    launched = change(flow, s, 'run', instruction='첫 분석', client='codex').json()
    assert launched['status'] == 'running'
    assert change(flow, s, 'run', instruction='중복').status_code == 409
    s = wait(flow)
    assert s['status'] == 'review'
    assert change(flow, s, 'run', instruction='수정').status_code == 400
    change(flow, s, 'run', instruction='결과 수정', comment='공백 사례 추가', client='claude')
    s = wait(flow)
    assert len(s['steps'][0]['attempts']) == 2
    assert seen[-1]['files'][0]['content'].startswith('결과 v1')
    assert seen[-1]['history'] == []
    s = change(flow, s, 'approve', comment='확인').json()
    assert s['steps'][0]['attempts'][-1]['comment'] == '공백 사례 추가'
    assert s['steps'][0]['attempts'][-1]['approval_comment'] == '확인'
    assert s['current'] == 1 and s['status'] == 'ready'
    assert len(seen) == 2  # Approval never launches another AI.
    change(flow, s, 'run', instruction='테스트 도출', client='codex')
    s = wait(flow)
    assert seen[-1]['files'][0]['content'].startswith('결과 v2')
    assert 'v2' in seen[-1]['files'][0]['path']
    s = change(flow, s, 'approve').json()
    assert s['status'] == 'done'
    assert change(flow, s, 'run', instruction='불필요').status_code == 409
    # Reopening the vault does not depend on the runs DB for captured outputs.
    from app.core.workflows import Workflows
    restored = Workflows(app.state.document_vault, app.state.harness).read('sample', cid, s['id'])
    assert restored['steps'][0]['attempts'][0]['output'].startswith('결과 v1')
    response = client.get(url+'/export', params={'connection_id': cid})
    assert response.status_code == 200
    with ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['steps'][0]['version'] == 2
        for entry in manifest['steps']:
            assert sha256(archive.read(entry['file'])).hexdigest() == entry['sha256']
        assert json.loads(archive.read('history.json'))['status'] == 'done'


def test_missing_run_does_not_auto_dispatch(flow):
    _, app, _, cid, s, seen, _ = flow
    vault = app.state.document_vault
    with vault.opened('sample', cid) as (root, catalog):
        s['status'] = 'running'
        s['steps'][0]['attempts'].append({'run_id': '0'*64})
        app.state.workflows.save(root, catalog, s)
    s = wait(flow)
    assert s['status'] == 'failed' and not seen
    assert '자동 재실행하지' in s['steps'][0]['attempts'][0]['error']


def test_context_overflow_and_changed_binding(flow):
    client, app, url, cid, s, seen, _ = flow
    # Fail before model execution; retain the failed attempt for review.
    app.state.harness.context.max_chars = 10
    s = change(flow, s, 'run', instruction='분석').json()
    assert s['status'] == 'failed' and not seen
    assert '한도' in s['steps'][0]['attempts'][0]['error']
    assert client.get(url, params={'connection_id': '0'*32}).status_code == 409


def test_failed_revision_keeps_last_result_and_closed_browser_capture(flow):
    client, app, url, cid, s, seen, _ = flow
    change(flow, s, 'run', instruction='분석')
    # Do not GET the workflow: completion must persist with the modal closed.
    for _ in range(100):
        with app.state.document_vault.opened('sample', cid) as (root, catalog):
            s = app.state.workflows.load(root, catalog, s['id'])
        if s['status'] == 'review':
            break
        time.sleep(.01)
    assert s['status'] == 'review'
    limit = app.state.harness.context.max_chars
    app.state.harness.context.max_chars = 10
    s = change(flow, s, 'run', instruction='수정', comment='경계 사례 추가').json()
    assert s['status'] == 'failed'
    app.state.harness.context.max_chars = limit
    change(flow, s, 'run', instruction='다시 수정', comment='경계 사례 추가')
    s = wait(flow)
    assert seen[-1]['files'][0]['content'].startswith('결과 v1')
    assert 'v1' in seen[-1]['files'][0]['path']
    rows = client.get(url.rsplit('/', 1)[0], params={'connection_id': cid}).json()
    assert rows[0]['status'] == 'review'


def test_question_requires_answer_and_cannot_be_approved(flow, monkeypatch):
    _, _, _, _, s, seen, _ = flow
    async def execute(self, context, cwd, mode, session=None):
        seen.append(json.loads(context))
        output = '```codast-question\n{"question":"형식을 선택하세요", "choices":["표","목록"]}\n```' if len(seen) == 1 else '목록 결과'
        return AgentResult(adapter=self.client, output=output)
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', execute)
    change(flow, s, 'run', instruction='분석')
    s = wait(flow)
    assert s['status'] == 'question'
    assert change(flow, s, 'approve').status_code == 409
    assert change(flow, s, 'run', instruction='분석').status_code == 400
    change(flow, s, 'run', instruction='분석', comment='목록')
    s = wait(flow)
    assert s['status'] == 'review'
    assert '목록' in s['steps'][0]['attempts'][-1]['directive']


def test_explicit_execution_mode_and_readonly_default(flow):
    client, app, url, cid, s, _, _ = flow
    assert change(flow, s, 'run', instruction='구현', mode='danger-full-access').status_code == 422
    s = change(flow, s, 'run', instruction='구현', mode='workspace-write').json()
    a = s['steps'][0]['attempts'][-1]
    assert a['mode'] == 'workspace-write'
    assert app.state.harness.storage.run('sample', a['run_id'])['command']['mode'] == 'workspace-write'
    s = wait(flow)
    s = change(flow, s, 'approve').json()
    # A preceding write-enabled step never grants write permission to the next step.
    s = change(flow, s, 'run', instruction='검토').json()
    a = s['steps'][1]['attempts'][-1]
    assert a['mode'] == 'read-only'
    assert app.state.harness.storage.run('sample', a['run_id'])['command']['mode'] == 'read-only'


@pytest.mark.parametrize('legacy, switched', [(False, False), (True, False), (True, True)])
def test_workflow_question_chat_reply_is_rejected_and_workflow_answer_is_recorded(flow, monkeypatch, legacy, switched):
    client, app, url, cid, s, seen, _ = flow
    question = '```codast-question\n{"question":"형식을 선택하세요", "choices":["표","목록"]}\n```'
    async def execute(self, context, cwd, mode, session=None):
        seen.append(json.loads(context))
        if len(seen) == 1:
            return AgentResult(adapter=self.client, output='진행 설명\n\n'+question, final_output=question)
        return AgentResult(adapter=self.client, output='목록 결과')
    monkeypatch.setattr('app.llm.cli.CliAdapter.execute', execute)
    change(flow, s, 'run', instruction='분석')
    s = wait(flow)
    assert s['status'] == 'question'
    run_id = s['steps'][0]['attempts'][0]['run_id']
    row = app.state.harness.storage.run('sample', run_id)
    assert row['metadata']['workflow_id'] == s['id']
    if legacy:
        metadata = dict(row['metadata']); metadata.pop('workflow_id')
        with app.state.harness.storage.connect() as db:
            db.execute('UPDATE runs SET metadata=? WHERE id=?', (json.dumps(metadata), run_id))
        assert 'workflow_id' not in app.state.harness.storage.run('sample', run_id)['metadata']
    if switched:
        new_cid = client.put('/api/projects/sample/document-vault', json={'path':str(app.state.harness.projects.root.parent/'other'/'.codast-documents'), 'mode':'create', 'expected_connection_id':cid}).json()['binding']['connection_id']
    # Recreate the services as on restart; no in-memory ownership is required.
    from app.core.workflows import Workflows
    app.state.workflows = Workflows(app.state.document_vault, app.state.harness)
    reply = client.post('/api/projects/sample/runs/'+run_id+'/reply', json={'answer':'목록','request_id':'no-orphan'})
    assert reply.status_code == 409 and '워크플로' in reply.json()['detail']
    assert len(seen) == 1 and 'reply_run_id' not in app.state.harness.storage.run('sample', run_id)['metadata']
    if switched:
        original_path = app.state.harness.projects.root.parent/'artifacts'/'.codast-documents'
        cid = client.put('/api/projects/sample/document-vault', json={'path':str(original_path), 'mode':'connect', 'expected_connection_id':new_cid}).json()['binding']['connection_id']
        flow = (client, app, url, cid, *flow[4:])
    assert change(flow, s, 'approve').status_code == 409
    change(flow, s, 'run', instruction='분석', comment='목록')
    answered = wait(flow)
    assert answered['status'] == 'review' and len(seen) == 2
    attempts = answered['steps'][0]['attempts']
    assert len(attempts) == 2 and attempts[0]['metadata']['question']
    assert attempts[1]['comment'] == '목록' and attempts[1]['output'] == '목록 결과'
    assert change(flow, s, 'run', instruction='분석', comment='표').status_code == 409
