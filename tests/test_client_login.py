import asyncio
import json
import os
import subprocess
import threading
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.core.client_login import ClientLogin, launch_login


class LoginProcess:
    def __init__(self):
        self.done = threading.Event()
        self.returncode = None
        self.stopped = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if not self.done.wait(timeout):
            raise subprocess.TimeoutExpired('fixture-login', timeout)
        return self.returncode

    def terminate(self):
        self.stopped = True
        self.finish(1)

    kill = terminate

    def finish(self, code=0):
        self.returncode = code
        self.done.set()


@pytest.mark.parametrize('client', ['codex', 'claude'])
def test_login_is_single_flight_and_verifies_auth_before_success(monkeypatch, client):
    async def scenario():
        process, launched = LoginProcess(), []
        status = SimpleNamespace(lock=threading.Lock(), cached={'state': 'login_required'}, expires=999)
        manager = ClientLogin({client: status}, launch=lambda argv: (launched.append(argv), process)[1])
        async def probe(name, configured):
            return {'state': 'installed', 'auth': 'ready' if process.poll() == 0 else 'check_required', 'path': 'fixture.exe'}
        monkeypatch.setattr('app.core.client_login.probe', probe)
        monkeypatch.setattr('app.core.client_login.login_instructions', lambda name, path: {
            'argv': [path, 'login'] if name == 'codex' else [path, 'auth', 'login']})
        manager.start(client, '')
        manager.start(client, '')
        for _ in range(100):
            if launched:
                break
            await asyncio.sleep(.001)
        assert len(launched) == 1
        assert manager.view(client)['state'] == 'waiting'
        process.finish()
        await manager.jobs[client]['task']
        assert manager.view(client)['state'] == 'ready'
        assert status.cached is None and status.expires == 0
        manager.start(client, '')
        await manager.jobs[client]['task']
        assert len(launched) == 1
        await manager.close()
    asyncio.run(scenario())


@pytest.mark.parametrize('outcome', ['unverified', 'timeout', 'shutdown', 'launch_failure'])
def test_login_failures_and_shutdown_never_leave_a_process_or_expose_output(monkeypatch, outcome):
    async def scenario():
        process = LoginProcess()
        async def probe(*args):
            return {'state': 'installed', 'auth': 'check_required', 'path': 'fixture.exe'}
        monkeypatch.setattr('app.core.client_login.probe', probe)
        monkeypatch.setattr('app.core.client_login.login_instructions', lambda *args: {'argv': ['fixture.exe', 'login']})
        def launch(argv):
            if outcome == 'launch_failure':
                raise OSError('private-auth-output')
            return process
        manager = ClientLogin({}, launch=launch, timeout=.01 if outcome == 'timeout' else 1)
        manager.start('claude', '')
        await asyncio.sleep(.01)
        if outcome == 'shutdown':
            await manager.close()
        else:
            if outcome == 'unverified':
                process.finish()
            await manager.jobs['claude']['task']
        expected = {'timeout': 'timed_out', 'shutdown': 'cancelled'}.get(outcome, 'failed')
        assert manager.view('claude')['state'] == expected
        assert 'private' not in json.dumps(manager.view('claude'))
        if outcome in ('timeout', 'shutdown'):
            assert process.stopped and process.poll() is not None
        await manager.close()
    asyncio.run(scenario())


@pytest.mark.skipif(os.name != 'nt', reason='Windows native login console')
def test_native_login_uses_an_interactive_console_without_a_shell_or_output_capture(monkeypatch):
    calls = []
    monkeypatch.setattr('app.core.client_login.subprocess.Popen', lambda argv, **kwargs: calls.append((argv, kwargs)))
    launch_login(['C:/fixture/Claude Code/claude.exe', 'auth', 'login'])
    argv, options = calls[0]
    assert argv == ['C:/fixture/Claude Code/claude.exe', 'auth', 'login']
    assert options['creationflags'] & subprocess.CREATE_NEW_CONSOLE
    assert not options.get('shell')
    assert all(key not in options for key in ('stdout', 'stderr', 'stdin'))


@pytest.mark.parametrize('state,auth', [('missing', 'unknown'), ('installed', 'unknown')])
def test_unknown_auth_and_missing_cli_never_open_a_login_window(monkeypatch, state, auth):
    async def scenario():
        async def probe(*args):
            return {'state': state, 'auth': auth}
        monkeypatch.setattr('app.core.client_login.probe', probe)
        manager = ClientLogin({}, launch=lambda argv: pytest.fail('Must not launch'))
        manager.start('codex', '')
        await manager.jobs['codex']['task']
        assert manager.view('codex')['state'] == 'failed'
    asyncio.run(scenario())


def test_login_api_requires_explicit_post_and_rejects_other_origins(tmp_path, monkeypatch):
    async def probe(client, configured):
        return {'client': client, 'state': 'installed', 'auth': 'check_required'}
    monkeypatch.setattr('app.api.routes.probe', probe)
    calls = []
    app = create_app(tmp_path / 'projects')
    app.state.client_login.start = lambda client, path: (calls.append(client), {'state': 'checking'})[1]
    with TestClient(app) as client:
        rows = client.get('/api/clients').json()['clients']
        assert len(rows) == 2 and calls == []
        assert client.post('/api/clients/unknown/login').status_code == 400
        assert client.post('/api/clients/claude/login', headers={'origin': 'https://elsewhere.test'}).status_code == 403
        assert calls == []
        assert client.post('/api/clients/claude/login').status_code == 200
        assert calls == ['claude']
