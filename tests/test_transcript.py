import json
from app.core.transcript import PREFIX, display_message
from app.core.questions import QUESTION_INSTRUCTION


def test_envelope_parsed_before_preview_limit():
    text = PREFIX + json.dumps({'task':'실제 요청', 'rules':[{'content':'x'*12000}], 'files':[], 'history':[]})
    result = display_message('user', text)
    assert result['text'] == '실제 요청'
    assert result['details_truncated'] and len(result['delivery_details']) == 8000


def test_ordinary_json_assistant_and_malformed_text_remain_unchanged():
    for text in ('hello', '{"task":"ordinary json"}', PREFIX+'{', PREFIX+'{"task":"incomplete"}'):
        assert display_message('user', text) == {'role':'user', 'text':text}
    text=PREFIX+json.dumps({'task':'request','rules':[],'files':[],'history':[]})
    assert display_message('assistant', text)['text'] == text


def test_current_prompt_and_truncated_envelope_never_index_injected_context():
    text = PREFIX+QUESTION_INSTRUCTION+json.dumps({'task': '실제 요청', 'rules': ['비공개 내용'], 'files': [], 'history': []})
    assert display_message('user', text, full=True) == {'role': 'user', 'text': '실제 요청'}
    assert display_message('user', text)['text'] == '실제 요청'
    assert display_message('user', text[:-2], full=True)['text'] == ''
