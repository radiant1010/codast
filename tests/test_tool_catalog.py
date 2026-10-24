import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    from app.core.tool_catalog import ToolCatalog
    from app.core.toolchain import Toolchain

    calls = []
    rows = {'codex': [], 'claude': []}
    markets = {'codex': [], 'claude': []}
    fail = set()

    async def run(self, argv, cwd, **kwargs):
        client, *args = argv
        calls.append((client, args))
        if '--help' in args:
            return 0, '--json --scope', ''
        if args == ['plugin', 'list', '--json']:
            data = {'installed': rows[client]} if client == 'codex' else rows[client]
            return 0, json.dumps(data), ''
        if args == ['plugin', 'marketplace', 'list', '--json']:
            data = {'marketplaces': markets[client]} if client == 'codex' else markets[client]
            return 0, json.dumps(data), ''
        if args[:3] == ['plugin', 'marketplace', 'add']:
            repo = args[3].removeprefix('https://github.com/').removesuffix('.git')
            source = {'marketplaceSource': {'sourceType': 'git', 'source': args[3]}} if client == 'codex' else {'source': 'git', 'url': args[3]}
            markets[client].append({'name': repo.split('/')[-1], **source})
            return 0, '{}', ''
        if args[:2] in (['plugin', 'add'], ['plugin', 'install']):
            identity = args[2]
            if (client, identity) in fail:
                return 1, 'private token', 'private credentials'
            rows[client].append({'pluginId' if client == 'codex' else 'id': identity,
                                 'scope': 'user', 'enabled': True, 'version': '1.0'})
            return 0, '{}', ''
        raise AssertionError(args)

    async def probe(client, configured=''):
        return {'client': client, 'state': 'installed', 'auth': 'check_required', 'path': client}

    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    monkeypatch.setattr('app.llm.cli.executable', lambda client, configured='': client)
    monkeypatch.setattr('app.llm.cli.probe', probe)
    chain = Toolchain(tmp_path)
    app = create_app(tmp_path / 'workspaces')
    app.state.tool_catalog = ToolCatalog(app.state.plugins, chain)
    with TestClient(app) as client:
        yield client, rows, markets, calls, fail, app.state.tool_catalog


def test_defaults_install_both_clients_and_second_run_reuses_without_login(catalog):
    client, rows, markets, calls, _, service = catalog
    result = asyncio.run(service.install_plugins({}))
    assert not result
    assert all(len(items) == 2 for items in rows.values())
    mutations = [args for _, args in calls if args[:2] in (['plugin', 'add'], ['plugin', 'install']) and '--help' not in args]
    assert len(mutations) == 4
    assert all('--json' in args for args in mutations)
    assert all('--scope' in args for args in mutations if args[1] == 'install')
    calls.clear()
    assert not asyncio.run(service.install_plugins({}))
    assert all(args == ['plugin', 'list', '--json'] for _, args in calls)


def test_existing_alias_disabled_plugin_and_unrelated_plugins_are_preserved(catalog):
    _, rows, _, calls, _, service = catalog
    rows['codex'] = [
        {'pluginId': 'superpowers@openai-curated-remote', 'version': 'old', 'enabled': False},
        {'pluginId': 'ponytail@ponytail', 'version': 'old', 'enabled': True},
        {'pluginId': 'unrelated@sample', 'version': 'old', 'enabled': True},
    ]
    asyncio.run(service.install_plugins({}))
    assert all(args == ['plugin', 'list', '--json'] for c, args in calls if c == 'codex')
    assert rows['codex'][0]['enabled'] is False
    response = asyncio.run(service.read({}))
    superpowers = next(t for t in response['tools'] if t['id'] == 'superpowers')
    assert superpowers['clients']['codex']['state'] == 'disabled'
    assert response['clients']['codex']['auth'] == 'check_required'


def test_one_install_failure_is_redacted_and_does_not_stop_other_installs(catalog):
    _, rows, _, _, fail, service = catalog
    fail.add(('codex', 'superpowers@superpowers-marketplace'))
    errors = asyncio.run(service.install_plugins({}))
    assert len(errors) == 1 and 'private' not in json.dumps(errors)
    assert len(rows['claude']) == 2 and len(rows['codex']) == 1
    fail.clear()
    assert not asyncio.run(service.install_plugins({}))
    assert all(len(items) == 2 for items in rows.values())


def test_read_is_non_mutating_and_never_claims_service_authentication(catalog):
    client, rows, _, calls, _, _ = catalog
    rows['codex'] = [{'pluginId': 'github@openai-curated-remote', 'enabled': True}]
    response = client.get('/api/toolchain')
    assert response.status_code == 200
    tools = response.json()['tools']
    github = next(t for t in tools if t['id'] == 'github')
    assert github['clients']['codex']['state'] == 'installed'
    assert github['clients']['codex']['connection'] == 'not_verified'
    assert not github['default']
    assert all(args == ['plugin', 'list', '--json'] for _, args in calls)
    assert 'private' not in response.text


def test_install_endpoint_rejects_arbitrary_packages_and_foreign_origin(catalog):
    client, *_, service = catalog
    assert client.post('/api/toolchain/install', json={'source': 'untrusted/repo'}).status_code == 422
    assert client.post('/api/toolchain/install', json={}, headers={'Origin': 'https://other.example'}).status_code == 403


def test_unknown_inventory_never_triggers_blind_install(catalog, monkeypatch):
    _, _, _, calls, _, service = catalog

    async def malformed(self, path, args, cwd, timeout=25):
        calls.append((path, args))
        return '{}'

    monkeypatch.setattr(service.plugins, 'run', malformed.__get__(service.plugins))
    errors = asyncio.run(service.install_plugins({}))
    assert len(errors) == 2
    assert all(args == ['list', '--json'] for _, args in calls)


def test_conflicting_marketplace_is_never_overwritten_or_used(catalog):
    _, rows, markets, calls, _, service = catalog
    markets['claude'].append({'name': 'superpowers-marketplace', 'source': 'github', 'repo': 'untrusted/tools'})
    errors = asyncio.run(service.install_plugins({}))
    assert len(errors) == 1 and errors[0]['tool'] == 'superpowers'
    assert not any(r['id'].startswith('superpowers@') for r in rows['claude'])
    assert not any(c == 'claude' and 'obra/superpowers-marketplace' in ' '.join(args) for c, args in calls)
    assert len(rows['codex']) == 2


def test_success_exit_without_installation_is_reported_as_failure(catalog, monkeypatch):
    _, _, _, _, _, service = catalog

    async def no_install(*args):
        pass

    monkeypatch.setattr(service.plugins, 'install', no_install)
    errors = asyncio.run(service.install_plugins({}))
    assert len(errors) == 4
    assert all('등록' in error['message'] for error in errors)


def test_install_endpoint_prepares_runtime_and_both_cli_plugins(catalog, monkeypatch):
    client, _, _, _, _, service = catalog

    async def prepare(uv):
        service.chain.python.parent.mkdir(parents=True)
        service.chain.python.touch()
        service.chain.server.touch()
        from app.core.toolchain import SERENA_SOURCE
        service.chain.marker.write_text(json.dumps({'serena_source': SERENA_SOURCE}))

    monkeypatch.setattr(service.chain, 'initialize', prepare)
    monkeypatch.setattr('app.core.tool_catalog.shutil.which', lambda tool: 'uv')
    report = client.post('/api/toolchain/install', json={}).json()
    assert report['errors'] == [] and report['installing'] is False
    assert all(value['state'] in ('installed', 'configured') for tool in report['tools'] if tool['default'] for value in tool['clients'].values())
    assert report['execution'] == 'not_verified'


def test_git_auth_prompts_are_disabled_only_in_child_process(catalog, monkeypatch):
    import os
    _, _, _, _, _, service = catalog
    observed = []

    async def run(self, argv, cwd, **kwargs):
        observed.append(kwargs['env'])
        return 0, 'help', ''

    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    before = dict(os.environ)
    asyncio.run(service.plugins.run('codex', ['list', '--json'], service.chain.root))
    assert observed[0]['GIT_TERMINAL_PROMPT'] == '0' and observed[0]['GCM_INTERACTIVE'] == '0'
    assert dict(os.environ) == before


def test_other_init_process_cannot_modify_the_same_installation(catalog):
    from app.core.tool_catalog import installation_lock
    client, _, _, calls, _, service = catalog
    with installation_lock(service.chain.root):
        response = client.post('/api/toolchain/install', json={})
        assert response.status_code == 409
        assert calls == []
    with installation_lock(service.chain.root):
        pass  # Closing the first handle releases the lock, including after failure.


@pytest.mark.parametrize('source', ['ssh://git@github.com/obra/superpowers-marketplace.git', 'git@github.com:obra/superpowers-marketplace', 'https://github.com/obra/superpowers-marketplace.git'])
def test_existing_official_git_urls_are_reused(catalog, source):
    _, _, markets, _, _, service = catalog
    markets['codex'].append({'name': 'superpowers-marketplace', 'marketplaceSource': {'sourceType': 'git', 'source': source}})
    assert not asyncio.run(service.install_plugins({}))


@pytest.mark.parametrize('source_type,source', [('local', 'https://github.com/obra/superpowers-marketplace.git'),
    ('git', 'https://secret@github.com/obra/superpowers-marketplace.git'),
    ('git', 'https://github.com.evil.example/obra/superpowers-marketplace.git')])
def test_source_metadata_never_accepts_local_lookalikes_or_credentials(catalog, source_type, source):
    _, _, markets, calls, _, service = catalog
    markets['codex'].append({'name': 'superpowers-marketplace', 'marketplaceSource': {'sourceType': source_type, 'source': source}})
    errors = asyncio.run(service.install_plugins({}))
    assert len(errors) == 1
    assert 'secret' not in str(errors)
    assert not any(c == 'codex' and args[:3] == ['plugin', 'add', 'superpowers@superpowers-marketplace'] for c, args in calls)
