import asyncio
import json
import sys

import pytest
from fastapi.testclient import TestClient

from app.llm.cli import CliAdapter
from app.llm.codex_status import normalize
from app.main import create_app
from app.models.schemas import Command, ProjectSettings


@pytest.mark.parametrize('session', [None, 'saved-session'])
def test_codex_effort_applies_to_new_and_resumed_sessions(session):
    adapter = CliAdapter('codex', 'codex.exe')
    adapter.reasoning_effort = 'ultra'
    args = adapter.arguments('read-only', session)
    assert args.index('model_reasoning_effort="ultra"') < args.index('exec')
    assert args[args.index('model_reasoning_effort="ultra"') - 1] == '-c'
    if session:
        assert args[args.index('resume') + 1] == session
    assert not any('model_reasoning_effort' in x for x in CliAdapter('codex', 'codex.exe').arguments('read-only'))


def test_claude_ultracode_does_not_replace_effort(monkeypatch):
    adapter = CliAdapter('claude', 'claude.exe')
    adapter.reasoning_effort = 'medium'
    for enabled in (True, False, None):
        adapter.ultracode = enabled
        args = adapter.arguments('workspace-write', 'saved-session')
        assert args[args.index('--effort') + 1] == 'medium'
        assert json.loads(args[args.index('--settings') + 1]) == {'ultracode': enabled is True}
    monkeypatch.setattr('app.llm.cli.claude_options', lambda _: {'ultracode': False, 'models': []})
    adapter.ultracode = True
    with pytest.raises(ValueError, match='2.1.284'):
        asyncio.run(adapter.execute('hello', '.', 'read-only'))


@pytest.mark.parametrize('session', [None, 'saved-session'])
@pytest.mark.parametrize('enabled', [None, False])
def test_claude_default_and_off_disable_ultracode_on_older_cli(monkeypatch, session, enabled):
    monkeypatch.setattr('app.llm.cli.claude_options', lambda _: {'ultracode': False, 'models': []})
    calls = []
    async def run(self, argv, cwd, prompt='', **kwargs):
        calls.append(argv)
        return 0, '{"type":"result","subtype":"success","result":"done","session_id":"s"}', ''
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    adapter = CliAdapter('claude', 'claude.exe')
    adapter.ultracode = enabled
    asyncio.run(adapter.execute('hello', '.', 'read-only', session))
    assert json.loads(calls[0][calls[0].index('--settings') + 1]) == {'ultracode': False}
    if session:
        assert calls[0][calls[0].index('--resume') + 1] == session


def test_claude_version_gates_models_and_unsupported_effort_never_runs(monkeypatch):
    from app.llm.claude_options import claude_options
    import subprocess
    monkeypatch.setattr('app.llm.claude_options.subprocess.run', lambda *args, **kwargs:
        subprocess.CompletedProcess(args[0], 0, '2.1.273 (Claude Code)', ''))
    choices = claude_options('claude.exe')
    rows = {row['model']: row for row in choices['models']}
    assert rows['claude-opus-5']['available']
    assert not rows['claude-opus-5-5']['available']
    assert not choices['ultracode']
    adapter = CliAdapter('claude', 'unused')
    adapter.model = 'claude-sonnet-4-6'
    adapter.reasoning_effort = 'xhigh'
    with pytest.raises(ValueError, match='추론 강도'):
        asyncio.run(adapter.execute('hello', '.', 'read-only'))


def test_claude_version_timeout_is_an_actionable_error(monkeypatch):
    from app.llm.claude_options import claude_options
    import subprocess
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 8)
    monkeypatch.setattr('app.llm.claude_options.subprocess.run', timeout)
    with pytest.raises(ValueError, match='CLI 연결'):
        claude_options('claude.exe')


@pytest.mark.parametrize('schema', [Command, ProjectSettings])
@pytest.mark.parametrize('values', [
    {'client': 'claude', 'reasoning_effort': 'ultra'},
    {'client': 'codex', 'ultracode': True},
    {'client': 'codex', 'reasoning_effort': 'invented'},
])
def test_provider_options_reject_unsupported_values(schema, values):
    with pytest.raises(ValueError):
        schema(**({'text': 'test'} if schema is Command else {}), **values)


def test_codex_capabilities_preserve_efforts_but_not_extra_metadata():
    result = normalize({'result': {'data': [{'model': 'example', 'defaultReasoningEffort': 'high',
        'supportedReasoningEfforts': [{'reasoningEffort': 'high', 'description': 'Deeper', 'token': 'private'}]}]}}, {})
    row = result['models'][0]
    assert row['defaultReasoningEffort'] == 'high'
    assert row['supportedReasoningEfforts'] == [{'reasoningEffort': 'high', 'description': 'Deeper'}]
    assert 'private' not in json.dumps(result)


@pytest.mark.parametrize('ultracode', [True, False])
def test_chat_effort_reaches_cli_and_survives_settings_reload(tmp_path, monkeypatch, ultracode):
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)
    monkeypatch.setattr('app.llm.cli.claude_options', lambda _: {'ultracode': True, 'models': [
        {'model': 'claude-opus-5', 'available': True, 'supportedReasoningEfforts': [{'reasoningEffort': 'xhigh'}]}]})
    seen = []
    async def run(self, argv, cwd, prompt='', **kwargs):
        seen.append(argv)
        return 0, '{"type":"result","subtype":"success","result":"done","session_id":"s"}', ''
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    root = tmp_path / 'ws'
    settings = {'client': 'claude', 'model': 'claude-opus-5', 'reasoning_effort': 'xhigh', 'ultracode': ultracode}
    with TestClient(create_app(root)) as client:
        client.post('/api/projects', json={'name': 'one'})
        assert client.put('/api/projects/one/settings', json=settings).status_code == 200
        response = client.post('/api/projects/one/chat', json={**settings, 'task': 'A', 'text': 'hello', 'action': 'run', 'auto_route': False})
        assert response.status_code == 200, response.text
        run_id = response.json()['run_id']
        client.get(f'/api/projects/one/runs/{run_id}/events')
        record = client.get(f'/api/projects/one/runs/{run_id}').json()
        assert record['metadata']['requested_reasoning_effort'] == 'xhigh'
        assert record['command']['reasoning_effort'] == 'xhigh'
        assert record['command']['ultracode'] is ultracode
        assert record['metadata']['requested_ultracode'] is ultracode
    assert seen[0][seen[0].index('--effort') + 1] == 'xhigh'
    assert json.loads(seen[0][seen[0].index('--settings') + 1]) == {'ultracode': ultracode}
    with TestClient(create_app(root)) as client:
        saved = client.get('/api/projects/one/settings').json()
        assert all(saved[k] == v for k, v in settings.items())
