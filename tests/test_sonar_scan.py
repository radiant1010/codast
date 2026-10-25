import subprocess
from pathlib import Path

import pytest

from scan_sonar import scan


@pytest.fixture
def repository(tmp_path):
    root = tmp_path / 'repository'
    root.mkdir()
    subprocess.run(['git', 'init', '-q', str(root)], check=True)
    (root / '.gitignore').write_text('.env*\nwork/\n.scannerwork/\n', encoding='utf-8')
    (root / 'app.py').write_text('original = True\n', encoding='utf-8')
    (root / 'removed.py').write_text('old = True\n', encoding='utf-8')
    subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
    subprocess.run([
        'git', '-C', str(root), '-c', 'user.name=Scanner test',
        '-c', 'user.email=scanner@example.invalid', '-c', 'commit.gpgsign=false',
        'commit', '-qm', 'Fixture',
    ], check=True)
    return root


def test_snapshot_preserves_working_changes_and_git_but_excludes_private_data(repository, monkeypatch):
    root = repository
    (root / 'app.py').write_text('modified = True\n', encoding='utf-8')
    (root / 'new.py').write_text('pending = True\n', encoding='utf-8')
    (root / 'removed.py').unlink()
    (root / '.env.sonar').write_text('SONAR_TOKEN=local-only\n', encoding='utf-8')
    (root / 'work').mkdir()
    (root / 'work' / 'private.txt').write_text('private fixture', encoding='utf-8')
    monkeypatch.setenv('SONAR_TOKEN', 'test-only-token')
    original_run = subprocess.run
    snapshots = []

    def run(command, **kwargs):
        if command[0] != 'pysonar':
            return original_run(command, **kwargs)
        snapshot = Path(kwargs['cwd'])
        snapshots.append(snapshot)
        assert (snapshot / 'app.py').read_text() == 'modified = True\n'
        assert (snapshot / 'new.py').read_text() == 'pending = True\n'
        assert not (snapshot / 'removed.py').exists()
        assert not (snapshot / '.env.sonar').exists()
        assert not (snapshot / 'work').exists()
        assert (snapshot / '.git').is_dir()
        assert f'--sonar-working-directory={root / ".scannerwork"}' in command
        assert command[-1] == '--dry-run'
        return subprocess.CompletedProcess(command, 7)

    monkeypatch.setattr(subprocess, 'run', run)
    assert scan(root, ['--dry-run']) == 7
    assert snapshots and not snapshots[0].exists()
    assert (root / '.env.sonar').exists()
    assert (root / 'work' / 'private.txt').exists()


def test_refuses_files_that_were_force_added_despite_ignore(repository):
    (repository / '.env.sonar').write_text('SONAR_TOKEN=test-only\n', encoding='utf-8')
    subprocess.run(['git', '-C', str(repository), 'add', '-f', '.env.sonar'], check=True)
    with pytest.raises(RuntimeError, match='ignored files'):
        scan(repository)


def test_refuses_paths_resolved_through_links(repository, monkeypatch):
    original_resolve = Path.resolve

    def resolve(path, *args, **kwargs):
        if path == repository / 'app.py':
            return repository.parent / 'private.py'
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'resolve', resolve)
    with pytest.raises(RuntimeError, match='Linked paths'):
        scan(repository)


def test_revision_snapshot_uses_commit_not_dirty_working_files(repository):
    import scan_sonar

    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repository, text=True).strip()
    (repository / 'app.py').write_text('dirty = True\n', encoding='utf-8')
    (repository / 'uncommitted.py').write_text('not_pushed = True\n', encoding='utf-8')
    with scan_sonar.source_snapshot(repository, revision) as snapshot:
        assert (snapshot / 'app.py').read_text() == 'original = True\n'
        assert not (snapshot / 'uncommitted.py').exists()
        assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=snapshot, text=True).strip() == revision
    assert (repository / 'app.py').read_text() == 'dirty = True\n'


def test_scanner_copies_only_requested_coverage_report(repository, monkeypatch):
    import scan_sonar

    report = repository / 'work' / 'coverage.xml'
    report.parent.mkdir()
    report.write_text('<coverage/>', encoding='utf-8')
    (report.parent / 'private.txt').write_text('private fixture', encoding='utf-8')

    def run(command, **kwargs):
        snapshot = Path(kwargs['cwd'])
        assert (snapshot / '.local/sonar/coverage.xml').read_text() == '<coverage/>'
        assert not (snapshot / 'work').exists()
        return subprocess.CompletedProcess(command, 0)

    with scan_sonar.source_snapshot(repository) as snapshot:
        monkeypatch.setattr(subprocess, 'run', run)
        assert scan_sonar.run_scanner(snapshot, repository / '.scannerwork', coverage=report) == 0
