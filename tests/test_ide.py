"""#15 IDE-1 acceptance: IDE discovery, per-PC paths, per-project choice and detached launch."""
import os
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

BASE = '/api/projects/sample'
WINDOWS = os.name == 'nt'
EXE = {'vscode': 'Code.exe' if WINDOWS else 'code', 'intellij': 'idea64.exe' if WINDOWS else 'idea.sh'}
windows_only = pytest.mark.skipif(not WINDOWS, reason='Windows install locations')


def touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'')
    return path


class FakePopen:
    """Stands in for the IDE process; never starts anything. `behaviour` = (exit after seconds or None, code)."""
    behaviour = (0.1, 0)
    calls = []

    def __init__(self, args, **kwargs):
        FakePopen.calls.append({'args': list(args), 'kwargs': kwargs, 'process': self})
        self.pid, self.started, self.returncode, self.killed = 4242, time.monotonic(), None, False

    def poll(self):
        after, code = FakePopen.behaviour
        if after is not None and time.monotonic() - self.started >= after:
            self.returncode = code
        return self.returncode

    def wait(self, timeout=None):
        after, code = FakePopen.behaviour
        remaining = None if after is None else max(0.0, after - (time.monotonic() - self.started))
        if remaining is None or (timeout is not None and remaining > timeout):
            time.sleep(timeout or 0)
            raise subprocess.TimeoutExpired('ide', timeout)
        time.sleep(remaining)
        self.returncode = code
        return code

    def kill(self):
        self.killed = True

    terminate = kill


@pytest.fixture
def machine(tmp_path, monkeypatch):
    """Empty fake PC: no IDE in PATH or the standard install folders."""
    folders = {name: tmp_path / name for name in ('local', 'programs', 'path')}
    for folder in folders.values():
        folder.mkdir()
    monkeypatch.setenv('LOCALAPPDATA', str(folders['local']))
    for name in ('ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)'):
        monkeypatch.setenv(name, str(folders['programs']))
    monkeypatch.setenv('PATH', str(folders['path']))
    monkeypatch.delenv('HARNESS_DB', raising=False)
    return folders


@pytest.fixture
def client(tmp_path, machine, monkeypatch):
    external = tmp_path / 'external'
    (external / 'app/llm').mkdir(parents=True)
    (external / 'app/llm/cli.py').write_text('print(1)\n', encoding='utf-8')
    (external / '.env').write_text('TOKEN=fixture\n', encoding='utf-8')
    with TestClient(create_app(tmp_path / 'managed')) as test_client:
        for name, folder in (('sample', external), ('other', tmp_path / 'other')):
            folder.mkdir(exist_ok=True)
            registered = test_client.post('/api/workspaces', json={'name': name, 'path': str(folder)})
            assert registered.status_code == 201, registered.text
        test_client.root = external.resolve()
        FakePopen.calls, FakePopen.behaviour = [], (0.1, 0)
        monkeypatch.setattr(subprocess, 'Popen', FakePopen)
        yield test_client


def ide_rows(client):
    response = client.get('/api/ides')
    assert response.status_code == 200, response.text
    return {row['ide']: row for row in response.json()['ides']}


def configure(client, tmp_path, ide, project_ide=None):
    exe = touch(tmp_path / 'installed' / ide / EXE[ide])
    saved = client.put(f'/api/ides/{ide}', json={'path': str(exe)})
    assert saved.status_code == 200, saved.text
    if project_ide:
        chosen = client.put(BASE + '/ide', json={'ide': project_ide})
        assert chosen.status_code == 200, chosen.text
    return str(exe)


def open_file(client, **body):
    return client.post(BASE + '/ide/open', json={'path': 'app/llm/cli.py', 'line': None, 'column': None, **body})


# Discovery and per-PC paths.

def test_nothing_installed_reports_both_ides_missing(client):
    rows = ide_rows(client)
    assert set(rows) == {'vscode', 'intellij'}
    for row in rows.values():
        assert (row['state'], row['path'], row['candidates']) == ('missing', None, [])


@windows_only
def test_vscode_is_detected_in_the_user_install_folder(client, machine):
    exe = touch(machine['local'] / 'Programs' / 'Microsoft VS Code' / 'Code.exe')
    row = ide_rows(client)['vscode']
    assert (row['state'], row['path'], row['candidates']) == ('detected', str(exe), [str(exe)])


@windows_only
def test_vscode_on_path_resolves_code_cmd_to_the_sibling_code_exe(client, machine, monkeypatch):
    install = machine['path'] / 'VS Code'
    touch(install / 'bin' / 'code.cmd')
    exe = touch(install / 'Code.exe')
    monkeypatch.setenv('PATH', str(install / 'bin'))
    row = ide_rows(client)['vscode']
    assert (row['state'], row['path']) == ('detected', str(exe))


@windows_only
def test_several_intellij_installs_are_listed_newest_version_first_and_not_chosen(client, machine):
    def install(version):
        return str(touch(machine['programs'] / 'JetBrains' / f'IntelliJ IDEA {version}' / 'bin' / 'idea64.exe'))
    older, middle, newest = install('2024.3'), install('2025.3.2'), install('2025.10.1')
    row = ide_rows(client)['intellij']
    assert (row['state'], row['path']) == ('multiple', None)
    assert row['candidates'] == [newest, middle, older]


def test_saved_path_must_exist_and_be_the_ide_executable(client, tmp_path):
    wrong_name = touch(tmp_path / 'tools' / ('notepad.exe' if WINDOWS else 'notepad'))
    assert client.put('/api/ides/vscode', json={'path': str(wrong_name)}).status_code == 400
    assert client.put('/api/ides/vscode', json={'path': str(tmp_path / 'gone' / EXE['vscode'])}).status_code == 400
    assert client.put('/api/ides/eclipse', json={'path': str(wrong_name)}).status_code == 400
    exe = configure(client, tmp_path, 'vscode')
    row = ide_rows(client)['vscode']
    assert (row['state'], row['path']) == ('configured', exe)
    assert client.put('/api/ides/vscode', json={'path': ''}).status_code == 200
    assert ide_rows(client)['vscode']['state'] == 'missing'


@windows_only
def test_missing_saved_path_is_replaced_by_the_single_rediscovered_install(client, machine, tmp_path):
    saved = Path(configure(client, tmp_path, 'vscode'))
    saved.unlink()
    rediscovered = touch(machine['local'] / 'Programs' / 'Microsoft VS Code' / 'Code.exe')
    row = ide_rows(client)['vscode']
    assert (row['state'], row['path']) == ('configured', str(rediscovered))
    assert ide_rows(client)['vscode']['path'] == str(rediscovered)


def test_open_fails_when_saved_path_is_gone_and_nothing_is_found(client, tmp_path):
    Path(configure(client, tmp_path, 'vscode', project_ide='vscode')).unlink()
    assert open_file(client, line=1).status_code == 404
    assert FakePopen.calls == []


@windows_only
def test_open_asks_for_a_choice_when_the_saved_path_is_gone_and_several_are_found(client, machine, tmp_path):
    Path(configure(client, tmp_path, 'intellij', project_ide='intellij')).unlink()
    for version in ('2025.2', '2025.3'):
        touch(machine['programs'] / 'JetBrains' / f'IntelliJ IDEA {version}' / 'bin' / 'idea64.exe')
    assert open_file(client, line=1).status_code == 400
    assert FakePopen.calls == []


# Per-project IDE choice.

def test_project_ide_choice_is_per_project_and_survives_execution_settings_save(client):
    assert client.get(BASE + '/ide').json() == {'ide': None}
    assert client.put(BASE + '/ide', json={'ide': 'intellij'}).json() == {'ide': 'intellij'}
    saved = client.put(BASE + '/settings', json={'client': 'mock', 'mode': 'read-only'})
    assert saved.status_code == 200, saved.text
    assert client.get(BASE + '/ide').json() == {'ide': 'intellij'}
    assert client.get('/api/projects/other/ide').json() == {'ide': None}
    assert client.put(BASE + '/ide', json={'ide': 'eclipse'}).status_code in (400, 422)


# Launch.

def test_open_without_a_project_ide_is_refused(client, tmp_path):
    configure(client, tmp_path, 'vscode')
    assert open_file(client, line=1).status_code == 400
    assert FakePopen.calls == []


@pytest.mark.parametrize('line, column, tail', [
    (18, 5, ['--goto', '{file}:18:5']),
    (18, None, ['--goto', '{file}:18']),
    (None, None, ['{file}']),
])
def test_vscode_launch_arguments(client, tmp_path, line, column, tail):
    exe = configure(client, tmp_path, 'vscode', project_ide='vscode')
    response = open_file(client, line=line, column=column)
    assert response.status_code == 200, response.text
    assert response.json() == {'state': 'requested'}
    file = str(client.root / 'app' / 'llm' / 'cli.py')
    assert [call['args'] for call in FakePopen.calls] == [[exe, str(client.root), *[part.format(file=file) for part in tail]]]


@pytest.mark.parametrize('line, column, middle', [
    (18, 5, ['--line', '18', '--column', '4']),
    (18, 1, ['--line', '18', '--column', '0']),
    (18, None, ['--line', '18']),
    (None, None, []),
])
def test_intellij_launch_arguments_use_zero_based_columns(client, tmp_path, line, column, middle):
    exe = configure(client, tmp_path, 'intellij', project_ide='intellij')
    assert open_file(client, line=line, column=column).status_code == 200
    file = str(client.root / 'app' / 'llm' / 'cli.py')
    assert [call['args'] for call in FakePopen.calls] == [[exe, str(client.root), *middle, file]]


def test_launch_is_detached_without_a_shell_and_drops_electron_run_as_node(client, tmp_path, monkeypatch):
    configure(client, tmp_path, 'vscode', project_ide='vscode')
    monkeypatch.setenv('ELECTRON_RUN_AS_NODE', '1')
    monkeypatch.setenv('CODAST_PROBE_KEEP', 'kept')
    assert open_file(client, line=3).status_code == 200
    kwargs = FakePopen.calls[0]['kwargs']
    assert not kwargs.get('shell')
    assert 'ELECTRON_RUN_AS_NODE' not in kwargs['env']
    assert kwargs['env'].get('CODAST_PROBE_KEEP') == 'kept'
    for stream in ('stdin', 'stdout', 'stderr'):
        assert kwargs.get(stream) == subprocess.DEVNULL, stream
    if WINDOWS:
        flags = kwargs.get('creationflags', 0)
        assert flags & subprocess.DETACHED_PROCESS and flags & subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        assert kwargs.get('start_new_session') is True


def test_nonzero_exit_within_the_watch_window_is_a_failure(client, tmp_path):
    configure(client, tmp_path, 'vscode', project_ide='vscode')
    FakePopen.behaviour = (0.3, 3)
    response = open_file(client, line=1)
    assert response.status_code == 400
    assert '3' in response.json()['detail']


def test_a_process_still_running_is_requested_and_left_alone(client, tmp_path):
    configure(client, tmp_path, 'intellij', project_ide='intellij')
    FakePopen.behaviour = (None, 0)
    started = time.monotonic()
    response = open_file(client, line=1)
    assert response.status_code == 200 and response.json() == {'state': 'requested'}
    assert time.monotonic() - started < 8, 'the watch window must stay short (about 5 s)'
    assert FakePopen.calls[0]['process'].killed is False


@pytest.mark.parametrize('path, status', [('.env', 403), ('../outside.py', 403), ('missing.py', 404)])
def test_open_refuses_protected_outside_and_missing_files_before_launching(client, tmp_path, path, status):
    configure(client, tmp_path, 'vscode', project_ide='vscode')
    assert open_file(client, path=path, line=1).status_code == status
    assert FakePopen.calls == []


@pytest.mark.parametrize('body', [{'line': 0}, {'column': 0}, {'line': -1}, {'executable': 'C:/Windows/System32/cmd.exe'}])
def test_open_rejects_invalid_numbers_and_any_executable_from_the_request(client, tmp_path, body):
    configure(client, tmp_path, 'vscode', project_ide='vscode')
    assert open_file(client, **body).status_code in (400, 422)
    assert FakePopen.calls == []


def test_open_from_another_origin_is_refused(client, tmp_path):
    configure(client, tmp_path, 'vscode', project_ide='vscode')
    response = client.post(BASE + '/ide/open', json={'path': 'app/llm/cli.py', 'line': 1, 'column': None},
                           headers={'origin': 'https://elsewhere.test'})
    assert response.status_code == 403
    assert FakePopen.calls == []
