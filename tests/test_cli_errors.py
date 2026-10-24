import asyncio
import json
import sys

import pytest

from app.llm.cli import CliAdapter, ProcessRunner
from app.main import create_app
from app.models.schemas import Command


@pytest.mark.parametrize('client,event', [
    ('codex', {'type': 'turn.failed', 'error': {'code': 'auth_failed', 'message': 'Authentication failed'}}),
    ('claude', {'type': 'result', 'is_error': True, 'result': 'Authentication failed'}),
])
def test_protocol_errors_separate_korean_guidance_from_original(client, event):
    raw = json.dumps(event)
    with pytest.raises(RuntimeError) as failure:
        CliAdapter(client, 'unused').parse(raw)
    assert '인증' in str(failure.value)
    assert '로그인' in str(failure.value)
    assert 'Authentication failed' not in str(failure.value)
    assert failure.value.detail == raw


@pytest.mark.parametrize('code,stdout,stderr,expected', [
    (1, '{"type":"turn.failed","error":{"code":"auth_failed"}}', 'native diagnostic', '인증'),
    (1, '', 'Rate limit exceeded', '한도'),
    (1, '', 'Connection refused', '연결'),
    (1, '', 'unrecognized internal failure', '완료하지 못했습니다'),
    (0, 'null\n[]\n{"type":"turn.completed"}', '', '완료 결과'),
    (0, '{"type":"item.completed","item":null}\n{"type":"turn.completed"}', '', '완료 결과'),
    (0, '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n{"type":"turn.completed","usage":[]}', '', '응답 형식'),
])
def test_failed_execution_persists_original_after_reopening(tmp_path, monkeypatch, code, stdout, stderr, expected):
    async def run(self, *args, **kwargs):
        return code, stdout, stderr

    monkeypatch.setattr(ProcessRunner, 'run', run)
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)
    monkeypatch.setattr('app.core.toolchain.Toolchain.configuration', lambda *args: {})
    service = create_app(tmp_path/'workspace').state.harness
    service.projects.create('one')
    with pytest.raises(RuntimeError):
        asyncio.run(service.execute('one', Command(text='가상 요청', task='가상 작업', client='codex')))
    reopened = create_app(tmp_path/'workspace').state.harness
    message = reopened.storage.messages('one', '가상 작업', 20, 0)[0]
    assert message['status'] == 'failed'
    assert expected in message['error']
    assert '{"type"' not in message['error']
    assert 'validation error' not in message['error']
    info = message['metadata']
    if isinstance(info, str):
        info = json.loads(info)
    assert stdout in info['error_detail']
    assert stderr in info['error_detail']
