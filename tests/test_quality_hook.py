"""Exercise the installed hook with a disposable local Git remote."""

import os
from pathlib import Path
import shutil
import subprocess
import sys


def test_real_git_push_obeys_hook_result_and_supplies_committed_tip(tmp_path):
    root = tmp_path / 'source'
    remote = tmp_path / 'remote.git'
    subprocess.run(['git', 'init', '-q', str(root)], check=True)
    subprocess.run(['git', 'init', '--bare', '-q', str(remote)], check=True)
    (root / 'pyproject.toml').write_text(
        '[project]\nname="hook-fixture"\nversion="0.0.0"\nrequires-python=">=3.12"\n', encoding='utf-8')
    (root / '.env.sonar').write_text('SONAR_TOKEN=fixture-only\n', encoding='utf-8')
    (root / '.gitignore').write_text('.env.sonar\n.venv/\n', encoding='utf-8')
    (root / 'quality_check.py').write_text(
        'import os, sys\n'
        'print("HOOK_INPUT=" + sys.stdin.read().strip())\n'
        'sys.exit(int(os.environ["HOOK_TEST_RETURN"]))\n', encoding='utf-8')
    environment = os.environ.copy()
    environment['UV_PROJECT_ENVIRONMENT'] = str(root / '.venv')
    environment['UV_PYTHON'] = sys.executable
    subprocess.run(['uv', 'lock', '--offline'], cwd=root, env=environment, check=True, capture_output=True)
    hooks = root / '.githooks'
    hooks.mkdir()
    hook = hooks / 'pre-push'
    shutil.copyfile(Path(__file__).resolve().parents[1] / '.githooks/pre-push', hook)
    hook.chmod(0o755)
    (root / 'scan_sonar.py').write_text('# fixture scanner\n', encoding='utf-8')
    subprocess.run(['git', 'add', '.'], cwd=root, check=True)
    subprocess.run([
        'git', '-c', 'user.name=Hook test', '-c', 'user.email=hook@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture',
    ], cwd=root, check=True)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()

    subprocess.run(['git', 'config', '--local', 'core.hooksPath', '.githooks'], cwd=root, check=True)
    command = ['git', 'push', str(remote), 'HEAD:refs/heads/main']
    environment['HOOK_TEST_RETURN'] = '13'
    rejected = subprocess.run(command, cwd=root, env=environment, capture_output=True, text=True)
    assert rejected.returncode != 0
    assert f'HEAD {revision} refs/heads/main ' in rejected.stdout
    assert subprocess.run(['git', '--git-dir', str(remote), 'show-ref', '--verify', 'refs/heads/main'], capture_output=True).returncode != 0
    environment['HOOK_TEST_RETURN'] = '0'
    checker = root / 'quality_check.py'
    committed_checker = checker.read_text(encoding='utf-8')
    checker.write_text('print("DIRTY CHECKER RAN")\n', encoding='utf-8')
    dirty = subprocess.run(command, cwd=root, env=environment, capture_output=True, text=True)
    assert dirty.returncode != 0
    assert 'DIRTY CHECKER RAN' not in dirty.stdout
    checker.write_text(committed_checker, encoding='utf-8')
    accepted = subprocess.run(command, cwd=root, env=environment, capture_output=True, text=True)
    assert accepted.returncode == 0, accepted.stderr
    assert subprocess.check_output(['git', '--git-dir', str(remote), 'rev-parse', 'refs/heads/main'], text=True).strip() == revision
