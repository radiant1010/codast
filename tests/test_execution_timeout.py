"""Long CLI work uses a frozen project policy, independent of UI connections."""
import asyncio
import json
import sys
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.llm.cli import CliAdapter, ProcessRunner
from app.main import create_app
from app.models.schemas import AgentResult, Command, ProjectSettings
from pydantic import ValidationError


@pytest.mark.parametrize('output', [False, True])
def test_unlimited_process_survives_elapsed_600_seconds(tmp_path, monkeypatch, output):
    import app.llm.cli as cli
    ticks = iter([0, 601, 602, 603, 604, 605])
    monkeypatch.setattr(cli, 'time', SimpleNamespace(monotonic=lambda: next(ticks, 606)))
    script = "import time\nfor i in range(3):\n " + ("print(i, flush=True); " if output else '') + "time.sleep(.1)"
    lines = []
    code, out, _ = ProcessRunner()._run(
        [sys.executable, '-u', '-c', script], str(tmp_path), '', None, threading.Event(),
        on_line=lambda channel, text: lines.append((channel, text)))
    assert code == 0
    assert len(lines) == (3 if output else 0)


def test_finite_timeout_is_total_time_even_with_continuous_progress(tmp_path):
    lines = []
    script = "import time\nwhile True: print('working', flush=True); time.sleep(.02)"
    with pytest.raises(TimeoutError):
        ProcessRunner()._run([sys.executable, '-u', '-c', script], str(tmp_path), '',
                    .5, threading.Event(), on_line=lambda channel, text: lines.append(text))
    assert len(lines) > 1


def test_unlimited_cancel_stops_parent_and_child_before_return(tmp_path):
    parent, child = tmp_path / 'parent', tmp_path / 'child'
    worker = "import pathlib,time,sys; p=pathlib.Path(sys.argv[1]); deadline=time.time()+10\nwhile time.time()<deadline: p.write_text(str(time.time_ns())); time.sleep(.03)"
    script = "import subprocess,sys; subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[3]]); exec(sys.argv[1].replace('sys.argv[1]', 'sys.argv[2]'))"
    cancel, errors = threading.Event(), []

    def run():
        try:
            ProcessRunner()._run([sys.executable, '-c', script, worker, str(parent), str(child)],
                                 str(tmp_path), '', None, cancel)
        except RuntimeError as exc:
            errors.append(str(exc))

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not (parent.exists() and child.exists()):
            assert time.monotonic() < deadline
            time.sleep(.02)
        cancel.set()
        thread.join(5)
        assert not thread.is_alive()
        assert errors == ['실행이 취소되었습니다.']
        stamps = [p.stat().st_mtime_ns for p in (parent, child)]
        time.sleep(.2)
        assert stamps == [p.stat().st_mtime_ns for p in (parent, child)]
    finally:
        cancel.set()
        thread.join(5)


@pytest.mark.parametrize('client', ['codex', 'claude'])
def test_adapter_passes_explicit_unlimited_policy_to_runner(tmp_path, monkeypatch, client):
    monkeypatch.setattr('app.core.toolchain.Toolchain.configuration', lambda *args: {})
    calls = []

    class Runner:
        async def run(self, argv, cwd, prompt, **options):
            calls.append(options)
            if client == 'claude':
                return 0, json.dumps({'type': 'result', 'subtype': 'success', 'result': 'ok'}), ''
            return 0, '\n'.join(map(json.dumps, [
                {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'ok'}},
                {'type': 'turn.completed'}])), ''

    adapter = CliAdapter(client, 'unused', runner=Runner())
    adapter.timeout_seconds = None
    assert asyncio.run(adapter.execute('{}', str(tmp_path), 'read-only')).output == 'ok'
    assert 'timeout' in calls[0] and calls[0]['timeout'] is None


@pytest.mark.parametrize('value', [None, 1, 600, 7200])
def test_project_timeout_is_validated_and_survives_restart(tmp_path, value):
    root = tmp_path / 'ws'
    harness = create_app(root).state.harness
    harness.projects.create('one')
    assert harness.settings('one').timeout_seconds == 600
    assert harness.save_settings('one', ProjectSettings(timeout_seconds=value)).timeout_seconds == value
    assert create_app(root).state.harness.settings('one').timeout_seconds == value


@pytest.mark.parametrize('value', [0, -1, True, '600', 1.5])
def test_invalid_timeout_is_rejected(tmp_path, value):
    with pytest.raises(ValidationError):
        ProjectSettings(timeout_seconds=value)


def test_prepared_run_keeps_its_timeout_after_project_setting_changes(tmp_path, monkeypatch):
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)
    harness = create_app(tmp_path / 'ws').state.harness
    harness.projects.create('one')
    harness.storage.save_settings('one', {'timeout_seconds': None})
    first = harness.prepare('one', Command(text='work', client='codex'))
    harness.storage.save_settings('one', {'timeout_seconds': 30})
    assert first[4].timeout_seconds is None
    assert harness.storage.run('one', first[0])['metadata']['timeout_seconds'] is None
    harness.storage.finish_run(first[0], 'interrupted')
    second = harness.prepare('one', Command(text='next', client='claude'))
    assert second[4].timeout_seconds == 30
    assert harness.storage.run('one', second[0])['metadata']['timeout_seconds'] == 30


def test_progress_survives_log_cap_metrics_and_terminal_persistence(tmp_path, monkeypatch):
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)
    harness = create_app(tmp_path / 'ws').state.harness
    harness.projects.create('one')
    harness.projects.create('two')
    harness.storage.save_settings('one', {'timeout_seconds': None})
    prepared = harness.prepare('one', Command(text='fixture', client='codex'))
    other = harness.prepare('two', Command(text='other fixture', client='claude'))
    with harness.storage.connect() as db:
        db.executemany('INSERT INTO run_events(run_id,kind,text,created_at) VALUES (?,?,?,?)',
                       [(prepared[0], 'output', 'fixture', '2026-01-01T00:00:00Z')] * 4097)

    async def execute(context, cwd, mode, session=None):
        prepared[4].on_progress()
        prepared[4].on_event('tool', 'not retained after cap')
        prepared[4].on_metrics({'execution_model': 'fixture-model'})
        return AgentResult(adapter='codex', output='done')

    prepared[4].execute = execute
    # This unit has no asynchronous I/O: drive it once to exercise real storage and callbacks.
    coroutine = harness.perform('one', prepared)
    with pytest.raises(StopIteration):
        coroutine.send(None)
    row = harness.storage.run('one', prepared[0])
    assert row['status'] == 'completed'
    assert row['metadata']['timeout_seconds'] is None
    assert row['metadata']['last_progress_at'] >= row['started_at']
    assert row['metadata']['execution_model'] is None  # Final AgentResult remains authoritative.
    assert harness.storage.run('two', other[0])['metadata']['last_progress_at'] is None
    with harness.storage.connect() as db:
        assert not db.execute("SELECT 1 FROM run_events WHERE text='not retained after cap'").fetchone()
    again = create_app(tmp_path / 'ws').state.harness.storage.run('one', prepared[0])
    assert again['metadata']['last_progress_at'] == row['metadata']['last_progress_at']


@pytest.mark.parametrize('client,events', [
    ('codex', [{'type': 'item.updated', 'item': {'type': 'reasoning', 'text': 'private'}}]),
    ('claude', [{'type': 'stream_event', 'event': {'type': 'content_block_delta',
                                                 'delta': {'type': 'thinking_delta', 'thinking': 'private'}}}]),
])
def test_progress_counts_real_cli_activity_without_storing_reasoning(client, events):
    adapter = CliAdapter(client, 'unused')
    activity, shown = [], []
    adapter.on_progress = lambda: activity.append(True)
    adapter.on_event = lambda kind, text: shown.append((kind, text))
    for event in events:
        adapter.stream_line('stdout', json.dumps(event))
    assert activity == [True]
    assert shown == []
    for event in [{'type': 'heartbeat'}, {'type': 'ping'}, {'type': 'system', 'subtype': 'heartbeat'},
                  {'type': 'stream_event', 'event': {'type': 'ping'}}, {'type': 'unknown'}]:
        adapter.stream_line('stdout', json.dumps(event))
    adapter.stream_line('stdout', 'not json')
    adapter.stream_line('stderr', 'diagnostic output')
    assert activity == [True]
    assert not any('heartbeat' in text for _, text in shown)


def test_progress_persists_beyond_log_limit_and_replay_does_not_execute_again(tmp_path, monkeypatch):
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)
    calls = []

    async def execute(self, context, cwd, mode, session=None):
        calls.append(self.timeout_seconds)
        self.on_progress()
        self.on_event('tool', 'fixture command')
        return AgentResult(adapter=self.client, output='done')

    monkeypatch.setattr(CliAdapter, 'execute', execute)
    root = tmp_path / 'ws'
    with TestClient(create_app(root)) as client:
        client.post('/api/projects', json={'name': 'one'})
        client.post('/api/projects', json={'name': 'two'})
        client.put('/api/projects/one/settings', json={'timeout_seconds': None})
        response = client.post('/api/projects/one/commands', json={'text': 'work', 'client': 'codex'})
        assert response.status_code == 200
        run_id = response.json()['run_id']
        row = client.get('/api/projects/one/runs/' + run_id).json()
        assert row['metadata']['last_progress_at'] >= row['started_at']
        assert row['metadata']['timeout_seconds'] is None
        progress = row['metadata']['last_progress_at']
        assert client.get('/api/projects/two/runs/' + run_id + '/events').status_code == 404
    with TestClient(create_app(root)) as client:
        replay = client.get('/api/projects/one/runs/' + run_id + '/events').text
        snapshots = [json.loads(chunk.split('data: ', 1)[1]) for chunk in replay.split('\n\n')
                     if chunk.startswith('event: runtime\n')]
        assert snapshots and snapshots[-1]['run_id'] == run_id
        assert snapshots[-1]['last_progress_at'] == progress
        assert snapshots[-1]['timeout_seconds'] is None
        assert snapshots[-1]['status'] == 'completed'
        assert snapshots[-1]['finished_at']
        assert calls == [None]
