import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def shell_launcher(tmp_path):
    if sys.platform == 'win32':
        git = shutil.which('git')
        shell = Path(git).parents[1] / 'usr/bin/sh.exe' if git else None
    else:
        shell = shutil.which('sh')
    if not shell or not Path(shell).is_file():
        pytest.skip('A POSIX shell or Git for Windows is required')
    project = tmp_path / 'project with spaces'
    project.mkdir()
    assert (ROOT / 'codast.sh').is_file(), 'POSIX launcher is missing'
    shutil.copy2(ROOT / 'codast.sh', project / 'codast.sh')
    tools = tmp_path / 'tools'
    tools.mkdir()
    # Hide host uv/curl/wget so bootstrap cases exercise the intended branch.
    for name in ('sh', 'dirname', 'mkdir', 'cp'):
        executable = f'/usr/bin/{name}' if sys.platform == 'win32' else shutil.which(name)
        if not executable:
            pytest.skip(f'{name} is required')
        wrapper = tools / name
        wrapper.write_text(f'#!/bin/sh\nexec {shlex.quote(executable)} "$@"\n',
                           encoding='utf-8', newline='\n')
        wrapper.chmod(0o755)
    uv = tools / 'uv'
    uv.write_text(
        '#!/bin/sh\n'
        'printf "%s|%s|%s\\n" "$PWD" "$UV_PROJECT_ENVIRONMENT" "$*" >> "$CODAST_TEST_LOG"\n'
        'if [ "$1" = sync ]; then exit "$CODAST_TEST_SYNC_EXIT"; fi\n'
        'exit "$CODAST_TEST_RUN_EXIT"\n', encoding='ascii', newline='\n')
    uv.chmod(0o755)
    log = tmp_path / 'calls.txt'
    env = os.environ.copy()
    env.update(CODAST_TEST_LOG=log.as_posix(), CODAST_TEST_SYNC_EXIT='0', CODAST_TEST_RUN_EXIT='0')

    def run(*args):
        return subprocess.run([str(shell), '-c',
            'PATH="$PWD/tools"; export PATH; exec sh "$@"',
            'launcher-test', (project / 'codast.sh').as_posix(), *args],
            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20)

    return project, tools, env, log, run


def test_init_prepares_project_environment_without_starting(shell_launcher):
    _, _, _, log, run = shell_launcher
    result = run('init')
    assert result.returncode == 0, result.stderr
    lines = log.read_text().splitlines()
    assert len(lines) == 1
    cwd, environment, command = lines[0].split('|')
    assert cwd.endswith('/project with spaces')
    assert environment == cwd + '/.venv'
    assert command == 'sync --locked --inexact --python 3.12'


def test_existing_environment_keeps_its_python(shell_launcher):
    project, _, _, log, run = shell_launcher
    python = project / '.venv/bin/python'
    python.parent.mkdir(parents=True)
    python.write_text('#!/bin/sh\nexit 0\n', encoding='ascii', newline='\n')
    python.chmod(0o755)
    assert run('init').returncode == 0
    assert '--python' not in log.read_text()


@pytest.mark.parametrize('args,expected', [
    ((), 'python start.py'), (('start',), 'python start.py'), (('test',), 'python -m pytest -q'),
])
def test_run_prepares_packages_before_dispatch(shell_launcher, args, expected):
    _, _, _, log, run = shell_launcher
    result = run(*args)
    assert result.returncode == 0, result.stderr
    lines = log.read_text().splitlines()
    assert len(lines) == 2
    assert lines[0].endswith('|sync --locked --inexact --python 3.12')
    assert lines[1].endswith('|run --no-sync ' + expected)


def test_failed_sync_stops_before_server_and_returns_status(shell_launcher):
    _, _, env, log, run = shell_launcher
    env['CODAST_TEST_SYNC_EXIT'] = '7'
    assert run('start').returncode == 7
    assert len(log.read_text().splitlines()) == 1


def test_server_status_is_returned(shell_launcher):
    _, _, env, _, run = shell_launcher
    env['CODAST_TEST_RUN_EXIT'] = '9'
    assert run('start').returncode == 9


@pytest.mark.parametrize('args,success', [(('help',), True), (('build',), False), (('init', 'extra'), False)])
def test_help_and_invalid_arguments_do_not_install(shell_launcher, args, success):
    _, _, _, log, run = shell_launcher
    assert (run(*args).returncode == 0) is success
    assert not log.exists()


def test_local_uv_is_reused_before_path_uv(shell_launcher):
    project, tools, _, log, run = shell_launcher
    local_uv = project / '.local/uv/uv'
    local_uv.parent.mkdir(parents=True)
    shutil.copy2(tools / 'uv', local_uv)
    (tools / 'uv').write_text('#!/bin/sh\nexit 99\n', encoding='ascii', newline='\n')
    assert run('init').returncode == 0
    assert len(log.read_text().splitlines()) == 1


@pytest.mark.parametrize('downloader', ['curl', 'wget'])
def test_bootstrap_installs_uv_locally_and_then_syncs(shell_launcher, downloader):
    project, tools, env, log, run = shell_launcher
    (tools / 'uv').rename(tools / 'fixture-uv')
    installer = tools / 'installer.sh'
    installer.write_text(
        '#!/bin/sh\nset -eu\n'
        'mkdir -p "$UV_UNMANAGED_INSTALL"\n'
        'cp "$CODAST_TEST_UV" "$UV_UNMANAGED_INSTALL/uv"\n', encoding='ascii', newline='\n')
    env['CODAST_TEST_UV'] = (tools / 'fixture-uv').as_posix()
    env['CODAST_TEST_INSTALLER'] = installer.as_posix()
    download = tools / downloader
    download.write_text(
        '#!/bin/sh\n'
        'while [ "$#" -gt 0 ]; do\n'
        '  case "$1" in --output|-O) cp "$CODAST_TEST_INSTALLER" "$2"; exit 0 ;; esac\n'
        '  shift\n'
        'done\nexit 2\n', encoding='ascii', newline='\n')
    download.chmod(0o755)
    result = run('init')
    assert result.returncode == 0, result.stderr
    assert (project / '.local/uv/uv').is_file()
    assert len(log.read_text().splitlines()) == 1


def test_failed_download_never_executes_partial_installer(shell_launcher):
    project, tools, _, log, run = shell_launcher
    (tools / 'uv').unlink()
    curl = tools / 'curl'
    curl.write_text(
        '#!/bin/sh\n'
        'while [ "$#" -gt 0 ]; do\n'
        '  if [ "$1" = --output ]; then printf "printf ran > installer-ran\\n" > "$2"; exit 22; fi\n'
        '  shift\n'
        'done\nexit 2\n', encoding='ascii', newline='\n')
    curl.chmod(0o755)
    assert run('init').returncode != 0
    assert not (project / 'installer-ran').exists()
    assert not log.exists()


def test_missing_download_tools_reports_required_prerequisite(shell_launcher):
    _, tools, _, log, run = shell_launcher
    (tools / 'uv').unlink()
    result = run('init')
    assert result.returncode != 0
    assert 'curl or wget' in result.stderr
    assert not log.exists()
