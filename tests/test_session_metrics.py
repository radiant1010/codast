import json
from pathlib import Path
from uuid import uuid4

import pytest

from app.llm.cli import CliAdapter


def test_claude_context_is_latest_main_request_including_cache():
    events = [
        {'type': 'system', 'subtype': 'init', 'model': 'alias', 'session_id': 'session'},
        {'type': 'assistant', 'message': {'model': 'actual', 'usage': {'input_tokens': 900}}},
        {'type': 'assistant', 'message': {'model': 'actual', 'usage': {
            'input_tokens': 10, 'cache_creation_input_tokens': 20, 'cache_read_input_tokens': 70}}},
        {'type': 'assistant', 'parent_tool_use_id': 'child', 'message': {'model': 'other', 'usage': {'input_tokens': 5000}}},
        {'type': 'result', 'result': 'done', 'session_id': 'session', 'usage': {'input_tokens': 90000},
         'modelUsage': {'actual': {'contextWindow': 1000}, 'other': {'contextWindow': 2000}}},
    ]
    result = CliAdapter('claude', 'fake').parse('\n'.join(map(json.dumps, events)))
    assert result.execution_model == 'actual'
    assert result.context_usage['used_tokens'] == 100
    assert result.context_usage['window_tokens'] == 1000
    assert result.usage['input_tokens'] == 90000


def test_claude_context_zero_missing_and_compaction():
    from app.llm.session_metrics import update_claude_metrics
    metrics = {}
    update_claude_metrics(metrics, {'type': 'assistant', 'message': {'model': 'actual', 'usage': {'input_tokens': 0}}})
    assert metrics['context_usage']['used_tokens'] == 0
    assert metrics['context_usage']['window_tokens'] is None
    update_claude_metrics(metrics, {'type': 'system', 'subtype': 'compact_boundary'})
    assert metrics['context_usage']['used_tokens'] is None
    update_claude_metrics(metrics, {'type': 'assistant', 'message': {'model': 'actual', 'usage': {'input_tokens': True}}})
    assert metrics['context_usage']['used_tokens'] is None


def test_model_switch_does_not_pair_previous_usage_with_new_capacity():
    from app.llm.session_metrics import update_claude_metrics
    metrics = {}
    update_claude_metrics(metrics, {'type': 'assistant', 'message': {'model': 'old', 'usage': {'input_tokens': 900}}})
    update_claude_metrics(metrics, {'type': 'assistant', 'message': {'model': 'new', 'usage': {}}})
    update_claude_metrics(metrics, {'type': 'result', 'modelUsage': {'new': {'contextWindow': 1000}}})
    assert metrics['execution_model'] == 'new'
    assert metrics['context_usage']['used_tokens'] is None
    assert metrics['context_usage']['observed_at']


@pytest.mark.parametrize('compressed', [False, True])
def test_codex_reads_scoped_latest_context_and_compressed_history(tmp_path, monkeypatch, compressed):
    import zstandard
    from app.llm.session_metrics import SessionMetrics
    identity = str(uuid4())
    home = tmp_path / 'codex'
    path = home / 'sessions' / f'rollout-{identity}.jsonl'
    path.parent.mkdir(parents=True)
    events = [
        {'type': 'session_meta', 'payload': {'id': identity, 'cwd': str(tmp_path)}},
        {'type': 'turn_context', 'payload': {'model': 'actual'}},
        {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
            'total_token_usage': {'total_tokens': 90000}, 'last_token_usage': {'total_tokens': 200}, 'model_context_window': 1000}}},
        {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
            'last_token_usage': {'total_tokens': 0}, 'model_context_window': 1000}}},
    ]
    data = '\n'.join(map(json.dumps, events)).encode()
    target = Path(str(path) + '.zst') if compressed else path
    target.write_bytes(zstandard.ZstdCompressor().compress(data) if compressed else data)
    monkeypatch.setenv('CODEX_HOME', str(home))
    calls = []
    def request(*args):
        calls.append(args)
        return {'thread': {'id': identity, 'cwd': str(tmp_path), 'path': str(path), 'model': 'fallback'}}
    monkeypatch.setattr('app.core.native_threads.request', request)
    reader = SessionMetrics()
    metrics = reader.read('codex', tmp_path, identity)
    assert metrics['execution_model'] == 'actual'
    assert metrics['context_usage']['used_tokens'] == 0
    assert metrics['context_usage']['window_tokens'] == 1000
    assert reader.read('codex', tmp_path, identity) == metrics
    assert len(calls) == 1
    assert reader.read('codex', tmp_path / 'other', identity)['state'] == 'unavailable'
    assert 'context_usage' not in reader.read('codex', tmp_path / 'other', identity)


def test_claude_native_records_are_scoped_and_sidechains_are_ignored(tmp_path, monkeypatch):
    from app.llm.session_metrics import SessionMetrics
    identity = str(uuid4())
    base = tmp_path / 'claude'
    path = base / 'projects' / 'workspace' / (identity + '.jsonl')
    path.parent.mkdir(parents=True)
    def event(cwd, side=False):
        return {'type': 'assistant', 'sessionId': identity, 'cwd': str(cwd), 'isSidechain': side,
                'message': {'model': 'actual', 'usage': {'input_tokens': 42}}}
    path.write_text(json.dumps(event(tmp_path)) + '\n' + json.dumps(event('/other', True)), encoding='utf-8')
    monkeypatch.setenv('CLAUDE_CONFIG_DIR', str(base))
    reader = SessionMetrics()
    assert reader.read('claude', tmp_path, identity)['context_usage']['used_tokens'] == 42
    assert reader.read('claude', tmp_path / 'other', identity)['state'] == 'unavailable'


def test_unknown_ids_do_not_launch_cli(monkeypatch, tmp_path):
    from app.llm.session_metrics import SessionMetrics
    monkeypatch.setattr('app.core.native_threads.request', lambda *args: pytest.fail('invalid ID queried'))
    assert SessionMetrics().read('codex', tmp_path, 'invalid')['state'] == 'unavailable'


def test_streaming_reports_measured_model_and_context_before_completion():
    adapter = CliAdapter('claude', 'fake')
    observed = []
    adapter.on_metrics = lambda metrics: observed.append(json.loads(json.dumps(metrics)))
    adapter.on_event = lambda *args: None
    adapter.stream_line('stdout', json.dumps({'type': 'system', 'subtype': 'init', 'session_id': 'native', 'model': 'initial'}))
    adapter.stream_line('stdout', json.dumps({'type': 'assistant', 'message': {'model': 'actual', 'usage': {'input_tokens': 17}}}))
    assert observed[0]['session_id'] == 'native'
    assert observed[0]['context_usage']['used_tokens'] is None
    assert observed[0]['context_usage']['observed_at']
    assert observed[-1]['execution_model'] == 'actual'
    assert observed[-1]['context_usage']['used_tokens'] == 17


def test_reader_rejects_wrong_session_and_outside_store(tmp_path):
    from app.llm.session_metrics import read_metrics_file, safe_path
    path = tmp_path / 'record.jsonl'
    path.write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'wrong', 'cwd': str(tmp_path)}}))
    with pytest.raises(ValueError):
        read_metrics_file(path, tmp_path, 'expected', 'codex')
    with pytest.raises(ValueError):
        safe_path(path, tmp_path / 'elsewhere')


def test_slow_native_lookup_does_not_block_overview_or_queue_duplicates(tmp_path, monkeypatch):
    from threading import Event
    from app.llm.session_metrics import SessionMetrics
    started, release = Event(), Event()
    reader = SessionMetrics()
    identity = str(uuid4())
    calls = []
    def slow(*args):
        calls.append(args)
        started.set()
        release.wait(5)
        return {}
    monkeypatch.setattr(reader, 'read', slow)
    try:
        assert reader.snapshot('codex', tmp_path, identity)['state'] == 'loading'
        assert started.wait(1)
        for _ in range(3):
            assert reader.snapshot('codex', tmp_path, identity)['state'] == 'loading'
        assert len(calls) == 1
    finally:
        release.set()
        reader.close()
