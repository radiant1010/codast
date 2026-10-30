import asyncio
import sqlite3
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import AgentResult, Command


@pytest.fixture
def work(tmp_path):
    app = create_app(tmp_path / 'projects', db_path=tmp_path / 'app.sqlite3')
    with TestClient(app) as client:
        for project in ('one', 'two'):
            assert client.post('/api/projects', json={'name': project}).status_code == 201
        yield client, app


def create(client, title='예외 조건 확인'):
    response = client.post('/api/projects/one/work-items', json={
        'title': title, 'goal': '입력 예외 조건을 조사한다.',
        'done_criteria': '근거와 정상, 오류 사례를 확인한다.',
    })
    assert response.status_code == 201, response.text
    return response.json()


def url(item):
    return '/api/projects/one/work-items/' + item['id']


def start(client, item, **changes):
    body = {'text': '현재 근거를 정리해줘', 'client': 'mock',
            'expected_revision': item['revision'], 'request_id': uuid4().hex}
    body.update(changes)
    response = client.post(url(item) + '/runs', json=body)
    return response, body


def wait(client, item):
    for _ in range(100):
        current = client.get(url(item)).json()
        if current['status'] != 'running':
            return current
        time.sleep(.02)
    raise AssertionError('작업 실행이 끝나지 않았습니다.')


def verify(client, item, verdict='passed', **changes):
    body = {'expected_revision': item['revision'], 'run_id': item['latest_run_id'],
            'verdict': verdict, 'criteria_met': verdict == 'passed',
            'note': '결과와 완료 조건을 확인했습니다.'}
    body.update(changes)
    return client.post(url(item) + '/verifications', json=body)


def test_work_items_survive_restart_and_keep_chat_api(work):
    client, app = work
    legacy = client.post('/api/projects/one/tasks', json={'task': '기존 채팅'}).json()
    item = create(client)
    assert item['status'] == 'ready'
    assert item['phase'] == 'inspect'
    assert item['verifications'] == [] and item['runs'] == []
    settings = app.state.harness
    replacement = create_app(settings.projects.root, db_path=settings.storage.path)
    with TestClient(replacement) as other:
        assert other.get(url(item)).json() == item
        rows = other.get('/api/projects/one/work-items').json()['items']
        assert [row['id'] for row in rows] == [item['id']]
        chats = other.get('/api/projects/one/tasks').json()['tasks']
        assert any(row['id'] == legacy['id'] and row['task'] == '기존 채팅' for row in chats)


def test_project_boundary_and_input_validation(work):
    client, _ = work
    item = create(client)
    assert client.get(url(item).replace('/one/', '/two/')).status_code == 404
    assert client.get('/api/projects/two/work-items').json()['items'] == []
    assert client.post('/api/projects/one/work-items', json={
        'title': ' ', 'goal': 'g', 'done_criteria': 'd'}).status_code == 422
    assert client.post(url(item) + '/runs', json={
        'text': 'run', 'cwd': '../outside', 'expected_revision': item['revision'],
        'request_id': uuid4().hex}).status_code == 403
    assert client.get(url(item)).json()['status'] == 'ready'


def test_duplicate_start_links_one_run_and_completion_requires_verification(work):
    client, _ = work
    item = create(client)
    response, body = start(client, item)
    assert response.status_code == 200, response.text
    current = wait(client, item)
    assert current['status'] == 'review'
    assert current['phase'] == 'verify'
    assert len(current['runs']) == 1
    assert current['runs'][0]['output']
    assert current['runs'][0]['id'] == current['latest_run_id']
    duplicate = client.post(url(item) + '/runs', json=body)
    assert duplicate.json() == response.json()
    assert client.get(url(item)).json()['revision'] == current['revision']
    assert verify(client, current, criteria_met=False).status_code == 422
    approved = verify(client, current)
    assert approved.status_code == 200, approved.text
    done = approved.json()
    assert done['status'] == 'done'
    assert done['verifications'][0]['actor'] == 'local-user'
    assert done['verifications'][0]['evidence_sha256']
    assert verify(client, current).status_code == 409


def test_failed_verification_preserves_evidence_and_rerun_invalidates_old_result(work):
    client, _ = work
    item = create(client)
    assert start(client, item)[0].status_code == 200
    current = wait(client, item)
    old_run = current['latest_run_id']
    rejected = verify(client, current, 'failed', note='빈 입력 사례가 빠졌습니다.').json()
    assert rejected['status'] == 'blocked' and rejected['phase'] == 'hypothesize'
    assert rejected['blocked_reason'] == '빈 입력 사례가 빠졌습니다.'
    assert start(client, rejected, text='빈 입력 사례도 확인해줘')[0].status_code == 200
    latest = wait(client, item)
    assert len(latest['runs']) == 2 and len(latest['verifications']) == 1
    assert latest['status'] == 'review'
    assert verify(client, latest, run_id=old_run).status_code == 409
    assert verify(client, latest).json()['status'] == 'done'


def test_requests_cannot_move_between_work_items_or_bypass_their_context(work):
    client, _ = work
    first, second = create(client), create(client, '다른 목표')
    response, body = start(client, first)
    assert response.status_code == 200
    first = wait(client, first)
    body['expected_revision'] = second['revision']
    assert client.post(url(second) + '/runs', json=body).status_code == 409
    assert verify(client, second, run_id=first['latest_run_id']).status_code == 409
    assert client.post('/api/projects/one/commands', json={
        'text': '다른 실행', 'chat_id': first['chat_id'], 'client': 'mock',
    }).status_code == 409


def test_goal_attaches_to_existing_chat_without_duplicating_or_moving_history(work):
    client, app = work
    chat = client.post('/api/projects/one/tasks', json={'task': '기존 대화'}).json()
    message = app.state.harness.storage.add_message('one', '기존 기록', '기존 대화')
    payload = {'chat_id': chat['id'], 'title': '대화의 목표', 'goal': '원인을 조사', 'done_criteria': '근거 확인'}
    response = client.post('/api/projects/one/work-items', json=payload)
    assert response.status_code == 201, response.text
    assert response.json()['chat_id'] == chat['id']
    assert len(client.get('/api/projects/one/tasks').json()['tasks']) == 1
    assert client.get('/api/projects/one/messages', params={'chat_id': chat['id']}).json()['messages'][0]['id'] == message
    assert client.post('/api/projects/one/work-items', json=payload).status_code == 409
    assert client.post('/api/projects/two/work-items', json=payload).status_code == 404


def test_goal_attachment_rejects_chat_with_unfinished_run(work):
    client, app = work
    chat = client.post('/api/projects/one/tasks', json={'task': '실행 중 대화'}).json()
    app.state.harness.storage.start_run('one', Command(text='작업 중', chat_id=chat['id']), 'mock')
    response = client.post('/api/projects/one/work-items', json={
        'chat_id': chat['id'], 'title': '진행 목표', 'goal': '조사', 'done_criteria': '확인'})
    assert response.status_code == 409, response.text


def test_chat_submission_keeps_goal_context_idempotency_and_hold(work):
    client, app = work
    seen = []

    class Capture:
        async def run(self, context):
            seen.append(context)
            return AgentResult(adapter='mock', output='확인 결과')

    app.state.harness.agent = Capture()
    item = create(client)
    payload = {'chat_id': item['chat_id'], 'text': '대화에서 지시', 'action': 'run',
               'client': 'mock', 'request_id': uuid4().hex}
    response = client.post('/api/projects/one/chat', json=payload)
    assert response.status_code == 200, response.text
    current = wait(client, item)
    assert current['latest_run_id'] == response.json()['run_id']
    assert client.post('/api/projects/one/chat', json=payload).json()['run_id'] == current['latest_run_id']
    assert len(current['runs']) == len(seen) == 1
    assert any(item['goal'] in part.content and item['done_criteria'] in part.content for part in seen[0].files)
    assert client.post(url(item)+'/control', json={
        'expected_revision': current['revision'], 'action': 'pause', 'reason': '자료 대기'}).status_code == 200
    assert client.post('/api/projects/one/chat', json={**payload, 'request_id': uuid4().hex}).status_code == 409


def test_chat_question_reply_preserves_goal_and_original_execution_settings(work):
    client, app = work
    seen = []

    class Ask:
        async def run(self, context):
            seen.append(context)
            output = '```codast-question\n{"question":"어떤 입력인가요?","choices":[]}\n```' if len(seen) == 1 else '답변 확인'
            return AgentResult(adapter='mock', output=output)

    app.state.harness.agent = Ask()
    item = create(client)
    assert start(client, item, mode='workspace-write')[0].status_code == 200
    current = wait(client, item)
    source = current['latest_run_id']
    payload = {'answer': '빈 입력입니다.', 'request_id': uuid4().hex}
    response = client.post('/api/projects/one/runs/'+source+'/reply', json=payload)
    assert response.status_code == 200, response.text
    after = wait(client, item)
    assert after['latest_run_id'] == response.json()['run_id']
    assert after['runs'][0]['command']['mode'] == 'workspace-write'
    assert all(any(item['goal'] in part.content for part in context.files) for context in seen)
    assert client.post('/api/projects/one/runs/'+source+'/reply', json=payload).json()['run_id'] == after['latest_run_id']
    assert client.post('/api/projects/one/runs/'+source+'/reply', json={**payload, 'request_id': uuid4().hex}).status_code == 409


def test_question_from_before_goal_attachment_uses_current_goal_and_stable_chat_id(work):
    client, app = work
    seen = []

    class Ask:
        async def run(self, context):
            seen.append(context)
            return AgentResult(adapter='mock', output='```codast-question\n{"question":"어떤 입력인가요?","choices":[]}\n```' if len(seen) == 1 else '답변 확인')

    app.state.harness.agent = Ask()
    chat = client.post('/api/projects/one/tasks', json={'task': '일반 질문 대화'}).json()
    response = client.post('/api/projects/one/chat', json={
        'chat_id': chat['id'], 'text': '질문해줘', 'client': 'mock', 'action': 'run', 'mode': 'workspace-write'})
    run_id = response.json()['run_id']
    for _ in range(100):
        if client.get('/api/projects/one/runs/'+run_id).json()['status'] != 'running':
            break
        time.sleep(.02)
    item = client.post('/api/projects/one/work-items', json={
        'chat_id': chat['id'], 'title': '이어갈 목표', 'goal': '입력 검증', 'done_criteria': '근거 대조'}).json()
    assert client.patch('/api/projects/one/tasks', json={'chat_id': chat['id'], 'task': chat['task'], 'title': '바뀐 대화 이름'}).status_code == 200
    payload = {'answer': '빈 입력', 'request_id': uuid4().hex}
    reply = client.post('/api/projects/one/runs/'+run_id+'/reply', json=payload)
    assert reply.status_code == 200, reply.text
    current = wait(client, item)
    assert current['runs'][0]['command']['mode'] == 'workspace-write'
    assert current['runs'][0]['command']['task'] == '바뀐 대화 이름'
    assert any(item['goal'] in part.content for part in seen[1].files)
    assert client.post('/api/projects/one/runs/'+run_id+'/reply', json=payload).json()['run_id'] == current['latest_run_id']
    assert len(seen) == 2


def test_work_context_and_question_reply_keep_goal_and_scope(work):
    client, app = work
    seen = []

    class Questions:
        async def run(self, context):
            seen.append(context)
            text = '```codast-question\n{"question":"어떤 예외인가요?","choices":[]}\n```' if len(seen) == 1 else '빈 입력을 확인했습니다.'
            return AgentResult(adapter='mock', output=text)

    app.state.harness.agent = Questions()
    item = create(client)
    assert start(client, item)[0].status_code == 200
    current = wait(client, item)
    assert current['status'] == 'blocked'
    assert verify(client, current).status_code == 409
    assert client.patch('/api/projects/one/messages/' + current['latest_run_id'],
                        json={'task': '다른 채팅'}).status_code == 409
    assert start(client, current, text='빈 입력입니다.')[0].status_code == 200
    assert wait(client, current)['status'] == 'review'
    assert all(any(item['goal'] in part.content and item['done_criteria'] in part.content
                   for part in context.files) for context in seen)


def test_legacy_execution_cannot_be_moved_into_goal_history(work):
    client, app = work
    item = create(client)
    run = client.post('/api/projects/one/commands', json={'text': '기존 채팅 요청', 'task': '기존 채팅'}).json()
    chat = app.state.harness.storage.resolve_chat('one', chat_id=item['chat_id'])
    assert client.patch('/api/projects/one/messages/' + run['run_id'], json={'task': chat['task']}).status_code == 409


def test_cancel_is_not_success(work):
    client, app = work

    class Slow:
        async def run(self, context):
            await asyncio.sleep(30)
            return AgentResult(adapter='mock', output='late')

    app.state.harness.agent = Slow()
    item = create(client)
    response, _ = start(client, item)
    run_id = response.json()['run_id']
    assert client.post('/api/projects/one/runs/' + run_id + '/cancel').status_code == 200
    current = wait(client, item)
    assert current['status'] == 'blocked'
    assert current['blocked_reason']
    assert verify(client, current).status_code == 409


def test_schema_migration_preserves_legacy_data_and_backup(work, tmp_path):
    client, app = work
    service = app.state.harness
    client.post('/api/projects/one/tasks', json={'task': '보존할 채팅'})
    legacy_run = service.storage.start_run('one', Command(text='기존 실행', task='보존할 채팅'), 'mock')
    service.storage.finish_run(legacy_run, 'completed', output='기존 결과')
    backup = tmp_path / 'backup.sqlite3'
    with service.storage.connect() as db, sqlite3.connect(backup) as target:
        db.backup(target)
        target.executescript('''DROP TABLE work_item_verifications;
            DROP INDEX runs_work_item;
            ALTER TABLE runs DROP COLUMN work_item_id;
            DROP TABLE work_items;
            PRAGMA user_version=11;''')
    item = create(client)
    with TestClient(create_app(service.projects.root, db_path=backup)) as restored:
        assert restored.get('/api/projects/one/work-items').json()['items'] == []
        assert any(row['task'] == '보존할 채팅' for row in restored.get('/api/projects/one/tasks').json()['tasks'])
        assert restored.get('/api/projects/one/runs/' + legacy_run).json()['output'] == '기존 결과'
        assert create(restored)['status'] == 'ready'
    assert client.get(url(item)).status_code == 200


def test_failed_run_and_orphan_recovery_preserve_work_state(work):
    client, app = work

    class Broken:
        async def run(self, context):
            raise ValueError('가상 실행 오류')

    app.state.harness.agent = Broken()
    item = create(client)
    assert start(client, item)[0].status_code == 200
    current = wait(client, item)
    assert current['status'] == 'blocked'
    assert current['blocked_reason'] == '가상 실행 오류'
    service = app.state.harness
    command = Command(text='종료 미확인 실행', chat_id=item['chat_id'])
    run_id = service.storage.start_run('one', command, 'mock', exclusive=True,
        work_item_id=item['id'], work_item_revision=current['revision'])
    with TestClient(create_app(service.projects.root, db_path=service.storage.path)) as other:
        orphan = other.get(url(item)).json()
        assert orphan['status'] == 'running' and orphan['recovery_required']
        assert start(other, orphan)[0].status_code == 409
        assert verify(other, orphan).status_code == 409
        assert other.post('/api/projects/one/runs/' + run_id + '/reconcile').status_code == 200
        recovered = other.get(url(item)).json()
        assert recovered['status'] == 'blocked' and not recovered['recovery_required']
        assert start(other, recovered)[0].status_code == 200
        assert wait(other, item)['status'] == 'review'


def control(client, item, action, reason='사용자 보류'):
    return client.post(url(item) + '/control', json={
        'expected_revision': item['revision'], 'action': action, 'reason': reason,
    })


def test_list_summary_matches_latest_result_without_copying_output(work):
    client, _ = work
    item = create(client)
    assert start(client, item)[0].status_code == 200
    current = wait(client, item)
    current = verify(client, current, 'failed', note='추가 근거가 필요합니다.').json()
    listed = client.get('/api/projects/one/work-items').json()['items'][0]
    assert listed['latest_run']['id'] == current['latest_run_id']
    assert listed['latest_run']['has_output'] is True
    assert 'output' not in listed['latest_run']
    assert listed['latest_verification']['verdict'] == 'failed'
    assert listed['active_runs'] == []


def test_pause_resume_and_cancel_preserve_result_and_enforce_revision(work):
    client, app = work
    item = create(client)
    assert start(client, item)[0].status_code == 200
    current = wait(client, item)
    paused_response = control(client, current, 'pause', '승인 보류, 원문 대조 필요')
    assert paused_response.status_code == 200, paused_response.text
    paused = paused_response.json()
    assert paused['status'] == 'paused' and paused['resume_status'] == 'review'
    assert paused['hold_reason'] == '승인 보류, 원문 대조 필요'
    assert paused['hold_since']
    assert paused['runs'] == current['runs']
    assert start(client, paused)[0].status_code == 409
    assert verify(client, paused).status_code == 409
    assert control(client, current, 'resume').status_code == 409
    with TestClient(create_app(app.state.harness.projects.root, db_path=app.state.harness.storage.path)) as other:
        assert other.get(url(item)).json()['status'] == 'paused'
        assert other.get('/api/projects/one/work-items').json()['items'][0]['hold_reason'] == paused['hold_reason']
    resumed = control(client, paused, 'resume').json()
    assert resumed['status'] == 'review' and not resumed['hold']
    cancelled = control(client, resumed, 'cancel', '이번 목표 종료').json()
    assert cancelled['status'] == 'cancelled'
    assert start(client, cancelled)[0].status_code == 409
    assert verify(client, cancelled).status_code == 409
    reopened = control(client, cancelled, 'resume').json()
    assert reopened['status'] == 'review'
    assert verify(client, reopened).json()['status'] == 'done'


def test_control_rejects_live_runs_invalid_actions_and_other_projects(work):
    client, app = work
    item = create(client)
    assert control(client, item, 'pause', ' ').status_code == 422
    assert control(client, item, 'resume').status_code == 409
    response = client.post('/api/projects/two/work-items/' + item['id'] + '/control', json={
        'expected_revision': item['revision'], 'action': 'pause', 'reason': '다른 프로젝트',
    })
    assert response.status_code == 404

    class Slow:
        async def run(self, context):
            await asyncio.sleep(30)
            return AgentResult(adapter='mock', output='late')

    app.state.harness.agent = Slow()
    assert start(client, item)[0].status_code == 200
    running = client.get(url(item)).json()
    assert len(client.get('/api/projects/one/work-items').json()['items'][0]['active_runs']) == 1
    for action in ('pause', 'cancel'):
        assert control(client, running, action).status_code == 409
    client.post('/api/projects/one/runs/' + running['latest_run_id'] + '/cancel')


def test_v12_migration_preserves_existing_goal_and_result(work, tmp_path):
    client, app = work
    item = create(client)
    assert start(client, item)[0].status_code == 200
    current = wait(client, item)
    path = tmp_path / 'v12.sqlite3'
    with app.state.harness.storage.connect() as db, sqlite3.connect(path) as old:
        db.backup(old)
        for column in ('hold', 'hold_reason', 'hold_since'):
            old.execute('ALTER TABLE work_items DROP COLUMN ' + column)
        old.execute('PRAGMA user_version=12')
        old.commit()
    with TestClient(create_app(app.state.harness.projects.root, db_path=path)) as migrated:
        restored = migrated.get(url(item)).json()
        assert restored['status'] == 'review' and restored['hold'] == ''
        assert restored['runs'] == current['runs']
        assert control(migrated, restored, 'pause').status_code == 200
