"""#8 P-1 acceptance: Claude task-list tools become structured plan events.

Event shapes are trimmed from a real Claude Code 2.1.317 run (2026-11-08) with
`--tools <default tools>,TaskCreate,TaskUpdate,TaskList,TaskGet`; ids are shortened.
"""
import asyncio
import importlib
import json
import os
import threading
import time

import pytest

from app.llm.cli import CliAdapter
from app.models.schemas import AgentResult

cli = importlib.import_module('app.llm.cli')
REAL_PROBE = getattr(cli, 'claude_builtin_tools', None)  # captured before the conftest guard replaces it
TASK_TOOLS = {'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'}
# Measured 2026-11-08 with CODAST's real prompt: a softer sentence, or one placed after the question-format block,
# was ignored (0 of 13 runs); this one right after the first line was followed in 5 of 5 multi-step runs.
GUIDE = ('이 요청이 두 단계 이상이면 작업을 시작하기 전에 반드시 TaskCreate 도구로 단계를 모두 등록하고, 각 단계를 시작할 때 '
         'TaskUpdate로 status를 in_progress로, 마칠 때 completed로 바꾸세요. 이 작업 목록은 사용자 화면에 진행 상황으로 표시됩니다. '
         '한 번에 끝나는 요청에는 만들지 마세요.')
S = 'session-a'


def call(tool_id, name, data, parent=None):
    return {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
        {'type': 'tool_use', 'id': tool_id, 'name': name, 'input': data}]}, 'parent_tool_use_id': parent, 'session_id': S}


def result(tool_id, text, structured, parent=None, is_error=None):
    block = {'type': 'tool_result', 'tool_use_id': tool_id, 'content': text}
    if is_error is not None:
        block['is_error'] = is_error
    return {'type': 'user', 'message': {'role': 'user', 'content': [block]}, 'parent_tool_use_id': parent,
            'session_id': S, 'tool_use_result': structured}


CAPTURED = [
    call('toolu_01', 'ToolSearch', {'query': 'select:TaskCreate,TaskUpdate,TaskList', 'max_results': 3}),
    result('toolu_01', [{'type': 'tool_reference', 'tool_name': 'TaskCreate'}],
           {'matches': ['TaskCreate', 'TaskUpdate', 'TaskList'], 'query': 'select:TaskCreate,TaskUpdate,TaskList'}),
    call('toolu_02', 'TaskCreate', {'subject': '분석', 'description': '분석 항목', 'activeForm': '분석하는 중'}),
    result('toolu_02', 'Task #1 created successfully: 분석', {'task': {'id': '1', 'subject': '분석', 'description': '분석 항목'}}),
    call('toolu_03', 'TaskCreate', {'subject': '정리', 'description': '정리 항목'}),
    result('toolu_03', 'Task #2 created successfully: 정리', {'task': {'id': '2', 'subject': '정리', 'description': '정리 항목'}}),
    call('toolu_04', 'TaskUpdate', {'taskId': '1', 'status': 'in_progress'}),
    result('toolu_04', 'Updated task #1 status', {'success': True, 'taskId': '1', 'updatedFields': ['status'],
                                                  'statusChange': {'from': 'pending', 'to': 'in_progress'}}),
    call('toolu_05', 'TaskUpdate', {'taskId': '1', 'status': 'completed'}),
    result('toolu_05', 'Updated task #1 status', {'success': True, 'taskId': '1', 'updatedFields': ['status'],
                                                  'statusChange': {'from': 'in_progress', 'to': 'completed'}}),
    call('toolu_06', 'TaskUpdate', {'taskId': '2', 'status': 'deleted'}),
    result('toolu_06', 'Updated task #2 deleted', {'success': True, 'taskId': '2', 'updatedFields': ['deleted'],
                                                   'statusChange': {'from': 'pending', 'to': 'deleted'}}),
    call('toolu_07', 'TaskUpdate', {'taskId': '99', 'status': 'completed'}),
    result('toolu_07', 'Task not found', {'success': False, 'taskId': '99', 'updatedFields': [], 'error': 'Task not found'}),
    call('toolu_08', 'TaskList', {}),
    result('toolu_08', '#1 [completed] 분석', {'tasks': [{'id': '1', 'subject': '분석', 'status': 'completed', 'blockedBy': []}]}),
]


def feed(events, client='claude'):
    adapter, seen = CliAdapter(client, client + '.exe'), []
    adapter.on_event = lambda kind, text: seen.append((kind, text))
    for event in events:
        adapter.stream_line('stdout', json.dumps(event, ensure_ascii=False))
    return [json.loads(text) for kind, text in seen if kind == 'plan'], seen


CONTROL = CAPTURED[2:4]  # a successful TaskCreate of #1, so "nothing else" checks only pass when parsing works


def only_control(events):
    plans, _ = feed(CONTROL + events)
    assert [(p['op'], p['id']) for p in plans] == [('create', '1')]


# Parsing: one plan event per successful Task* result, in order.

def test_captured_task_calls_become_plan_events_in_order():
    plans, seen = feed(CAPTURED)
    assert [(p['op'], p['session'], p.get('id')) for p in plans] == [
        ('create', S, '1'), ('create', S, '2'), ('update', S, '1'), ('update', S, '1'), ('update', S, '2'), ('snapshot', S, None)]
    first, second = plans[0], plans[1]
    assert (first['subject'], first['activeForm'], first['status']) == ('분석', '분석하는 중', 'pending')
    assert (second['subject'], second.get('activeForm'), second['status']) == ('정리', None, 'pending')
    assert [p['status'] for p in plans[2:5]] == ['in_progress', 'completed', 'deleted']
    assert plans[5]['tasks'] == [{'id': '1', 'subject': '분석', 'status': 'completed'}]
    assert any(kind == 'tool' and text.startswith('TaskCreate') for kind, text in seen), 'the raw tool log line stays'


def test_failed_and_error_results_make_no_plan_event():
    only_control(CAPTURED[12:14])  # TaskUpdate on a missing task: success false
    only_control([call('toolu_20', 'TaskCreate', {'subject': '실패'}),
                  result('toolu_20', 'tool failed', {'task': {'id': '5', 'subject': '실패'}}, is_error=True)])
    only_control([call('toolu_21', 'TaskCreate', {'subject': '결과 없음'}),
                  result('toolu_21', 'no structured result', None)])


def test_subagent_task_calls_are_ignored():
    only_control([call('toolu_30', 'TaskCreate', {'subject': '하위 작업'}, parent='toolu_parent'),
                  result('toolu_30', 'Task #7 created successfully: 하위 작업', {'task': {'id': '7', 'subject': '하위 작업'}}, parent='toolu_parent')])


def test_unpaired_calls_and_results_make_nothing():
    only_control([call('toolu_40', 'TaskCreate', {'subject': '응답 없음'})])
    only_control([result('toolu_41', 'Task #3 created successfully: 모름', {'task': {'id': '3', 'subject': '모름'}})])


def test_user_event_with_two_results_is_skipped_as_ambiguous():
    calls = [call('toolu_50', 'TaskCreate', {'subject': '가'}), call('toolu_51', 'TaskCreate', {'subject': '나'})]
    both = {'type': 'user', 'parent_tool_use_id': None, 'session_id': S, 'message': {'role': 'user', 'content': [
        {'type': 'tool_result', 'tool_use_id': 'toolu_50', 'content': 'Task #3 created successfully: 가'},
        {'type': 'tool_result', 'tool_use_id': 'toolu_51', 'content': 'Task #4 created successfully: 나'}]},
        'tool_use_result': {'task': {'id': '3', 'subject': '가'}}}
    only_control(calls + [both])


def test_update_carries_only_fields_that_changed():
    plans, _ = feed([call('toolu_60', 'TaskUpdate', {'taskId': '1', 'subject': '새 제목', 'activeForm': '새 제목 하는 중'}),
                     result('toolu_60', 'Updated task #1 subject', {'success': True, 'taskId': '1', 'updatedFields': ['subject', 'activeForm']})])
    assert len(plans) == 1
    assert (plans[0]['op'], plans[0]['id'], plans[0]['subject'], plans[0]['activeForm']) == ('update', '1', '새 제목', '새 제목 하는 중')
    assert 'status' not in plans[0]


def test_long_subject_and_active_form_are_cut_to_200_characters():
    plans, _ = feed([call('toolu_70', 'TaskCreate', {'subject': '가' * 300, 'activeForm': '나' * 300}),
                     result('toolu_70', 'Task #1 created successfully', {'task': {'id': '1', 'subject': '가' * 300}})])
    assert len(plans[0]['subject']) == 200 and len(plans[0]['activeForm']) == 200


def test_task_get_and_other_tools_make_no_plan_event():
    only_control([call('toolu_80', 'TaskGet', {'taskId': '1'}),
                  result('toolu_80', '#1 분석', {'task': {'id': '1', 'subject': '분석', 'status': 'pending'}}),
                  call('toolu_81', 'Read', {'file_path': 'a.py'}),
                  result('toolu_81', 'print(1)', {'type': 'text'})])


def test_codex_output_never_makes_plan_events():
    lines = [{'type': 'item.completed', 'item': {'id': '1', 'type': 'agent_message', 'text': '완료'}},
             {'type': 'item.completed', 'item': {'id': '2', 'type': 'todo_list', 'items': [{'text': '가', 'completed': False}]}}]
    assert feed(lines, client='codex')[0] == []


# Default tool list probe: one short CLI start per Claude path and version, killed right after init.

INIT = {'type': 'system', 'subtype': 'init', 'session_id': 'probe', 'tools': ['Task', 'Bash', 'Read', 'Edit', 'mcp__docs__read']}


class FakeStream:
    def __init__(self, lines, delay=0.0, block=False):
        self.lines, self.delay, self.block = list(lines), delay, block

    def __iter__(self):
        if self.delay:
            time.sleep(self.delay)
        while self.block:
            time.sleep(0.05)
        yield from self.lines

    def readline(self):
        for line in self:
            self.lines.remove(line)
            return line
        return self.lines[0][:0] if self.lines else b''

    def read(self, *args):
        return b''.join(line if isinstance(line, bytes) else line.encode() for line in self)

    def close(self):
        pass


class FakeStdin:
    def __init__(self):
        self.data, self.closed = b'', False

    def write(self, data):
        self.data += data if isinstance(data, bytes) else data.encode()
        return len(data)

    def flush(self):
        pass

    def close(self):
        self.closed = True


class Spawner:
    def __init__(self, lines=(json.dumps(INIT),), delay=0.0, block=False, error=None):
        self.lines, self.delay, self.block, self.error = lines, delay, block, error
        self.calls, self.processes, self.lock = [], [], threading.Lock()

    def __call__(self, argv, **kwargs):
        cwd = kwargs.get('cwd')
        with self.lock:
            self.calls.append({'argv': list(argv), 'kwargs': kwargs, 'cwd_empty': bool(cwd) and os.path.isdir(cwd) and not os.listdir(cwd)})
        if self.error:
            raise self.error
        text = bool(kwargs.get('text') or kwargs.get('universal_newlines') or kwargs.get('encoding'))
        lines = [(line + '\n') if text else (line + '\n').encode() for line in self.lines]
        process = FakeProcess(FakeStream(lines, self.delay, self.block))
        self.processes.append(process)
        return process


class FakeProcess:
    def __init__(self, stdout):
        self.stdin, self.stdout, self.stderr = FakeStdin(), stdout, FakeStream([])
        self.killed, self.returncode, self.pid = False, None, 4242

    def kill(self):
        self.killed, self.returncode, self.stdout.block = True, -9, False

    terminate = kill

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = -9 if self.returncode is None else self.returncode
        return self.returncode

    def communicate(self, *args, **kwargs):
        raise AssertionError('the probe must not wait for the model answer; read init and kill')


def run_probe(path):
    assert REAL_PROBE is not None, 'app.llm.cli.claude_builtin_tools(path) is required'
    return REAL_PROBE(path)


@pytest.fixture
def probe(monkeypatch):
    monkeypatch.setattr(cli, 'CLAUDE_TOOLS_CACHE', {}, raising=False)
    versions = {'claude.exe': '2.1.317'}
    monkeypatch.setattr(cli, 'claude_version', lambda path: versions[path])
    spawner = Spawner()
    monkeypatch.setattr(cli.subprocess, 'Popen', spawner)
    return spawner, versions


def test_probe_reads_init_tools_without_mcp_and_kills_the_process(probe):
    spawner, _ = probe
    assert run_probe('claude.exe') == ['Task', 'Bash', 'Read', 'Edit']
    started = spawner.calls[0]
    assert started['argv'][0] == 'claude.exe'
    assert {'-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'} <= set(started['argv'])
    assert not started['kwargs'].get('shell'), 'never through a shell'
    assert started['cwd_empty'], 'the probe runs in an empty temporary folder, not a project'
    process = spawner.processes[0]
    assert process.stdin.closed, 'stdin is closed so the CLI does not wait for more input'
    assert process.killed, 'the process is stopped right after init'


def test_probe_is_cached_per_path_and_version(probe):
    spawner, versions = probe
    run_probe('claude.exe')
    run_probe('claude.exe')
    assert len(spawner.calls) == 1
    versions['claude.exe'] = '2.1.318'
    run_probe('claude.exe')
    assert len(spawner.calls) == 2
    versions['other/claude.exe'] = '2.1.318'
    run_probe('other/claude.exe')
    assert len(spawner.calls) == 3


@pytest.mark.parametrize('case', ['no-init', 'no-read', 'spawn-error', 'version-error'])
def test_probe_failure_returns_none_and_is_retried_next_time(probe, monkeypatch, case):
    spawner, _ = probe
    if case == 'no-init':
        spawner.lines = [json.dumps({'type': 'assistant', 'message': {'content': []}})]
    elif case == 'no-read':
        spawner.lines = [json.dumps({**INIT, 'tools': ['Bash', 'mcp__docs__read']})]
    elif case == 'spawn-error':
        spawner.error = OSError('missing')
    else:
        def broken(path):
            raise ValueError('Claude Code 버전을 확인하지 못했습니다.')
        monkeypatch.setattr(cli, 'claude_version', broken)
    assert run_probe('claude.exe') is None
    before = len(spawner.calls)
    run_probe('claude.exe')
    if case != 'version-error':
        assert len(spawner.calls) == before + 1, 'a failure is not cached'


def test_probe_times_out_and_kills_a_silent_process(probe, monkeypatch):
    spawner, _ = probe
    monkeypatch.setattr(cli, 'CLAUDE_TOOLS_TIMEOUT', 0.5, raising=False)
    spawner.block = True
    start = time.monotonic()
    assert run_probe('claude.exe') is None
    assert time.monotonic() - start < 5
    assert spawner.processes[0].killed


def test_concurrent_first_runs_probe_once(probe):
    spawner, _ = probe
    spawner.delay = 0.3
    results = []
    threads = [threading.Thread(target=lambda: results.append(run_probe('claude.exe'))) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert len(spawner.calls) == 1
    assert results == [['Task', 'Bash', 'Read', 'Edit']] * 4


# Claude runs: task tools and the plan guide are added; Codex runs are unchanged.

@pytest.fixture
def runs(monkeypatch):
    calls = []

    async def run(self, argv, cwd, prompt='', **kwargs):
        calls.append({'argv': list(argv), 'prompt': prompt})
        if argv[0].startswith('claude'):
            return 0, '{"type":"result","subtype":"success","result":"done","session_id":"s"}', ''
        return 0, '', ''
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    monkeypatch.setattr(CliAdapter, 'parse', lambda self, stdout: AgentResult(adapter=self.client, output='done'))
    return calls


def test_claude_run_adds_task_tools_and_plan_guide(runs, monkeypatch):
    monkeypatch.setattr('app.llm.cli.claude_builtin_tools', lambda path: ['Read', 'Bash', 'Edit'])
    adapter, seen = CliAdapter('claude', 'claude.exe'), []
    adapter.on_event = lambda kind, text: seen.append((kind, text))
    asyncio.run(adapter.execute('hello', '.', 'read-only', 'saved-session'))
    argv = runs[0]['argv']
    assert argv.count('--tools') == 1
    assert set(argv[argv.index('--tools') + 1].split(',')) == {'Read', 'Bash', 'Edit'} | TASK_TOOLS
    assert argv[argv.index('--resume') + 1] == 'saved-session'
    assert '--settings' in argv
    first_line, rest = runs[0]['prompt'].split('\n', 1)
    assert first_line.startswith('프로젝트 규칙과 선택 자료를 참고하여'), 'the opening line stays first'
    assert rest.startswith(GUIDE + '\n'), 'the plan guide comes right after the opening line, before the question format'
    assert rest.index(GUIDE) < rest.index('codast-question')
    assert not [text for kind, text in seen if kind == 'warning']


def test_claude_run_without_tool_list_runs_as_before_and_warns(runs, monkeypatch):
    monkeypatch.setattr('app.llm.cli.claude_builtin_tools', lambda path: None)
    adapter, seen = CliAdapter('claude', 'claude.exe'), []
    adapter.on_event = lambda kind, text: seen.append((kind, text))
    asyncio.run(adapter.execute('hello', '.', 'read-only'))
    assert '--tools' not in runs[0]['argv']
    assert any(kind == 'warning' and '작업 계획 표시를 켜지 못했습니다' in text for kind, text in seen)
    quiet = CliAdapter('claude', 'claude.exe')
    asyncio.run(quiet.execute('hello', '.', 'read-only'))  # no listener attached: still runs


def test_codex_run_has_no_task_tools_or_plan_guide(runs, monkeypatch):
    def forbidden(path):
        raise AssertionError('Codex runs never probe Claude tools')
    monkeypatch.setattr('app.llm.cli.claude_builtin_tools', forbidden)
    asyncio.run(CliAdapter('codex', 'codex.exe').execute('hello', '.', 'read-only'))
    assert '--tools' not in runs[0]['argv']
    assert GUIDE not in runs[0]['prompt']
