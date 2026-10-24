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
        assert c.get('/api/projects').json() == {'projects': [], 'names': {}}
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


@pytest.mark.parametrize('client', ['codex', 'claude'])
def test_executable_picker_select_cancel_and_no_implicit_save(tmp_path, monkeypatch, client):
    app = create_app(tmp_path/'ws')
    calls = []
    def choose(executable=False):
        calls.append(executable)
        return sys.executable
    monkeypatch.setattr('app.core.folder_picker.choose_folder', choose)
    with TestClient(app) as c:
        endpoint = '/api/clients/'+client+'/executable-picker'
        response = c.post(endpoint)
        assert response.status_code == 200 and response.json()['path']
        assert calls == [True]
        assert app.state.harness.storage.client_path(client) == ''
        assert c.put('/api/clients/'+client, json=response.json()).status_code == 200
        saved = app.state.harness.storage.client_path(client)
        monkeypatch.setattr('app.core.folder_picker.choose_folder', lambda executable=False: None)
        assert c.post(endpoint).json() == {'path': None}
        assert app.state.harness.storage.client_path(client) == saved
        assert c.post(endpoint, headers={'origin':'https://elsewhere.test'}).status_code == 403
        assert c.post('/api/clients/unknown/executable-picker').status_code == 400


def test_native_discovery_and_explicit_invalid_path(tmp_path, monkeypatch):
    from app.llm.cli import executable
    native = tmp_path/'codex.exe';native.touch()
    monkeypatch.setattr('app.llm.cli.discovery_candidates', lambda client: iter([tmp_path/'missing.exe', native]))
    assert executable('codex') == str(native.resolve())
    with pytest.raises(FileNotFoundError):
        executable('codex', str(tmp_path/'invalid.exe'))


def test_file_picker_uses_executable_dialog(monkeypatch, tmp_path):
    from app.core.folder_picker import choose_folder
    from types import SimpleNamespace
    import os
    if os.name != 'nt':
        pytest.skip('Windows dialog')
    seen = []
    def run(argv, **kwargs):
        seen.append(argv[-1])
        return SimpleNamespace(returncode=0, stdout=json.dumps({'path':None}))
    monkeypatch.setattr('app.core.folder_picker.subprocess.run', run)
    assert choose_folder(executable=True) is None
    assert 'OpenFileDialog' in seen[0] and '$picker.FileName' in seen[0]
    assert 'FolderBrowserDialog' not in seen[0]


def test_windows_default_install_discovery_without_path(tmp_path, monkeypatch):
    import os
    from pathlib import Path
    from app.llm.cli import executable
    if os.name != 'nt':
        pytest.skip('Windows default install locations')
    home = tmp_path/'home'
    cli = home/'.local'/'bin'/'claude.exe';cli.parent.mkdir(parents=True);cli.touch()
    local = tmp_path/'local'
    codex = local/'OpenAI'/'Codex'/'bin'/'test-version'/'codex.exe';codex.parent.mkdir(parents=True);codex.touch()
    wrapper = tmp_path/'codex.cmd';wrapper.touch()
    monkeypatch.setattr('app.llm.cli.shutil.which', lambda client: str(wrapper) if client == 'codex' else None)
    monkeypatch.setattr(Path, 'home', lambda: home)
    monkeypatch.setenv('LOCALAPPDATA', str(local))
    monkeypatch.setenv('APPDATA', str(tmp_path/'roaming'))
    assert executable('claude') == str(cli.resolve())
    assert executable('codex') == str(codex.resolve())


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows Claude install locations')
@pytest.mark.parametrize('native_version,desktop_version,expected', [
    ('2.1.8', '2.1.10', 'desktop'),
    ('2.1.11', '2.1.10', 'native'),
    ('2.1.8', None, 'older_desktop'),
])
def test_claude_auto_discovery_selects_newest_runnable_install(tmp_path, monkeypatch, native_version, desktop_version, expected):
    from pathlib import Path
    from types import SimpleNamespace
    from app.llm.cli import executable
    home, roaming = tmp_path/'home', tmp_path/'roaming'
    desktop_root = roaming/'Claude'/'claude-code'
    paths = {'native': home/'.local'/'bin'/'claude.exe',
             'desktop': desktop_root/'2.1.10'/'build-new'/'claude.exe',
             'older_desktop': desktop_root/'2.1.9'/'build-old'/'claude.exe'}
    for path in paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    versions = {str(paths['native']): native_version, str(paths['desktop']): desktop_version,
                str(paths['older_desktop']): '2.1.9'}
    calls = []
    def version(argv, **kwargs):
        calls.append(argv)
        assert argv[1:] == ['--version']
        value = versions[argv[0]]
        if value is None:
            raise OSError('Incomplete installation')
        return SimpleNamespace(returncode=0, stdout=value+' (Claude Code)')
    monkeypatch.setattr('app.llm.claude_options.subprocess.run', version)
    monkeypatch.setattr('app.llm.cli.shutil.which', lambda client: str(paths['native']))
    monkeypatch.setattr(Path, 'home', lambda: home)
    monkeypatch.setenv('APPDATA', str(roaming))
    assert executable('claude') == str(paths[expected].resolve())
    assert len([call for call in calls if call[0] == str(paths['native'])]) == 1
    calls.clear()
    assert executable('claude', str(paths['native'])) == str(paths['native'].resolve())
    assert calls == []
    paths['native'].unlink()
    with pytest.raises(FileNotFoundError):
        executable('claude', str(paths['native']))


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows Claude install locations')
def test_claude_desktop_discovery_without_native_cli_ignores_shell_wrapper(tmp_path, monkeypatch):
    from pathlib import Path
    from types import SimpleNamespace
    from app.llm.cli import executable
    desktop = tmp_path/'roaming'/'Claude'/'claude-code'/'2.1.10'/'build'/'claude.exe'
    desktop.parent.mkdir(parents=True)
    desktop.touch()
    wrapper = tmp_path/'claude.cmd';wrapper.touch()
    monkeypatch.setattr(Path, 'home', lambda: tmp_path/'home')
    monkeypatch.setenv('APPDATA', str(tmp_path/'roaming'))
    monkeypatch.setattr('app.llm.cli.shutil.which', lambda client: str(wrapper))
    def version(argv, **kwargs):
        assert argv == [str(desktop), '--version']
        return SimpleNamespace(returncode=0, stdout='2.1.10 (Claude Code)')
    monkeypatch.setattr('app.llm.claude_options.subprocess.run', version)
    assert executable('claude') == str(desktop.resolve())

@pytest.mark.parametrize('executable', [False, True])
def test_picker_foreground_launch_and_failures(monkeypatch, executable):
    from app.core.folder_picker import choose_folder
    from types import SimpleNamespace
    import os
    import subprocess
    if os.name != 'nt': pytest.skip('Windows dialog')
    seen={}
    def run(argv, **kwargs):
        seen.update(argv=argv,**kwargs)
        return SimpleNamespace(returncode=0,stdout='{"path":null}')
    monkeypatch.setattr('app.core.folder_picker.subprocess.run',run)
    assert choose_folder(executable=executable) is None
    assert seen['startupinfo'].wShowWindow==1
    assert seen['startupinfo'].lpDesktop=='winsta0\\default'
    assert '$picker.ShowDialog($owner)' in seen['argv'][-1]
    assert '$owner.TopMost = $true' in seen['argv'][-1]
    def timeout(*args,**kwargs): raise subprocess.TimeoutExpired('picker',60)
    monkeypatch.setattr('app.core.folder_picker.subprocess.run',timeout)
    with pytest.raises(ValueError,match='대기 시간'): choose_folder(executable=executable)
    def unavailable(*args,**kwargs): raise OSError('unavailable')
    monkeypatch.setattr('app.core.folder_picker.subprocess.run',unavailable)
    with pytest.raises(ValueError,match='직접 입력'): choose_folder(executable=executable)
