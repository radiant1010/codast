"""Read stored Codex threads without starting or resuming a model turn."""
from pathlib import Path
from uuid import UUID
from app.llm.cli import executable
from app.llm.codex_status import query_readonly, ResponseLimitError
from app.core.transcript import display_message, PREFIX


def request(configured, method, params, max_response_bytes=None):
    try:
        options = {'max_response_bytes': max_response_bytes} if max_response_bytes else {}
        reply = query_readonly(executable('codex', configured), [(method, params)], **options)[0]
    except ResponseLimitError:
        raise
    except Exception as exc:
        raise ValueError('Codex 세션 조회에 실패했습니다. 설치와 로그인 상태를 확인하세요.') from exc
    if 'result' not in reply:
        raise ValueError('Codex에서 저장된 세션을 읽지 못했습니다.')
    return reply['result']


def summary(thread):
    result = {key: thread.get(key) for key in ('id', 'name', 'preview', 'cwd', 'updatedAt')}
    for key in ('name', 'preview'):
        text = result.get(key)
        if isinstance(text, str) and text.startswith(PREFIX.split('\n')[0]):
            message = display_message('user', text)
            result[key] = message['text'] if 'delivery_details' in message else '하네스 요청, 대화 미리보기에서 확인'
    return result


def list_threads(root, configured='', cursor=None, *, archived=False):
    result = request(configured, 'thread/list', {'cwd': str(root), 'limit': 20, 'cursor': cursor,
        'sourceKinds': ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
        'sortKey': 'updated_at', 'useStateDbOnly': True, 'archived': archived})
    return {'threads': [summary(t) for t in result.get('data', [])
                        if t.get('cwd') and Path(t['cwd']).resolve() == Path(root).resolve()],
            'next_cursor': result.get('nextCursor')}


def read_thread(root, identity, configured='', include_turns=True, *, full=False):
    identity = str(UUID(identity))
    params = {'threadId': identity, 'includeTurns': include_turns}
    thread = (request(configured, 'thread/read', params, 128 * 1024 * 1024) if full else request(configured, 'thread/read', params))['thread']
    if not thread.get('cwd') or Path(thread['cwd']).resolve() != Path(root).resolve():
        raise PermissionError('선택한 프로젝트 경로의 세션만 연결할 수 있습니다.')
    result = summary(thread)
    messages = []
    turns = thread.get('turns', [])
    for turn in turns if full else turns[-10:]:
        for item in turn.get('items', []):
            if item.get('type') == 'userMessage':
                text = '\n'.join(c.get('text', '') for c in item.get('content', []) if c.get('type') == 'text')
                messages.append(display_message('user', text, full=full))
            elif item.get('type') == 'agentMessage':
                messages.append(display_message('assistant', item.get('text', ''), full=full))
    result.update(messages=messages if full else messages[-20:], live_state='unknown',
                  preview_scope='저장된 전체 대화' if full else '최근 최대 10턴 / 20메시지, 메시지당 8000자')
    return result
