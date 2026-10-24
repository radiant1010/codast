import asyncio
import json
from pathlib import Path
import sys
import tomllib

import pytest

from app.core.toolchain import Toolchain, SERENA_SOURCE
from app.llm.cli import CliAdapter
from app.llm.serena_server import navigation_factory, restricted_project_init


@pytest.fixture
def toolchain(tmp_path):
    root = tmp_path / 'codast with spaces'
    root.mkdir()
    calls = []

    class Installer:
        async def run(self, argv, cwd, **kwargs):
            calls.append(argv)
            if 'venv' in argv:
                chain.python.parent.mkdir(parents=True, exist_ok=True)
                chain.python.touch()
            if 'install' in argv:
                chain.server.touch()
            return 0, 'serena help', ''

    chain = Toolchain(root, Installer())
    return chain, calls


def test_init_installs_pinned_local_runtime_and_reuses_verified_install(toolchain):
    chain, calls = toolchain
    assert chain.status()['state'] == 'not_initialized'
    asyncio.run(chain.initialize(sys.executable))
    assert chain.status()['state'] == 'ready'
    install = next(argv for argv in calls if 'install' in argv)
    assert SERENA_SOURCE in install and '--python' in install
    assert str(chain.python) in install
    assert all('--force' not in argv for argv in calls)
    before = len(calls)
    asyncio.run(chain.initialize(sys.executable))
    assert len(calls) == before + 1  # Recheck executable, do not reinstall.


def test_failed_install_is_retryable_without_a_success_marker(toolchain):
    chain, calls = toolchain
    original = chain.runner.run

    async def fail(argv, cwd, **kwargs):
        if 'install' in argv:
            return 1, 'private output', 'private credentials'
        return await original(argv, cwd, **kwargs)

    chain.runner.run = fail
    with pytest.raises(ValueError, match='Serena') as error:
        asyncio.run(chain.initialize(sys.executable))
    assert 'private' not in str(error.value)
    assert chain.status()['state'] != 'ready'
    chain.runner.run = original
    asyncio.run(chain.initialize(sys.executable))
    assert chain.status()['state'] == 'ready'


def test_missing_server_and_invalid_marker_do_not_silently_disable_tools(toolchain):
    chain, _ = toolchain
    asyncio.run(chain.initialize(sys.executable))
    chain.server.unlink()
    assert chain.status()['state'] == 'repair_required'
    with pytest.raises(ValueError, match='init'):
        chain.configuration(Path.cwd())
    chain.marker.write_text('{broken', encoding='utf-8')
    assert chain.status()['state'] == 'repair_required'


def test_failed_runtime_verification_invalidates_marker_and_next_init_repairs(toolchain):
    chain, calls = toolchain
    asyncio.run(chain.initialize(sys.executable))
    original = chain.runner.run

    async def broken(argv, cwd, **kwargs):
        return 1, '', 'private traceback'

    chain.runner.run = broken
    with pytest.raises(ValueError):
        asyncio.run(chain.initialize(sys.executable))
    assert chain.status()['state'] == 'repair_required'
    chain.runner.run = original
    before = len(calls)
    asyncio.run(chain.initialize(sys.executable))
    installs = [argv for argv in calls[before:] if 'install' in argv]
    assert len(installs) == 1 and '--reinstall' in installs[0]
    assert chain.status()['state'] == 'ready'


def test_rechecking_ready_runtime_keeps_it_available_to_new_work(toolchain):
    chain, _ = toolchain
    asyncio.run(chain.initialize(sys.executable))
    original = chain.runner.run

    async def recheck(argv, cwd, **kwargs):
        assert chain.status()['state'] == 'ready'
        assert 'codast-serena' in chain.configuration(chain.root)
        return await original(argv, cwd, **kwargs)

    chain.runner.run = recheck
    asyncio.run(chain.initialize(sys.executable))


def test_uninitialized_configuration_preserves_existing_cli_behavior(toolchain):
    chain, _ = toolchain
    assert chain.configuration(Path.cwd()) == {}


@pytest.mark.parametrize('client', ['claude', 'codex'])
@pytest.mark.parametrize('session', [None, 'saved-session'])
def test_both_clients_receive_project_scoped_read_tools_without_permission_bypass(toolchain, monkeypatch, client, session):
    chain, _ = toolchain
    asyncio.run(chain.initialize(sys.executable))
    project = chain.root / 'spring project'
    project.mkdir()
    monkeypatch.setattr('app.core.toolchain.ROOT', chain.root)
    observed = []

    class ClientRunner:
        async def run(self, argv, cwd, prompt='', **kwargs):
            observed.append((argv, cwd, prompt))
            if client == 'claude':
                return 0, json.dumps({'type': 'result', 'result': 'done'}), ''
            return 0, '\n'.join(json.dumps(e) for e in [
                {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'done'}},
                {'type': 'turn.completed'},
            ]), ''

    result = asyncio.run(CliAdapter(client, client + '.exe', ClientRunner()).execute('{}', str(project), 'read-only', session))
    assert result.output == 'done'
    argv, cwd, prompt = observed[0]
    assert cwd == str(project)
    assert not any('bypass' in arg for arg in argv)
    assert 'Context7' in prompt and 'Serena' in prompt
    if client == 'claude':
        config = json.loads(argv[argv.index('--mcp-config') + 1])['mcpServers']
        assert argv[argv.index('--permission-mode') + 1] == 'plan'
        assert '--strict-mcp-config' not in argv
        assert 'mcp__codast-serena__find_symbol' in argv
        assert not any('mcp__codast-serena__*' == arg for arg in argv)
    else:
        settings = [argv[i+1] for i, arg in enumerate(argv) if arg == '-c']
        config = tomllib.loads('\n'.join(settings))['mcp_servers']
        assert 'sandbox_mode="read-only"' in settings
        assert argv.index('exec') > max(i for i, arg in enumerate(argv) if arg == '-c')
    assert config['codast-context7']['url'] == 'https://mcp.context7.com/mcp'
    serena = config['codast-serena']
    assert serena['command'] == str(chain.python)
    assert Path(serena['args'][0]).name == 'serena_server.py'
    assert serena['args'][serena['args'].index('--project')+1] == str(project)
    assert serena['args'][serena['args'].index('--agent-interface')+1] == 'tools'
    assert serena['args'][serena['args'].index('--enable-web-dashboard')+1] == 'false'
    context = Path(serena['args'][serena['args'].index('--context')+1]).read_text(encoding='utf-8')
    assert 'single_project: true' in context
    assert 'fixed_tools:' in context and 'find_referencing_symbols' in context
    assert 'execute_shell_command' not in context and 'replace_symbol_body' not in context
    if session:
        assert session in argv


def test_project_tool_overrides_cannot_expose_writes_or_repl():
    class Tool:
        def __init__(self, name):
            self.name = name

        def get_name(self):
            return self.name

    class Factory:
        def _iter_tools(self):
            return iter(Tool(name) for name in ('find_symbol', 'find_referencing_symbols',
                'get_symbols_overview', 'replace_symbol_body', 'execute_shell_command', 'serena_repl', 'activate_project'))

    restricted = navigation_factory(Factory)()
    assert {t.get_name() for t in restricted._iter_tools()} == {
        'find_symbol', 'find_referencing_symbols', 'get_symbols_overview'}


def test_serena_rejects_repl_only_projects_and_disables_project_commands():
    from types import SimpleNamespace

    class Factory:
        def _create_serena_agent(self, config, **kwargs):
            return config

        def _iter_tools(self):
            return iter(())

    restricted = navigation_factory(Factory)()
    config = SimpleNamespace(trusted_project_path_patterns=['**'], ignored_paths=['vendor/'])
    result = restricted._create_serena_agent(config)
    assert result.trusted_project_path_patterns == []
    assert result.ignored_paths == ['vendor/']
    with pytest.raises(ValueError, match='tools interface'):
        list(restricted._iter_tools())


def test_project_negations_cannot_override_protected_paths():
    from types import SimpleNamespace
    received = []

    def original(self, *, project_config, **kwargs):
        received.append(project_config)

    config = SimpleNamespace(ignored_paths=['!**/.harness/**'])
    restricted_project_init(original)(object(), project_config=config)
    assert received[0].ignored_paths[0] == '!**/.harness/**'
    assert received[0].ignored_paths[-5:] == ['.env', '.env.*', '.git/', '.harness/', '.codast-documents/']


def test_codex_configuration_accepts_non_bmp_paths():
    from app.core.toolchain import client_arguments
    args = client_arguments('codex', {'codast-serena': {'command': 'C:/dev/🚀/python.exe'}})
    config = tomllib.loads('\n'.join(args[i+1] for i, arg in enumerate(args) if arg == '-c'))
    assert config['mcp_servers']['codast-serena']['command'] == 'C:/dev/🚀/python.exe'
