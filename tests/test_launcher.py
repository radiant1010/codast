import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


pytestmark = pytest.mark.skipif(sys.platform != 'win32', reason='Windows launcher')
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def launcher(tmp_path):
    project = tmp_path / 'project with spaces'
    project.mkdir()
    for name in ('codast.cmd', 'codast.ps1'):
        assert (ROOT / name).is_file(), f'{name} launcher is missing'
        shutil.copy2(ROOT / name, project / name)
    tools = tmp_path / 'tools'
    tools.mkdir()
    log = tmp_path / 'calls.txt'
    (tools / 'uv.cmd').write_text(
        '@echo off\n'
        'echo %CD% ^| %*>>"%CODAST_TEST_LOG%"\n'
        'if "%1"=="sync" exit /b %CODAST_TEST_SYNC_EXIT%\n'
        'exit /b %CODAST_TEST_RUN_EXIT%\n', encoding='ascii')
    env = os.environ.copy()
    env.update(PATH=str(tools) + os.pathsep + str(Path(env['SYSTEMROOT']) / 'System32'),
               CODAST_TEST_LOG=str(log), CODAST_TEST_SYNC_EXIT='0', CODAST_TEST_RUN_EXIT='0')
    return project, env, log


def run_launcher(project, env, command):
    return subprocess.run([env['COMSPEC'], '/d', '/c', str(project / 'codast.cmd'), command],
                          cwd=project.parent, env=env, capture_output=True, timeout=20)


def test_init_syncs_locked_packages_in_project_without_starting_server(launcher):
    project, env, log = launcher
    result = run_launcher(project, env, 'init')
    assert result.returncode == 0, result.stderr.decode(errors='replace')
    lines = log.read_text().splitlines()
    assert len(lines) == 2
    assert lines[0].startswith(str(project) + ' | sync ')
    assert '--locked' in lines[0] and '--inexact' in lines[0]
    assert '--python 3.12' in lines[0]
    assert 'run --no-sync python -m app.core.toolchain --uv ' in lines[1]


def test_existing_environment_keeps_its_python_version(launcher):
    project, env, log = launcher
    python = project / '.venv/Scripts/python.exe'
    python.parent.mkdir(parents=True)
    python.touch()
    result = run_launcher(project, env, 'init')
    assert result.returncode == 0
    assert '--python' not in log.read_text()


@pytest.mark.parametrize('command,expected', [('start', 'python start.py'), ('test', 'python -m pytest -q')])
def test_start_and_test_prepare_dependencies_before_running(launcher, command, expected):
    project, env, log = launcher
    result = run_launcher(project, env, command)
    assert result.returncode == 0
    lines = log.read_text().splitlines()
    assert len(lines) == 2 and ' | sync ' in lines[0]
    assert lines[1] == str(project) + ' | run --no-sync ' + expected


def test_failed_install_does_not_start_server_and_preserves_error_code(launcher):
    project, env, log = launcher
    env['CODAST_TEST_SYNC_EXIT'] = '7'
    result = run_launcher(project, env, 'start')
    assert result.returncode == 7
    assert len(log.read_text().splitlines()) == 1


def test_server_failure_is_returned_to_caller(launcher):
    project, env, _ = launcher
    env['CODAST_TEST_RUN_EXIT'] = '9'
    assert run_launcher(project, env, 'start').returncode == 9


def test_toolchain_failure_is_returned_without_setup_complete_message(launcher):
    project, env, _ = launcher
    env['CODAST_TEST_RUN_EXIT'] = '9'
    result = run_launcher(project, env, 'init')
    assert result.returncode == 9
    assert b'Setup complete' not in result.stdout


@pytest.mark.parametrize('command,expected', [('help', 0), ('build', 1)])
def test_help_and_invalid_commands_do_not_install_anything(launcher, command, expected):
    project, env, log = launcher
    result = run_launcher(project, env, command)
    assert (result.returncode == 0) is (expected == 0)
    assert not log.exists()


def test_bootstrap_download_failure_is_clear_and_does_not_sync(launcher):
    project, env, log = launcher
    env['PATH'] = str(Path(env['SYSTEMROOT']) / 'System32')
    env['CODAST_TEST_SCRIPT'] = str(project / 'codast.ps1')
    shell = Path(env['SYSTEMROOT']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    result = subprocess.run([str(shell), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'function Invoke-WebRequest { throw "fixture download failed" }; & $env:CODAST_TEST_SCRIPT init'],
        env=env, cwd=project.parent, capture_output=True, timeout=20)
    assert result.returncode != 0
    assert b'fixture download failed' in result.stdout + result.stderr
    assert not log.exists()


def test_bootstrap_installer_uses_compatible_windows_powershell_modules(launcher):
    project, env, log = launcher
    env['PATH'] = str(Path(env['SYSTEMROOT']) / 'System32')
    env['CODAST_TEST_SCRIPT'] = str(project / 'codast.ps1')
    modules = project / 'incompatible-modules'
    security = modules / 'Microsoft.PowerShell.Security'
    security.mkdir(parents=True)
    (security / 'Microsoft.PowerShell.Security.psm1').write_text(
        'function Get-ExecutionPolicy { throw "incompatible module" }\n'
        'Export-ModuleMember -Function Get-ExecutionPolicy\n', encoding='ascii')
    env['PSMODULEPATH'] = str(modules) + os.pathsep + env.get('PSMODULEPATH', '')
    installer = project / 'fixture-installer.ps1'
    installer.write_text(
        '$ErrorActionPreference = "Stop"\n'
        'Get-ExecutionPolicy | Out-File -Encoding ascii $env:CODAST_TEST_LOG\n'
        'exit 23\n', encoding='ascii')
    env['CODAST_TEST_INSTALLER'] = str(installer)
    shell = Path(env['SYSTEMROOT']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    result = subprocess.run([str(shell), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'function Invoke-WebRequest { param($OutFile) '
        'Copy-Item -LiteralPath $env:CODAST_TEST_INSTALLER -Destination $OutFile }; '
        '& $env:CODAST_TEST_SCRIPT init'],
        env=env, cwd=project.parent, capture_output=True, timeout=20)
    assert result.returncode == 1
    assert log.read_text().strip() == 'Bypass'
    assert b'uv installation failed' in result.stdout + result.stderr
