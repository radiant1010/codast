"""#8 P-1 acceptance: plan events stored in run_events become the chat's current plan (GET /plan)."""
import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import Command

BASE = '/api/projects/one'
S, S2 = 'session-a', 'session-b'


def create(i, subject, active=None, session=S):
    return {'op': 'create', 'session': session, 'id': str(i), 'subject': subject, 'activeForm': active, 'status': 'pending'}


def update(i, session=S, **fields):
    return {'op': 'update', 'session': session, 'id': str(i), **fields}


def snapshot(tasks, session=S):
    return {'op': 'snapshot', 'session': session, 'tasks': [{'id': str(i), 'subject': s, 'status': st} for i, s, st in tasks]}


@pytest.fixture
def chat(tmp_path):
    with TestClient(create_app(tmp_path / 'ws')) as client:
        assert client.post('/api/projects', json={'name': 'one'}).status_code in (200, 201)
        storage = client.app.state.harness.storage

        def run(*plans, adapter='claude', status='completed', task='계획'):
            run_id = storage.start_run('one', Command(text='요청', task=task), adapter)
            for plan in plans:
                storage.append_event(run_id, 'plan', json.dumps(plan, ensure_ascii=False))
            if status != 'running':
                storage.finish_run(run_id, status, output='끝', error='실패' if status != 'completed' else None, adapter=adapter)
            return run_id

        def plan(task='계획'):
            chat_id = storage.resolve_chat('one', task)['id']
            response = client.get(BASE + '/plan', params={'chat_id': chat_id})
            assert response.status_code == 200, response.text
            return response.json()

        yield client, storage, run, plan


def brief(body):
    return [(row['id'], row['status'], row['thisRun']) for row in body['items']]


def test_chat_without_runs_has_no_plan(chat):
    _, _, _, plan = chat
    assert plan('빈 채팅') == {'agent': None, 'run': None, 'items': [], 'earlierCompleted': [], 'endedWithOpenItems': False}


def test_running_run_shows_its_plan_with_active_form(chat):
    _, _, run, plan = chat
    run_id = run(create(1, '원인 찾기'), create(2, '수정 적용', '수정 적용하는 중'), create(3, '검사 실행'),
                 update(1, status='in_progress'), update(1, status='completed'), update(2, status='in_progress'), status='running')
    body = plan()
    assert body['agent'] == 'claude'
    assert body['run'] == {'id': run_id, 'status': 'running'}
    assert brief(body) == [('1', 'completed', True), ('2', 'in_progress', True), ('3', 'pending', True)]
    assert body['items'][1]['subject'] == '수정 적용' and body['items'][1]['activeForm'] == '수정 적용하는 중'
    assert body['earlierCompleted'] == []
    assert body['endedWithOpenItems'] is False


def test_finished_run_with_open_items_is_flagged_and_never_auto_completed(chat):
    _, _, run, plan = chat
    run(create(1, '원인 찾기'), create(2, '수정 적용'), update(1, status='completed'), update(2, status='in_progress'))
    body = plan()
    assert body['run']['status'] == 'completed'
    assert brief(body) == [('1', 'completed', True), ('2', 'in_progress', True)]
    assert body['endedWithOpenItems'] is True


def test_next_request_folds_earlier_completed_and_keeps_open_items(chat):
    _, _, run, plan = chat
    run(create(1, '원인 찾기'), create(2, '수정 적용'), create(3, '검사 실행'), update(1, status='completed'))
    run(update(2, status='completed'), status='running')
    body = plan()
    assert brief(body) == [('2', 'completed', True), ('3', 'pending', False)]
    assert body['earlierCompleted'] == [{'id': '1', 'subject': '원인 찾기'}]


def test_latest_session_wins_after_the_session_changes(chat):
    _, _, run, plan = chat
    run(create(1, '이전 세션 작업'), create(2, '이전 세션 남은 작업'))
    run(create(1, '새 세션 작업', session=S2), status='running')
    body = plan()
    assert [(row['id'], row['subject']) for row in body['items']] == [('1', '새 세션 작업')]
    assert body['earlierCompleted'] == []


def test_deleted_and_unknown_tasks(chat):
    _, _, run, plan = chat
    run(create(1, '남길 작업'), create(2, '지울 작업'), update(2, status='deleted'), update(99, status='completed'), status='running')
    assert brief(plan()) == [('1', 'pending', True)]


def test_snapshot_replaces_the_list_but_keeps_known_active_form(chat):
    _, _, run, plan = chat
    run(create(1, '분석', '분석하는 중'), create(2, '정리'), create(3, '검사'))
    run(snapshot([(1, '분석', 'in_progress'), (4, '새 항목', 'pending')]), status='running')
    body = plan()
    assert brief(body) == [('1', 'in_progress', True), ('4', 'pending', True)]
    assert body['items'][0]['activeForm'] == '분석하는 중'


def test_snapshot_without_changes_does_not_mark_items_as_this_run(chat):
    _, _, run, plan = chat
    run(create(1, '분석'), create(2, '정리'), update(1, status='completed'))
    run(snapshot([(1, '분석', 'completed'), (2, '정리', 'pending')]), status='running')
    body = plan()
    assert brief(body) == [('2', 'pending', False)]
    assert body['earlierCompleted'] == [{'id': '1', 'subject': '분석'}]


def test_numeric_order_of_task_ids(chat):
    _, _, run, plan = chat
    run(*(create(i, f'작업 {i}') for i in (10, 2, 1)), status='running')
    assert [row['id'] for row in plan()['items']] == ['1', '2', '10']


@pytest.mark.parametrize('status', ['failed', 'interrupted'])
def test_failed_or_interrupted_run_keeps_last_reported_state(chat, status):
    _, _, run, plan = chat
    run(create(1, '수정 적용'), update(1, status='in_progress'), status=status)
    body = plan()
    assert body['run']['status'] == status
    assert brief(body) == [('1', 'in_progress', True)]
    assert body['endedWithOpenItems'] is True


@pytest.mark.parametrize('adapter', ['codex', 'mock'])
def test_latest_non_claude_run_reports_its_agent_without_items(chat, adapter):
    _, _, run, plan = chat
    run(create(1, 'Claude 작업'))
    run_id = run(adapter=adapter, status='running')
    body = plan()
    assert body['agent'] == adapter
    assert body['run'] == {'id': run_id, 'status': 'running'}
    assert body['items'] == [] and body['earlierCompleted'] == [] and body['endedWithOpenItems'] is False


def test_plans_of_other_chats_do_not_leak(chat):
    _, _, run, plan = chat
    run(create(1, '다른 채팅 작업'), task='다른 채팅', status='running')
    run(create(1, '이 채팅 작업'), status='running')
    assert [row['subject'] for row in plan()['items']] == ['이 채팅 작업']
    assert [row['subject'] for row in plan('다른 채팅')['items']] == ['다른 채팅 작업']


def fill(storage, run_id, kind, count):
    stamp = datetime.now(timezone.utc).isoformat()
    with storage.connect() as db:
        db.executemany('INSERT INTO run_events(run_id,kind,text,created_at) VALUES (?,?,?,?)', [(run_id, kind, '-', stamp)] * count)


def test_plan_is_recorded_after_the_log_limit(chat):
    _, storage, run, plan = chat
    run_id = run(status='running')
    fill(storage, run_id, 'output', 4100)
    storage.append_event(run_id, 'plan', json.dumps(create(1, '한도 뒤 작업'), ensure_ascii=False))
    assert [row['subject'] for row in plan()['items']] == ['한도 뒤 작업']
    storage.append_event(run_id, 'output', '한도 뒤 로그')
    assert not [row for row in storage.events('one', run_id, 4000, 1000) if row['text'] == '한도 뒤 로그'], 'the log limit still applies'


def test_plan_events_have_their_own_limit_of_1000_per_run(chat):
    _, storage, run, _ = chat
    run_id = run(status='running')
    fill(storage, run_id, 'plan', 1000)
    storage.append_event(run_id, 'plan', json.dumps(create(1, '넘친 작업'), ensure_ascii=False))
    with storage.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM run_events WHERE run_id=? AND kind='plan'", (run_id,)).fetchone()[0] == 1000


def test_invalid_and_unknown_chats(chat):
    client, _, run, plan = chat
    run(create(1, '작업'), status='running')
    assert plan()['items'], 'plan API must work for a known chat before its refusals mean anything'
    assert client.get(BASE + '/plan', params={'chat_id': 'not-a-chat'}).status_code == 422
    assert client.get(BASE + '/plan', params={'chat_id': 'f' * 32}).status_code == 404
    assert client.get('/api/projects/missing/plan', params={'chat_id': 'f' * 32}).status_code == 404
