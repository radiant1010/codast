"""Run local tests, coverage and SonarQube before accepting a push."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib
from urllib.request import Request, urlopen

from scan_sonar import run_scanner, source_snapshot


def check_server():
    if not os.environ.get('SONAR_TOKEN'):
        raise RuntimeError('Set SONAR_TOKEN in the ignored .env.sonar file.')
    for executable in ('uv', 'node', 'pysonar'):
        if not shutil.which(executable):
            raise RuntimeError(f'{executable} is not installed or not on PATH.')
    host = os.environ.get('SONAR_HOST_URL', 'http://localhost:9000').rstrip('/')
    try:
        request = Request(f'{host}/api/authentication/validate', headers={
            'Authorization': f'Bearer {os.environ["SONAR_TOKEN"]}',
        })
        with urlopen(request, timeout=10) as response:
            valid = json.load(response).get('valid')
    except OSError as error:
        raise RuntimeError('Cannot reach SonarQube. Start the local Docker server and retry.') from error
    if not valid:
        raise RuntimeError('SonarQube rejected SONAR_TOKEN. Update the local token and retry.')


def verify(project: Path, revision=None) -> int:
    print(f'Checking {revision or "current working files"}', flush=True)
    with source_snapshot(project, revision) as sources:
        config = tomllib.loads((sources / 'pyproject.toml').read_text(encoding='utf-8'))
        coverage = config.get('tool', {}).get('coverage', {})
        if not coverage.get('run', {}).get('source') or 'fail_under' not in coverage.get('report', {}):
            raise RuntimeError('Commit the local quality configuration before pushing this revision.')
        check_server()
        report = project / '.local/sonar/coverage.xml'
        with source_snapshot(sources) as tests:
            environment = os.environ.copy()
            environment.pop('SONAR_TOKEN', None)
            environment.pop('PYTEST_ADDOPTS', None)
            environment.pop('VIRTUAL_ENV', None)
            environment['UV_PROJECT_ENVIRONMENT'] = str(tests / '.venv')
            environment['PYTHONUTF8'] = '1'
            environment['UV_PYTHON'] = sys.executable
            result = subprocess.run(['uv', 'sync', '--locked'], cwd=tests, env=environment)
            if result.returncode:
                return result.returncode
            result = subprocess.run([
                'uv', 'run', '--locked', '--no-sync', 'python', '-m', 'pytest', '-q', '-ra',
                '--cov', '--cov-config=pyproject.toml', '--cov-report=term:skip-covered',
                '--cov-fail-under=0',
            ], cwd=tests, env=environment)
            if result.returncode:
                return result.returncode
            node_tests = sorted((tests / 'tests').glob('test_*.cjs'))
            result = subprocess.run(['node', '--test', *map(str, node_tests)], cwd=tests, env=environment)
            if result.returncode:
                return result.returncode
            # coverage.py applies configured precision; pytest-cov's summary compares raw floats.
            result = subprocess.run([
                'uv', 'run', '--locked', '--no-sync', 'python', '-m', 'coverage',
                'xml', '--rcfile=pyproject.toml',
            ], cwd=tests, env=environment)
            if result.returncode:
                return result.returncode
            generated = tests / '.local/sonar/coverage.xml'
            if not generated.is_file():
                raise RuntimeError('Tests did not generate a coverage report. Push blocked.')
            report.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(generated, report)
        return run_scanner(sources, project / '.scannerwork', [
            '--sonar-qualitygate-wait', '--sonar-qualitygate-timeout=300',
        ], coverage=report)


def pre_push(project: Path) -> int:
    revisions = []
    for line in sys.stdin:
        fields = line.split()
        if len(fields) != 4 or not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', fields[1]):
            raise ValueError('Invalid Git pre-push input. Push blocked.')
        revision = fields[1]
        if set(revision) != {'0'} and revision not in revisions:
            revisions.append(revision)
    for revision in revisions:
        result = verify(project, revision)
        if result:
            return result
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pre-push', action='store_true', help='Read pushed revisions from Git')
    args = parser.parse_args()
    project = Path(__file__).resolve().parent
    try:
        return pre_push(project) if args.pre_push else verify(project)
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Quality check failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
