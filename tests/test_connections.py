import asyncio
import json
import sys
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.llm.cli import probe, CliAdapter
from app.models.schemas import Command


@pytest.mark.parametrize('payload,code,expected', [({'loggedIn': False}, 1, 'check_required'),
    ({'loggedIn': True, 'email': 'private'}, 0, 'ready'), ({'loggedIn': True}, 1, 'unknown'),
    ({'unexpected': True}, 0, 'unknown')])
def test_claude_auth_is_not_installation(monkeypatch, payload, code, expected):
    monkeypatch.setattr('app.llm.cli.executable', lambda *a: sys.executable)
    async def run(self, argv, cwd, **kwargs):
        return (0, 'test-version', '') if '--version' in argv else (code, json.dumps(payload), '')
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    result = asyncio.run(probe('claude'))
    assert result['state'] == 'installed' and result['auth'] == expected
    assert 'private' not in json.dumps(result)
    assert result['execution_state'] == 'not_verified'


def test_connection_check_does_not_execute_or_register(tmp_path, monkeypatch):
    async def fake_probe(client, path):
        return {'client': client, 'state': 'installed', 'auth': 'check_required', 'next_action': 'login'}
    monkeypatch.setattr('app.core.connections.probe', fake_probe)
    app = create_app(tmp_path/'ws')
    app.state.codex_status.read = lambda _: {'state': 'unavailable'}
    with TestClient(app) as c:
        result = c.post('/api/connections/check').json()
        assert len(result['attention']) == 2
        assert result['configuration_changed'] is False and result['execution'] == 'not_started'
        assert c.get('/api/projects').json() == {'projects': []}
        assert app.state.harness.active == {}
        assert c.get('/api/clients/unknown/login-instructions').status_code == 400


def test_model_arguments_and_observed_model():
    for client in ('codex', 'claude'):
        adapter = CliAdapter(client, 'fake')
        adapter.model = 'test-model'
        for session in (None, 'fake-session'):
            args = adapter.arguments('read-only', session)
            assert args[args.index('--model')+1] == 'test-model'
    with pytest.raises(ValueError):
        Command(text='hello', model='--unsafe')
    events = [{'type': 'system', 'subtype': 'init', 'model': 'actual-model'},
              {'type': 'result', 'subtype': 'success', 'result': 'ok'}]
    assert CliAdapter('claude', 'fake').parse('\n'.join(map(json.dumps, events))).execution_model == 'actual-model'
