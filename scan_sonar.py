"""Scan Git source snapshots without traversing private runtime directories."""

from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def reject_ignored_tracked_files(project):
    ignored = subprocess.run(
        ['git', 'ls-files', '-ci', '--exclude-standard', '-z'],
        cwd=project, check=True, capture_output=True,
    ).stdout
    if ignored:
        raise RuntimeError('Git tracks ignored files. Untrack private files before scanning.')


@contextmanager
def source_snapshot(project: Path, revision=None):
    project = project.resolve()
    # shortcut: Python analyzer 5.32 walks ignored folders; remove snapshots once fixed upstream.
    with tempfile.TemporaryDirectory(prefix='codast-sonar-') as temporary:
        temporary_path = Path(temporary).resolve()
        if temporary_path.parent != Path(tempfile.gettempdir()).resolve():
            raise RuntimeError('Unexpected temporary directory location.')
        snapshot = temporary_path / 'project'
        subprocess.run(
            ['git', 'clone', '--quiet', '--no-hardlinks', '--no-checkout', str(project), str(snapshot)],
            check=True,
        )
        commit = 'HEAD'
        if revision:
            commit = subprocess.check_output(
                ['git', 'rev-parse', '--verify', '--end-of-options', f'{revision}^{{commit}}'],
                cwd=snapshot, text=True,
            ).strip()
        subprocess.run(['git', 'reset', '--mixed', '--quiet', commit], cwd=snapshot, check=True)
        if revision:
            entries = subprocess.check_output(['git', 'ls-files', '--stage', '-z'], cwd=snapshot)
            if any(entry and entry[:6] not in (b'100644', b'100755') for entry in entries.split(b'\0')):
                raise RuntimeError('Linked paths and submodules are not supported.')
            subprocess.run(['git', 'checkout-index', '--all'], cwd=snapshot, check=True)
            reject_ignored_tracked_files(snapshot)
        else:
            reject_ignored_tracked_files(project)
            listed = subprocess.check_output(
                ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=project,
            )
            for raw in dict.fromkeys(listed.split(b'\0')):
                if not raw:
                    continue
                relative = Path(os.fsdecode(raw))
                source = project / relative
                if source.is_symlink() or source.resolve() != source:
                    raise RuntimeError(f'Linked paths are not supported: {relative}')
                if not source.exists():
                    continue
                if not source.is_file():
                    raise RuntimeError(f'Expected a file, not a submodule or directory: {relative}')
                destination = snapshot / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
        yield snapshot


def run_scanner(snapshot, work_directory, arguments=(), *, coverage=None):
    if coverage:
        destination = snapshot / '.local/sonar/coverage.xml'
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(coverage, destination)
    return subprocess.run(
        ['pysonar', f'--sonar-working-directory={work_directory}', *arguments], cwd=snapshot,
    ).returncode


def scan(project: Path, arguments=()) -> int:
    project = project.resolve()
    with source_snapshot(project) as snapshot:
        return run_scanner(snapshot, project / '.scannerwork', arguments)


if __name__ == '__main__':
    sys.exit(scan(Path(__file__).resolve().parent, sys.argv[1:]))
