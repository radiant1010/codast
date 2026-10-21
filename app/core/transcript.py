"""Display known harness envelopes without altering native transcripts."""
import json
from app.core.questions import QUESTION_INSTRUCTION

PREFIX = '프로젝트 규칙과 선택 자료를 참고하여 현재 요청을 처리하세요. history는 이전 대화 기록입니다.\n'


def display_message(role, text, *, full=False):
    limit = None if full else 8000
    result = {'role': role, 'text': text[:limit]}
    if role != 'user' or not text.startswith(PREFIX):
        return result
    # A partial harness envelope must not put injected context in the search index.
    if full:
        result['text'] = ''
    content = text[len(PREFIX):]
    if content.startswith(QUESTION_INSTRUCTION):
        content = content[len(QUESTION_INSTRUCTION):]
    try:
        payload = json.loads(content)
    except ValueError:
        return result
    if not isinstance(payload, dict) or not isinstance(payload.get('task'), str):
        return result
    if not all(isinstance(payload.get(key), list) for key in ('rules', 'files', 'history')):
        return result
    result['text'] = payload['task'][:limit]
    if full:
        return result
    result['delivery_details'] = json.dumps({key: payload[key] for key in ('rules', 'files', 'history')}, ensure_ascii=False, indent=2)[:8000]
    result['details_truncated'] = len(json.dumps({key: payload[key] for key in ('rules', 'files', 'history')}, ensure_ascii=False, indent=2)) > 8000
    return result
