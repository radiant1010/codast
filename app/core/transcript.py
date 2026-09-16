"""Display known harness envelopes without altering native transcripts."""
import json

PREFIX = '프로젝트 규칙과 선택 자료를 참고하여 현재 요청을 처리하세요. history는 이전 대화 기록입니다.\n'


def display_message(role, text):
    result = {'role': role, 'text': text[:8000]}
    if role != 'user' or not text.startswith(PREFIX):
        return result
    try:
        payload = json.loads(text[len(PREFIX):])
    except ValueError:
        return result
    if not isinstance(payload, dict) or not isinstance(payload.get('task'), str):
        return result
    if not all(isinstance(payload.get(key), list) for key in ('rules', 'files', 'history')):
        return result
    result['text'] = payload['task'][:8000]
    result['delivery_details'] = json.dumps({key: payload[key] for key in ('rules', 'files', 'history')}, ensure_ascii=False, indent=2)[:8000]
    result['details_truncated'] = len(json.dumps({key: payload[key] for key in ('rules', 'files', 'history')}, ensure_ascii=False, indent=2)) > 8000
    return result
