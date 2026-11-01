import io
from pathlib import Path
import subprocess

import pytest

import quality_check


def test_push_checks_every_unique_tip_and_skips_deletions(monkeypatch, tmp_path):
    first, second, deleted = 'a' * 40, 'b' * 40, '0' * 40
    monkeypatch.setattr(quality_check.sys, 'stdin', io.StringIO(
        f'refs/heads/main {first} refs/heads/main {second}\n'
        f'refs/tags/v1 {first} refs/tags/v1 {deleted}\n'
        f'refs/heads/other {second} refs/heads/other {deleted}\n'
        f'(delete) {deleted} refs/heads/old {first}\n'
    ))
    checked = []
    monkeypatch.setattr(quality_check, 'verify', lambda root, revision=None: checked.append(revision) or 0)
    assert quality_check.pre_push(tmp_path) == 0
    assert checked == [first, second]


def test_push_stops_on_first_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(quality_check.sys, 'stdin', io.StringIO(
        f'main {"a" * 40} main {"b" * 40}\nother {"b" * 40} other {"0" * 40}\n'
    ))
    checked = []
    monkeypatch.setattr(quality_check, 'verify', lambda root, revision=None: checked.append(revision) or 9)
    assert quality_check.pre_push(tmp_path) == 9
    assert checked == ['a' * 40]


@pytest.mark.parametrize('line', ['bad input', 'main HEAD main ' + '0' * 40])
def test_push_rejects_invalid_input(monkeypatch, tmp_path, line):
    monkeypatch.setattr(quality_check.sys, 'stdin', io.StringIO(line))
    with pytest.raises(ValueError, match='pre-push'):
        quality_check.pre_push(tmp_path)


@pytest.mark.parametrize('failed_step', ['pytest', 'coverage'])
def test_test_failure_prevents_scanner_upload(monkeypatch, tmp_path, failed_step):
    from contextlib import contextmanager

    (tmp_path / 'pyproject.toml').write_text(
        '[tool.coverage.run]\nsource=["app"]\n[tool.coverage.report]\nfail_under=75\n', encoding='utf-8')
    @contextmanager
    def snapshot(*args):
        yield tmp_path
    monkeypatch.setattr(quality_check, 'source_snapshot', snapshot)
    monkeypatch.setattr(quality_check, 'check_server', lambda: None)
    monkeypatch.setenv('SONAR_TOKEN', 'fixture-secret')
    monkeypatch.setenv('PYTEST_ADDOPTS', '--cov-fail-under=0 -k selective')
    called = []
    def run(command, **kwargs):
        assert 'SONAR_TOKEN' not in kwargs['env']
        assert 'PYTEST_ADDOPTS' not in kwargs['env']
        assert kwargs['env'].get('UV_PYTHON') == quality_check.sys.executable
        called.append(command)
        return subprocess.CompletedProcess(command, 1 if failed_step in command else 0)
    monkeypatch.setattr(quality_check.subprocess, 'run', run)
    monkeypatch.setattr(quality_check, 'run_scanner', lambda *a, **kw: pytest.fail('Failed tests must not upload'))
    assert quality_check.verify(tmp_path) == 1
    assert any('pytest' in command for command in called)


def test_missing_coverage_configuration_blocks_old_commits(monkeypatch, tmp_path):
    from contextlib import contextmanager

    (tmp_path / 'pyproject.toml').write_text('[project]\nname="fixture"\n', encoding='utf-8')
    @contextmanager
    def snapshot(*args):
        yield tmp_path
    monkeypatch.setattr(quality_check, 'source_snapshot', snapshot)
    monkeypatch.setattr(quality_check, 'check_server', lambda: None)
    with pytest.raises(RuntimeError, match='Commit the local quality'):
        quality_check.verify(tmp_path, 'a' * 40)


@pytest.mark.parametrize('node_fails', [False, True], ids=['node-passes', 'node-fails'])
def test_node_tests_gate_scanner_upload(monkeypatch, tmp_path, node_fails):
    from contextlib import contextmanager

    project, snapshot_root = tmp_path/'project', tmp_path/'snapshot'
    test_root = snapshot_root/'tests'
    test_root.mkdir(parents=True)
    (snapshot_root/'pyproject.toml').write_text(
        '[tool.coverage.run]\nsource=["app"]\n[tool.coverage.report]\nfail_under=75\n', encoding='utf-8')
    (test_root/'test_gate.cjs').write_text(
        "const assert=require('node:assert/strict');require('node:test')('fixture',()=>{"
        "assert.equal(process.env.SONAR_TOKEN,undefined);"
        f"assert.equal({str(node_fails).lower()},false);" + '});', encoding='utf-8')
    # Only the unit-test files belong to this gate; browser tests have separate fixtures.
    browser_root = test_root/'browser'
    browser_root.mkdir()
    (browser_root/'test_browser.cjs').write_text('process.exit(99);', encoding='utf-8')
    coverage = snapshot_root/'.local/sonar/coverage.xml'
    coverage.parent.mkdir(parents=True)
    coverage.write_text('<coverage/>', encoding='utf-8')
    @contextmanager
    def snapshot(*args):
        yield snapshot_root
    monkeypatch.setattr(quality_check, 'source_snapshot', snapshot)
    monkeypatch.setattr(quality_check, 'check_server', lambda: None)
    monkeypatch.setenv('SONAR_TOKEN', 'fixture-secret')
    run_process = subprocess.run
    def run(command, **kwargs):
        if command[0] == 'uv':
            return subprocess.CompletedProcess(command, 0)
        return run_process(command, **kwargs)
    monkeypatch.setattr(quality_check.subprocess, 'run', run)
    uploaded = []
    monkeypatch.setattr(quality_check, 'run_scanner', lambda *a, **kw: uploaded.append(kw['coverage']) or 0)
    result = quality_check.verify(project)
    assert (result != 0) == node_fails
    assert uploaded == ([] if node_fails else [project/'.local/sonar/coverage.xml'])
