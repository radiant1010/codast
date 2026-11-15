import asyncio
import json
import sys

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import Command
from app.llm.cli import CliAdapter
from tests.test_pdf_materials import pdf_bytes, TABLE


def test_original_api_scope_restart_download_and_legacy(tmp_path):
    app = create_app(tmp_path / 'ws')
    base = '/api/projects/one'
    source = pdf_bytes([TABLE])
    with TestClient(app) as client:
        for name in ('one', 'two'):
            client.post('/api/projects', json={'name': name})
        response = client.post(base+'/material-preparations?filename=private.pdf&mode=original', content=source)
        assert response.status_code == 201, response.text
        assert not client.get(base+'/materials').json()['materials']
        token = response.json()['token']
        assert client.post('/api/projects/two/material-preparations/'+token+'/commit').status_code == 404
        report = client.post(base+'/material-preparations/'+token+'/commit').json()
        identity = report['id']
        endpoint = base+'/materials/'+identity
        preview = client.get(endpoint).json()
        assert preview == {'mode': 'original', 'content': ''}
        download = client.get(endpoint+'/original')
        assert download.content == source
        assert download.headers['cache-control'] == 'no-store'
        assert download.headers['x-content-type-options'] == 'nosniff'
        assert 'private' not in download.headers['content-disposition']
        for method, suffix in [('get',''), ('get','/original'), ('delete','')]:
            assert getattr(client, method)('/api/projects/two/materials/'+identity+suffix).status_code == 404
        assert client.post(base+'/materials?filename=x.txt&mode=bad', content=b'hi').status_code == 422
        legacy = client.post(base+'/materials?filename=x.txt', content=b'password=dummy-private').json()
        assert client.get(base+'/materials/'+legacy['id']+'/original').status_code == 400
        assert 'dummy-private' not in client.get(base+'/materials/'+legacy['id']).text
    with TestClient(create_app(tmp_path/'ws')) as client:
        assert client.get(endpoint+'/original').content == source
        assert client.delete(endpoint).status_code == 200
        assert client.get(endpoint+'/original').status_code == 404


@pytest.mark.parametrize('provider', ['codex', 'claude'])
def test_both_adapters_receive_manifest_and_read_original_pdf(tmp_path, monkeypatch, provider):
    app = create_app(tmp_path/'ws'); harness = app.state.harness
    harness.projects.create('one')
    report = harness.materials.import_file('one', 'sample.pdf', pdf_bytes([TABLE]), mode='original')
    monkeypatch.setattr('app.core.orchestrator.executable', lambda *args: sys.executable)
    monkeypatch.setattr('app.llm.cli.claude_builtin_tools', lambda *args: ['Read'])
    observed = []
    async def run(runner, argv, cwd, prompt, **options):
        # Exercise the native boundary contract and the real PDF bytes. This is not a live model test.
        from pdfminer.high_level import extract_text
        path = harness.materials.original('one', report['id'])[0]
        assert 'Sample Person' not in prompt and 'base64' not in prompt
        assert str(path).replace('\\', '\\\\') in prompt
        assert 'Sample Person' in extract_text(path)
        observed.append(argv)
        if provider == 'codex':
            return 0, json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'read synthetic PDF'}}), ''
        return 0, json.dumps({'type':'result','subtype':'success','result':'read synthetic PDF'}), ''
    monkeypatch.setattr('app.llm.cli.ProcessRunner.run', run)
    result = asyncio.run(harness.execute('one', Command(text='Read the file', client=provider, material_ids=[report['id']])))
    assert 'read synthetic PDF' in result.output
    assert '--add-dir' not in observed[0] and '--dangerously-skip-permissions' not in observed[0]
    if provider == 'claude':
        assert observed[0][observed[0].index('--permission-mode')+1] == 'plan'
        assert '--allowedTools' in observed[0]
    else:
        assert 'sandbox_mode="read-only"' in observed[0]


def test_deleted_after_prepare_fails_before_dispatch(tmp_path):
    harness = create_app(tmp_path/'ws').state.harness; harness.projects.create('one')
    report = harness.materials.import_file('one', 'sample.txt', b'hello', mode='original')
    prepared = harness.prepare('one', Command(text='read', material_ids=[report['id']]))
    path, _ = harness.materials.original('one', report['id'])
    harness.materials.delete('one', report['id'])
    with pytest.raises(FileNotFoundError):
        asyncio.run(harness.perform('one', prepared))
    assert harness.storage.run('one', prepared[0])['status'] == 'failed'
    assert not path.exists()


@pytest.mark.parametrize('mode', ['read-only', 'workspace-write'])
def test_original_read_allowlist_does_not_grant_directory_or_write_access(mode):
    adapter = CliAdapter('claude', 'unused')
    adapter.original_paths = [str(__import__('pathlib').Path('/attachments/project/file[1].pdf').absolute()),
                              str(__import__('pathlib').Path('/attachments/project/second.pdf').absolute())]
    argv = adapter.arguments(mode)
    rules = [item for item in argv if item.startswith('Read(')]
    assert len(rules) == 2 and all('**' not in rule for rule in rules)
    assert '\\[1\\]' in rules[0]
    assert not any(item.startswith(('Edit(', 'Write(')) for item in argv)
    assert '--add-dir' not in argv
