import json
from app.core.transcript import PREFIX, display_message


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
