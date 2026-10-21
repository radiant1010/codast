import json
from contextlib import contextmanager
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core import native_threads, claude_threads
from app.core.session_search import SessionSearch
from app.core.storage import Storage
from app.core.transcript import PREFIX
from app.core.questions import QUESTION_INSTRUCTION
from app.models.schemas import Command


@pytest.fixture
def search(tmp_path, monkeypatch):
    monkeypatch.setattr(native_threads, 'list_threads', lambda *a, **k: {'threads': [], 'next_cursor': None})
    monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(tmp_path/'claude'))
    index = SessionSearch(Storage(tmp_path/'harness.sqlite3'))
    yield index
    index.close()


def test_local_body_search_and_message_destination(search, tmp_path):
    first = search.storage.add_message('one', '오래된 인증정책 결정', '작업')
    for i in range(24):
        search.storage.add_message('one', f'이후 메시지 {i}', '작업')
    run = search.storage.start_run('one', Command(text='질문', task='작업'), 'mock')
    search.storage.finish_run(run, 'completed', output='대답의 검색어 zebra')
    search.storage.add_message('two', '인증정책 zebra', '다른 프로젝트')
    search.rebuild('one', tmp_path)
    rows = search.search('one', tmp_path, '인증')['results']
    assert len(rows) == 1 and rows[0]['source'] == 'codast'
    context = search.context('one', tmp_path, rows[0]['key'])
    assert context['destination']['message_id'] == first
    assert context['destination']['offset'] == 20
    assert search.search('one', tmp_path, 'zebra')['results'][0]['role'] == 'assistant'
    assert search.search('one', tmp_path/'elsewhere', '인증')['results'] == []
    with pytest.raises(FileNotFoundError):
        search.context('two', tmp_path, rows[0]['key'])


def test_codex_full_history_is_indexed_without_internal_content(search, tmp_path, monkeypatch):
    identity = str(uuid4())
    calls = []
    payload = {'task': '첫번째의 고유한본문', 'rules': ['비공개룰'], 'files': [], 'history': []}
    turns = [{'items': [{'type': 'userMessage', 'content': [{'type': 'text', 'text': PREFIX+QUESTION_INSTRUCTION+json.dumps(payload, ensure_ascii=False)}]},
                       {'type': 'reasoning', 'text': '비공개추론'},
                       {'type': 'agentMessage', 'text': 'x'*8500+'긴메시지끝'}]}]
    turns += [{'items': [{'type': 'agentMessage', 'text': '이후 대화'}]}]*25
    thread = {'id': identity, 'cwd': str(tmp_path), 'name': '기존 Codex', 'updatedAt': 1, 'turns': turns}
    monkeypatch.setattr(native_threads, 'list_threads', lambda *a, **k: {'threads': [thread], 'next_cursor': None})
    def request(*args):
        calls.append(args)
        return {'thread': thread}
    monkeypatch.setattr(native_threads, 'request', request)
    search.rebuild('one', tmp_path)
    for query in ('고유한본문', '긴메시지끝'):
        hit = search.search('one', tmp_path, query)['results'][0]
        assert hit['source'] == 'codex'
        assert query in search.context('one', tmp_path, hit['key'])['messages'][hit['ordinal']]['text']
    assert search.search('one', tmp_path, '비공개')['results'] == []
    search.rebuild('one', tmp_path)
    assert len(calls) == 1
    assert len(native_threads.read_thread(tmp_path, identity)['messages']) == 10


def test_claude_full_history_and_project_boundary(search, tmp_path):
    folder = claude_threads.transcript_root()/'fixture'
    folder.mkdir(parents=True)
    identity = str(uuid4())
    path = folder/(identity+'.jsonl')
    rows = [{'type': 'user', 'cwd': str(tmp_path), 'sessionId': identity, 'message': {'content': '옛날자료 검색대상'}}]
    rows += [{'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': '답변'}, {'type': 'thinking', 'thinking': '숨긴생각'}]}}]*25
    path.write_text('\n'.join(map(json.dumps, rows)), encoding='utf-8')
    search.rebuild('one', tmp_path)
    assert search.search('one', tmp_path, '옛날자료')['results'][0]['source'] == 'claude'
    assert search.search('one', tmp_path, '숨긴생각')['results'] == []
    search.rebuild('two', tmp_path/'other')
    assert search.search('two', tmp_path/'other', '옛날자료')['results'] == []
    path.unlink()
    search.rebuild('one', tmp_path)
    assert search.search('one', tmp_path, '옛날자료')['results'] == []


def test_updates_deletions_persistence_and_literal_query(search, tmp_path):
    message = search.storage.add_message('one', '도메인정책 "따옴표" 별표* 확인', '원래이름')
    search.rebuild('one', tmp_path)
    old = search.search('one', tmp_path, '정책')['results'][0]
    search.storage.move_message('one', message, '이동한이름')
    search.rebuild('one', tmp_path)
    assert search.search('one', tmp_path, '정책')['results'][0]['title'] == '이동한이름'
    assert search.search('one', tmp_path, '"따옴표" 별표*')['results']
    assert search.search('one', tmp_path, '정책 없는단어')['results'] == []
    reopened = SessionSearch(search.storage)
    try:
        assert reopened.search('one', tmp_path, '도메인정책')['results']
    finally:
        reopened.close()
    with search.storage.connect() as db:
        db.execute('DELETE FROM messages WHERE id=?', (message,))
    search.rebuild('one', tmp_path)
    assert search.search('one', tmp_path, '정책')['results'] == []
    with pytest.raises(FileNotFoundError):
        search.context('one', tmp_path, old['key'])


def test_native_failure_reports_incomplete_index(search, tmp_path, monkeypatch):
    search.storage.add_message('one', '찾을 수 있는 로컬기록', '채팅')
    def unavailable(*args, **kwargs):
        raise ValueError('연결할 수 없습니다')
    monkeypatch.setattr(native_threads, 'list_threads', unavailable)
    search.rebuild('one', tmp_path)
    data = search.search('one', tmp_path, '로컬기록')
    assert data['results']
    assert data['status']['errors'][0]['source'] == 'codex'
    assert not data['status']['indexing']


def test_search_api_validation_and_scope(tmp_path, monkeypatch):
    from app.main import create_app
    monkeypatch.setattr(native_threads, 'list_threads', lambda *a, **k: {'threads': [], 'next_cursor': None})
    monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(tmp_path/'claude'))
    app = create_app(tmp_path/'ws')
    with TestClient(app) as client:
        client.post('/api/projects', json={'name': 'one'})
        client.post('/api/projects', json={'name': 'two'})
        app.state.harness.storage.add_message('one', '검색확인 원문', '작업')
        app.state.session_search.rebuild('one', app.state.harness.projects.select('one'))
        base = '/api/projects/one/session-search'
        hit = client.get(base, params={'q': '검색확인'}).json()['results'][0]
        assert client.get(base+'/'+hit['key']).status_code == 200
        assert client.get('/api/projects/two/session-search/'+hit['key']).status_code == 404
        assert client.get(base, params={'q': 'x'*201}).status_code == 422
        assert client.get(base, params={'q': '검색', 'offset': -1}).status_code == 422
        assert client.post(base+'/refresh', headers={'origin': 'https://foreign.example'}).status_code == 403
        assert client.post(base+'/refresh').status_code == 200


def test_codex_archived_sessions_and_pagination(search, tmp_path, monkeypatch):
    identity = str(uuid4())
    calls = []
    def listing(root, configured='', cursor=None, *, archived=False):
        calls.append((archived, cursor))
        if not archived:
            return {'threads': [], 'next_cursor': None}
        return {'threads': [] if not cursor else [{'id': identity, 'updatedAt': 1}],
                'next_cursor': 'next' if not cursor else None}
    monkeypatch.setattr(native_threads, 'list_threads', listing)
    monkeypatch.setattr(native_threads, 'read_thread', lambda *a, **k: {'messages': [{'role': 'user', 'text': '보관세션 검색'}]})
    search.rebuild('one', tmp_path)
    assert search.search('one', tmp_path, '보관세션')['results']
    assert calls == [(False, None), (True, None), (True, 'next')]


def test_context_page_includes_hit_after_image_only_messages(search, tmp_path, monkeypatch):
    identity = str(uuid4())
    monkeypatch.setattr(native_threads, 'list_threads', lambda *a, **k: {'threads': [{'id': identity, 'updatedAt': 1}], 'next_cursor': None})
    messages = [{'role': 'user', 'text': ''}]*5+[{'role': 'assistant', 'text': f'body-{i:02d}'} for i in range(35)]
    monkeypatch.setattr(native_threads, 'read_thread', lambda *a, **k: {'messages': messages})
    search.rebuild('one', tmp_path)
    hit = search.search('one', tmp_path, 'body-15')['results'][0]
    assert any(m['text'] == 'body-15' for m in search.context('one', tmp_path, hit['key'])['messages'])


def test_large_claude_log_can_be_indexed_without_tool_payload(search, tmp_path):
    folder = claude_threads.transcript_root()/'fixture'
    folder.mkdir(parents=True)
    identity = str(uuid4())
    path = folder/(identity+'.jsonl')
    with path.open('w', encoding='utf-8') as stream:
        stream.write(json.dumps({'type': 'user', 'cwd': str(tmp_path), 'sessionId': identity, 'message': {'content': '장기세션 시작'}})+'\n')
        for i in range(18):
            stream.write(json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'input': 'x'*1_000_000}]}})+'\n')
        stream.write(json.dumps({'type': 'assistant', 'message': {'content': '장기세션 끝'}})+'\n')
    with pytest.raises(ValueError):
        claude_threads.read_file(path, tmp_path)
    search.rebuild('one', tmp_path)
    assert len(search.search('one', tmp_path, '장기세션')['results']) == 2
    assert not search.search('one', tmp_path, 'xxxx')['results']


def test_context_keeps_one_snapshot_during_refresh(search, tmp_path, monkeypatch):
    from app.core.session_search import digest
    session_key = digest(['one', str(tmp_path.resolve()), 'codex', 'fixture'])
    search.replace('one', tmp_path, 'codex', 'fixture', session_key, 'old',
                   {'messages': [{'role': 'user', 'text': 'needle old text'}]})
    hit = search.search('one', tmp_path, 'needle')['results'][0]
    original_connect = search.connect
    with original_connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
    class ReadConnection:
        def __init__(self, db):
            self.db = db
        def execute(self, sql, args=()):
            cursor = self.db.execute(sql, args)
            if sql.startswith('SELECT e.*,s.source,s.identity,s.title FROM'):
                row = cursor.fetchone()
                search.replace('one', tmp_path, 'codex', 'fixture', session_key, 'new',
                               {'messages': [{'role': 'user', 'text': 'different new text'}]})
                class Hit:
                    def fetchone(self):
                        return row
                return Hit()
            return cursor
        def executemany(self, *args):
            return self.db.executemany(*args)
    @contextmanager
    def connect():
        with original_connect() as db:
            yield ReadConnection(db)
    monkeypatch.setattr(search, 'connect', connect)
    context = search.context('one', tmp_path, hit['key'])
    assert context['messages'][0]['text'] == 'needle old text'
