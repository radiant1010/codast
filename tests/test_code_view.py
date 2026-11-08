"""#15 CV-1 acceptance: read-only code viewer API (tree, resolve, file, index cache)."""
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

BASE = '/api/projects/sample'
MIB = 1024 * 1024
CLI = ''.join(f'line {n}\n' for n in range(1, 31))


def write(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data, encoding='utf-8', newline='')


def make_link(link: Path, target: Path):
    if os.name == 'nt':
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)


@pytest.fixture
def project(tmp_path):
    external = tmp_path / 'external'
    write(external / 'app/llm/cli.py', CLI)
    write(external / 'src/main/java/com/example/ExampleService.java', 'class Main {}\n')
    write(external / 'src/test/java/com/example/ExampleService.java', 'class Test {}\n')
    write(external / 'sub/inner.py', 'sub\n')
    write(external / 'inner.py', 'root\n')
    write(external / 'README.md', '# sample\n')
    write(external / 'node_modules/pkg/index.js', 'module.exports = 1\n')
    write(external / '.git/config', '[core]\n')
    write(external / '.env', 'TOKEN=fixture\n')
    write(external / '.env.local', 'TOKEN=fixture\n')
    write(external / 'enc/bom.py', b'\xef\xbb\xbfprint(1)\n')
    write(external / 'enc/cp949.txt', '한글 주석\n'.encode('cp949'))
    write(external / 'enc/invalid.txt', b'abc\xff\xff\n')
    write(external / 'enc/bin.dat', b'PNG\x00\x01\x02')
    write(external / 'enc/exact.txt', b'a' * MIB)
    write(external / 'enc/big.txt', b'a' * (MIB + 1))
    outside = tmp_path / 'outside'
    write(outside / 'secret.py', 'outside\n')
    make_link(external / 'linked', outside)
    with TestClient(create_app(tmp_path / 'managed')) as client:
        registered = client.post('/api/workspaces', json={'name': 'sample', 'path': str(external)})
        assert registered.status_code == 201, registered.text
        yield client, external, outside


def resolve(client, ref):
    return client.get(BASE + '/code/resolve', params={'ref': ref})


def resolved_path(client, ref):
    response = resolve(client, ref)
    assert response.status_code == 200, (ref, response.status_code, response.text)
    body = response.json()
    assert 'candidates' not in body and not body.get('pending'), (ref, body)
    return body['path']


# Tree: one level from disk, folders first, protected names and links hidden.

def test_tree_root_lists_one_level_with_folders_first_and_hides_protected_and_links(project):
    client, _, _ = project
    response = client.get(BASE + '/code/tree')
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['entries'] == [
        {'name': 'app', 'type': 'dir'},
        {'name': 'enc', 'type': 'dir'},
        {'name': 'node_modules', 'type': 'dir'},
        {'name': 'src', 'type': 'dir'},
        {'name': 'sub', 'type': 'dir'},
        {'name': 'inner.py', 'type': 'file'},
        {'name': 'README.md', 'type': 'file'},
    ]
    assert body['truncated'] is False


def test_tree_nested_path_reads_only_that_folder(project):
    client, _, _ = project
    body = client.get(BASE + '/code/tree', params={'path': 'src/main'}).json()
    assert body['entries'] == [{'name': 'java', 'type': 'dir'}]
    ignored = client.get(BASE + '/code/tree', params={'path': 'node_modules/pkg'}).json()
    assert ignored['entries'] == [{'name': 'index.js', 'type': 'file'}]


@pytest.mark.parametrize('path, status', [('..', 403), ('.git', 403), ('linked', 403), ('missing', 404), ('inner.py', 400)])
def test_tree_rejects_outside_protected_missing_and_file_paths(project, path, status):
    client, _, _ = project
    assert client.get(BASE + '/code/tree').status_code == 200, 'tree API must exist before its refusals mean anything'
    assert client.get(BASE + '/code/tree', params={'path': path}).status_code == status


def test_tree_caps_large_folder_at_5000_entries(project):
    client, external, _ = project
    crowded = external / 'crowded'
    crowded.mkdir()
    for number in range(5001):
        (crowded / f'f{number:05}.txt').touch()
    body = client.get(BASE + '/code/tree', params={'path': 'crowded'}).json()
    assert len(body['entries']) == 5000
    assert body['truncated'] is True


# Resolve: absolute -> cwd -> root -> a/ b/ prefix -> whole-project suffix match.

def test_resolve_absolute_path_inside_project_returns_relative_path(project):
    client, external, _ = project
    native = str(external / 'app' / 'llm' / 'cli.py')
    assert resolved_path(client, native) == 'app/llm/cli.py'
    assert resolved_path(client, external.as_posix() + '/app/llm/cli.py') == 'app/llm/cli.py'


@pytest.mark.skipif(os.name != 'nt', reason='Windows paths are case-insensitive')
def test_resolve_absolute_path_ignores_case_on_windows(project):
    client, external, _ = project
    assert resolved_path(client, str(external / 'APP' / 'LLM' / 'CLI.PY').upper()) == 'app/llm/cli.py'


def test_resolve_rejects_absolute_and_relative_paths_outside_project(project):
    client, _, outside = project
    assert resolve(client, str(outside / 'secret.py')).status_code == 403
    assert resolve(client, '../outside/secret.py').status_code == 403


def test_resolve_relative_path_prefers_working_directory_then_root(project):
    client, _, _ = project
    assert resolved_path(client, 'inner.py') == 'inner.py'
    saved = client.put(BASE + '/settings', json={'client': 'mock', 'mode': 'read-only', 'cwd': 'sub'})
    assert saved.status_code == 200, saved.text
    assert resolved_path(client, 'inner.py') == 'sub/inner.py'
    assert resolved_path(client, 'app/llm/cli.py') == 'app/llm/cli.py'


@pytest.mark.parametrize('ref', ['a/app/llm/cli.py', 'b/app/llm/cli.py'])
def test_resolve_strips_diff_prefixes(project, ref):
    client, _, _ = project
    assert resolved_path(client, ref) == 'app/llm/cli.py'


def test_resolve_bare_name_finds_unique_file_anywhere_in_project(project):
    client, _, _ = project
    assert resolved_path(client, 'cli.py') == 'app/llm/cli.py'
    assert resolved_path(client, 'main/java/com/example/ExampleService.java') == 'src/main/java/com/example/ExampleService.java'


@pytest.mark.skipif(os.name != 'nt', reason='Windows file names are case-insensitive')
def test_resolve_bare_name_ignores_case_on_windows(project):
    client, _, _ = project
    assert resolved_path(client, 'CLI.PY') == 'app/llm/cli.py'


@pytest.mark.parametrize('ref', ['ExampleService.java', 'example/ExampleService.java'])
def test_resolve_bare_name_with_duplicates_returns_sorted_candidates(project, ref):
    client, _, _ = project
    response = resolve(client, ref)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['candidates'] == [
        'src/main/java/com/example/ExampleService.java',
        'src/test/java/com/example/ExampleService.java',
    ]
    assert body['truncated'] is False


def test_resolve_caps_candidates_at_50(project):
    client, external, _ = project
    for number in range(51):
        write(external / f'many/d{number:02}/dup.py', 'x\n')
    client.post(BASE + '/code/refresh')
    body = resolve(client, 'dup.py').json()
    assert len(body['candidates']) == 50
    assert body['truncated'] is True


def test_resolve_candidates_put_project_files_before_hidden_folders_and_deep_copies(project):
    # Real projects keep tool caches in dot folders (.local, .cache); sorting by path alone
    # filled all 50 slots with them and cut the project's own file from the list.
    client, external, _ = project
    for number in range(60):
        write(external / f'.cache/pkg{number:02}/__init__.py', '')
    write(external / 'tools/vendor/lib/site/__init__.py', '')
    write(external / 'app/llm/__init__.py', '')
    write(external / 'app/__init__.py', '')
    write(external / 'zeta/__init__.py', '')
    body = resolve(client, '__init__.py').json()
    assert body['candidates'][:4] == [
        'app/__init__.py',
        'zeta/__init__.py',
        'app/llm/__init__.py',
        'tools/vendor/lib/site/__init__.py',
    ]
    assert body['candidates'][4:] == [f'.cache/pkg{number:02}/__init__.py' for number in range(46)]
    assert body['truncated'] is True


@pytest.mark.parametrize('ref', ['missing.py', 'xampleService.java', 'index.js', 'config', 'secret.py'])
def test_resolve_misses_unknown_names_partial_segments_ignored_and_protected_folders(project, ref):
    client, _, _ = project
    assert resolved_path(client, 'cli.py') == 'app/llm/cli.py'
    assert resolve(client, ref).status_code == 404


def test_resolve_explicit_path_into_ignored_folder_still_opens(project):
    client, _, _ = project
    assert resolved_path(client, 'node_modules/pkg/index.js') == 'node_modules/pkg/index.js'


@pytest.mark.parametrize('ref', ['.env', '.env.local', '.git/config'])
def test_resolve_rejects_protected_files(project, ref):
    client, external, _ = project
    assert resolve(client, ref).status_code == 403
    assert resolve(client, str(external / ref)).status_code == 403


# File: read-only, 1 MiB, binary and encoding checks.

def test_file_returns_utf8_content_with_size(project):
    client, _, _ = project
    response = client.get(BASE + '/code/file', params={'path': 'app/llm/cli.py'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['path'] == 'app/llm/cli.py'
    assert body['content'] == CLI
    assert body['encoding'] == 'utf-8'
    assert body['size'] == len(CLI.encode('utf-8'))


@pytest.mark.parametrize('path, encoding, content', [
    ('enc/bom.py', 'utf-8-sig', 'print(1)\n'),
    ('enc/cp949.txt', 'cp949', '한글 주석\n'),
])
def test_file_decodes_bom_and_cp949(project, path, encoding, content):
    client, _, _ = project
    body = client.get(BASE + '/code/file', params={'path': path}).json()
    assert (body['encoding'], body['content']) == (encoding, content)


def test_file_allows_exactly_1_mib(project):
    client, _, _ = project
    response = client.get(BASE + '/code/file', params={'path': 'enc/exact.txt'})
    assert response.status_code == 200, response.text
    assert response.json()['size'] == MIB


@pytest.mark.parametrize('path, status', [
    ('enc/big.txt', 400), ('enc/bin.dat', 400), ('enc/invalid.txt', 400), ('app', 400),
    ('.env', 403), ('../outside/secret.py', 403), ('linked/secret.py', 403), ('missing.py', 404),
])
def test_file_rejects_large_binary_unknown_encoding_directories_protected_and_missing(project, path, status):
    client, _, _ = project
    assert client.get(BASE + '/code/file', params={'path': 'app/llm/cli.py'}).status_code == 200, 'file API must exist first'
    assert client.get(BASE + '/code/file', params={'path': path}).status_code == status


def test_existing_file_api_keeps_its_64_kib_limit(project):
    client, _, _ = project
    assert client.get(BASE + '/file', params={'path': 'enc/exact.txt'}).status_code == 400


# Whole-project file list cache.

def test_index_is_reused_until_a_run_finishes(project):
    client, external, _ = project
    assert resolved_path(client, 'cli.py') == 'app/llm/cli.py'
    write(external / 'late/added_after.py', 'late\n')
    assert resolve(client, 'added_after.py').status_code == 404, 'a fresh index must be reused, not rescanned on every miss'
    run = client.post(BASE + '/commands', json={'text': 'fixture run', 'task': 'fixture chat'})
    assert run.status_code == 200, run.text
    assert resolved_path(client, 'added_after.py') == 'late/added_after.py'


def test_refresh_rebuilds_index(project):
    client, external, _ = project
    assert resolved_path(client, 'cli.py') == 'app/llm/cli.py'
    write(external / 'late/added_after.py', 'late\n')
    assert resolve(client, 'added_after.py').status_code == 404
    refreshed = client.post(BASE + '/code/refresh')
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json() == {'started': True}
    assert resolved_path(client, 'added_after.py') == 'late/added_after.py'


def test_concurrent_bare_name_requests_scan_project_root_once(project, monkeypatch):
    client, external, _ = project
    root = external.resolve()
    real_scandir, root_scans = os.scandir, []

    def counting_scandir(path='.'):
        if Path(os.fspath(path)).resolve() == root:
            root_scans.append(path)
        return real_scandir(path)

    monkeypatch.setattr(os, 'scandir', counting_scandir)
    barrier = Barrier(8)

    def request(_):
        barrier.wait()
        return resolve(client, 'cli.py')

    with ThreadPoolExecutor(8) as pool:
        responses = list(pool.map(request, range(8)))
    assert [r.status_code for r in responses] == [200] * 8
    assert {r.json()['path'] for r in responses} == {'app/llm/cli.py'}
    assert len(root_scans) == 1, f'project root must be scanned once with os.scandir, got {len(root_scans)}'
