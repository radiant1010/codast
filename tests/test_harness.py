from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import AgentResult


class RecordingAgent:
    def __init__(self): self.contexts = []
    async def run(self, context):
        self.contexts.append(context)
        return AgentResult(adapter="recording", output="done")


@pytest.fixture
def setup(tmp_path):
    agent = RecordingAgent()
    with TestClient(create_app(tmp_path / 'workspaces', agent)) as client:
        assert client.post('/api/projects', json={'name':'sample'}).status_code == 201
        yield client, tmp_path / 'workspaces/sample', agent


def test_full_flow_and_context_selection(setup):
    c, root, agent = setup
    assert c.get('/').status_code == 200
    assert c.get('/static/vendor/xterm.js').status_code == 200
    assert c.get('/api/projects').json()['projects'] == ['sample']
    assert c.get('/api/projects/sample/rules').json()['rules'][0]['path'] == 'RULES.md'
    assert c.put('/api/projects/sample/file', json={'path':'source/a.txt','content':'selected'}).status_code == 200
    (root/'source/private.txt').write_text('never send', encoding='utf-8')
    assert c.get('/api/projects/sample/file',params={'path':'source/private.txt'}).json()['content'] == 'never send'
    assert c.post('/api/projects/sample/commands',json={'text':'build'}).json()['output'] == 'done'
    assert agent.contexts[-1].files == []
    assert c.post('/api/projects/sample/commands',json={'text':'build','context_paths':['source/a.txt']}).status_code == 200
    assert [p.content for p in agent.contexts[-1].files] == ['selected']
    assert 'source/a.txt' in c.get('/api/projects/sample/files').json()['files']


def test_rule_scope_reload_and_missing(setup):
    c, root, agent = setup
    (root/'source/RULES.md').write_text('nested', encoding='utf-8')
    (root/'documents/RULES.md').write_text('unrelated', encoding='utf-8')
    c.post('/api/projects/sample/commands',json={'text':'task','cwd':'source'})
    assert [r.path for r in agent.contexts[-1].rules] == ['RULES.md','source/RULES.md']
    (root/'RULES.md').unlink()
    assert c.get('/api/projects/sample/rules').json()['rules'] == []


@pytest.mark.parametrize('path',['../escape','/outside','C:/outside','source/../../escape','.env','.env.local','.git/config','.harness/project.yaml','source/a:stream','NUL','source/CON.txt','source/trailing.'])
def test_policy_read_write_and_context(setup, path):
    c, root, agent = setup
    assert c.get('/api/projects/sample/file',params={'path':path}).status_code == 403
    assert c.put('/api/projects/sample/file',json={'path':path,'content':'x'}).status_code == 403
    assert c.post('/api/projects/sample/commands',json={'text':'task','context_paths':[path]}).status_code == 403
    assert not agent.contexts


def test_errors_and_limits(setup):
    c, root, agent = setup
    assert c.post('/api/projects',json={'name':'sample'}).status_code == 409
    assert c.post('/api/projects',json={'name':'../bad'}).status_code == 422
    assert c.get('/api/projects/missing/files').status_code == 404
    assert c.get('/api/projects/sample/file',params={'path':'missing'}).status_code == 404
    assert c.post('/api/projects/sample/commands',json={'text':' '}).status_code == 422
    (root/'large.txt').write_text('x'*66000)
    assert c.get('/api/projects/sample/file',params={'path':'large.txt'}).status_code == 400
    (root/'RULES.md').write_text('x'*33000)
    assert c.post('/api/projects/sample/commands',json={'text':'task'}).status_code == 400
    assert not agent.contexts


def test_cross_origin(setup):
    c, _, _ = setup
    assert c.post('/api/projects',json={'name':'evil'},headers={'origin':'https://evil.example'}).status_code == 403


def test_mock(tmp_path):
    with TestClient(create_app(tmp_path)) as c:
        c.post('/api/projects',json={'name':'mock'})
        result=c.post('/api/projects/mock/commands',json={'text':'hello'}).json()
        assert result['adapter'] == 'mock'
        assert 'hello' in result['output']


def test_link_guard(setup, tmp_path):
    c, root, _ = setup
    target=tmp_path/'outside.txt'; target.write_text('outside')
    try: (root/'link.txt').symlink_to(target)
    except OSError: pytest.skip('OS requires symlink privilege')
    assert c.get('/api/projects/sample/file',params={'path':'link.txt'}).status_code == 403
