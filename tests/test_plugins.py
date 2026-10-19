import json
import sys

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def plugins(tmp_path, monkeypatch):
    calls = []
    rows = [{'id': 'sample@catalog', 'version': '1.0', 'scope': 'user',
             'enabled': True, 'installPath': str(tmp_path/'package')}]
    package = tmp_path/'package'
    (package/'.claude-plugin').mkdir(parents=True)
    (package/'.claude-plugin/plugin.json').write_text(json.dumps({'description': 'Sample tools', 'secret': 'private'}))
    (package/'skills/review').mkdir(parents=True)
    (package/'skills/review/SKILL.md').write_text('instructions are not executed')
    (package/'.mcp.json').write_text(json.dumps({'mcpServers': {'sample-server': {'env': {'TOKEN': 'private'}}}}))
    async def run(self, argv, cwd, **kwargs):
        calls.append((argv, str(cwd)))
        if argv[1:] == ['plugin', 'list', '--json']:
            return 0, json.dumps(rows), ''
        if '--help' in argv:
            return 0, 'Usage: plugin\n--scope --json --keep-data', ''
        if argv[2] == 'disable':
            rows[0]['enabled'] = False
        elif argv[2] == 'enable':
            rows[0]['enabled'] = True
        elif argv[2] == 'uninstall':
            rows.clear()
        elif argv[2] == 'update':
            rows[0]['version'] = '1.1'
        return 0, '{}', ''
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    monkeypatch.setattr('app.llm.cli.executable', lambda *args: sys.executable)
    app = create_app(tmp_path/'workspaces')
    with TestClient(app) as client:
        client.post('/api/projects', json={'name': 'demo'})
        yield client, rows, calls, app, package


BASE = '/api/projects/demo/plugins/claude'


def test_plugin_list_uses_project_context_and_exposes_only_metadata(plugins):
    client, rows, calls, app, package = plugins
    response = client.get(BASE)
    assert response.status_code == 200
    item = response.json()['plugins'][0]
    assert item['id'] == 'sample@catalog' and item['scope'] == 'user'
    assert item['enabled'] is True and item['description'] == 'Sample tools'
    assert item['components']['skills'] == ['review']
    assert item['components']['mcp'] == ['sample-server']
    assert 'private' not in response.text and str(package) not in response.text
    assert calls[0][1] == str(app.state.harness.projects.select('demo'))


@pytest.mark.parametrize('action', ['disable', 'enable', 'update', 'remove'])
def test_plugin_mutation_uses_exact_scope_and_rechecks_native_state(plugins, action):
    client, rows, calls, app, package = plugins
    rows[0]['enabled'] = action != 'enable'
    item = client.get(BASE).json()['plugins'][0]
    response = client.post(BASE, json={'id': item['id'], 'scope': item['scope'], 'revision': item['revision'], 'action': action})
    assert response.status_code == 200
    result = response.json()
    expected = 'uninstall' if action == 'remove' else action
    command = next(args for args, _ in calls if args[2] == expected and '--help' not in args)
    assert command[3:7] == ['sample@catalog', '--scope', 'user', '--json']
    if action == 'remove':
        assert '--keep-data' in command and result['plugins'] == []
    elif action == 'update':
        assert '-y' not in command and result['plugins'][0]['version'] == '1.1'
    else:
        assert result['plugins'][0]['enabled'] is (action == 'enable')
    assert calls[-1][0][1:] == ['plugin', 'list', '--json']


def test_stale_or_unknown_plugin_cannot_change_settings(plugins):
    client, rows, calls, *_ = plugins
    item = client.get(BASE).json()['plugins'][0]
    rows[0]['version'] = '2.0'
    body = {'id': item['id'], 'scope': 'user', 'revision': item['revision'], 'action': 'disable'}
    assert client.post(BASE, json=body).status_code == 409
    body['id'] = '--all'
    assert client.post(BASE, json=body).status_code == 422
    body['id'] = 'other@catalog'
    assert client.post(BASE, json=body).status_code == 404
    assert all(args[2] == 'list' for args, _ in calls)


def test_managed_plugin_and_cross_origin_changes_are_rejected(plugins):
    client, rows, calls, *_ = plugins
    rows[0]['scope'] = 'managed'
    item = client.get(BASE).json()['plugins'][0]
    assert not any(item['actions'].values())
    body = {'id': item['id'], 'scope': item['scope'], 'revision': item['revision'], 'action': 'remove'}
    assert client.post(BASE, json=body).status_code == 403
    assert client.post(BASE, json=body, headers={'Origin': 'https://other.example'}).status_code == 403
    assert all(args[2] == 'list' for args, _ in calls)


def test_codex_list_and_remove_do_not_fake_toggle_support(plugins, monkeypatch):
    client, _, calls, *_ = plugins
    rows = [{'pluginId': 'sample@catalog', 'name': 'sample', 'marketplaceName': 'catalog',
             'version': '1.0', 'installed': True, 'enabled': True, 'installPolicy': 'AVAILABLE'}]
    async def run(self, argv, cwd, **kwargs):
        calls.append((argv, str(cwd)))
        if '--help' in argv:
            return 0, '--json', ''
        if argv[2] == 'remove':
            rows.clear()
        return 0, json.dumps({'installed': rows, 'available': []}), ''
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    endpoint = BASE.replace('claude', 'codex')
    item = client.get(endpoint).json()['plugins'][0]
    assert item['actions'] == {'enable': False, 'disable': False, 'update': False, 'remove': True}
    body = {'id': item['id'], 'scope': item['scope'], 'revision': item['revision'], 'action': 'disable'}
    assert client.post(endpoint, json=body).status_code == 403
    body['action'] = 'remove'
    assert client.post(endpoint, json=body).json()['plugins'] == []
    assert any(args[1:] == ['plugin', 'remove', 'sample@catalog', '--json'] for args, _ in calls)


@pytest.mark.parametrize('code,output', [(1, 'private token'), (0, '{}'), (0, 'not json')])
def test_failed_inventory_is_not_shown_as_an_empty_installation(plugins, monkeypatch, code, output):
    client, *_ = plugins
    async def run(*args, **kwargs):
        return code, output, 'private credentials'
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    response = client.get(BASE)
    assert response.status_code == 400
    assert 'private' not in response.text


def test_success_exit_without_changed_state_is_not_claimed_as_success(plugins, monkeypatch):
    client, rows, *_ = plugins
    async def run(self, argv, cwd, **kwargs):
        return (0, '--scope --json', '') if '--help' in argv else (0, json.dumps(rows), '')
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    item = client.get(BASE).json()['plugins'][0]
    response = client.post(BASE, json={'id': item['id'], 'scope': 'user', 'revision': item['revision'], 'action': 'disable'})
    assert response.status_code == 409
