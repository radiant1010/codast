"""Isolated browser fixture with synthetic native transcripts, no model calls."""
import json
import os
from pathlib import Path
from uuid import uuid4

from app.core import native_threads
from app.main import create_app

root = Path('work/session-search-browser')/uuid4().hex
os.environ['CLAUDE_CONFIG_DIR'] = str(root/'claude')
app = create_app(root/'projects', db_path=root/'runs.sqlite3')
s = app.state.harness
s.projects.create('search-one')
s.projects.create('search-two')
workspace = s.projects.select('search-one')
s.storage.add_message('search-one', '로컬첫기록 보안정책 <img src=x onerror="window.searchUnsafe=true">', '오래된 작업')
for i in range(25):
    s.storage.add_message('search-one', f'후속 대화 {i}', '오래된 작업')
s.storage.add_message('search-two', '다른프로젝트비밀', '다른 작업')
codex_id = str(uuid4())
thread = {'id': codex_id, 'cwd': str(workspace), 'name': '기존 Codex 작업', 'updatedAt': 1,
          'turns': [{'items': [{'type': 'agentMessage', 'text': '코덱스첫기록 보안정책'}]}]+
                   [{'items': [{'type': 'agentMessage', 'text': f'후속 Codex {i}'}]} for i in range(25)]}


def request(configured, method, params, *args):
    if method == 'thread/list':
        return {'data': [] if params.get('archived') else [thread]}
    return {'thread': thread}


native_threads.request = request
claude_id = str(uuid4())
folder = root/'claude'/'projects'/'synthetic'
folder.mkdir(parents=True)
rows = [{'type': 'user', 'cwd': str(workspace), 'sessionId': claude_id, 'message': {'content': '클로드첫기록 보안정책'}}]
rows += [{'type': 'assistant', 'message': {'content': f'후속 Claude {i}'}} for i in range(25)]
(folder/(claude_id+'.jsonl')).write_text('\n'.join(map(json.dumps, rows)), encoding='utf-8')
for service in (app.state.codex_status, app.state.claude_status):
    service.read = lambda *args: {'state': 'unavailable', 'limits': [], 'models': [], 'source': 'synthetic fixture'}
