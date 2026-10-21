import io
import json
import pytest
from app.llm.codex_status import query_readonly, ResponseLimitError


def test_readonly_response_limit_is_explicit_and_configurable(monkeypatch):
    class Process:
        def __init__(self, *args, **kwargs):
            self.stdin = io.BytesIO()
            self.stdout = io.BytesIO((json.dumps({'id': 1, 'result': {}})+'\n'+
                                     json.dumps({'id': 2, 'result': {'body': 'x'*300}})+'\n').encode())
        def poll(self):
            return 0
        def wait(self, **kwargs):
            return 0
    monkeypatch.setattr('app.llm.codex_status.subprocess.Popen', Process)
    with pytest.raises(ResponseLimitError):
        query_readonly('fixture', [('thread/read', {})], max_response_bytes=100)
    assert query_readonly('fixture', [('thread/read', {})], max_response_bytes=1000)[0]['result']['body'] == 'x'*300
