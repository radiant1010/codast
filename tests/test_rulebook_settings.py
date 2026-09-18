from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import Command, RulebookSettings


def test_rulebook_edit_disable_restart_and_project_isolation(tmp_path):
    root = tmp_path / 'ws'
    app = create_app(root)
    with TestClient(app) as client:
        for name in ('one', 'two'):
            client.post('/api/projects', json={'name': name})
        initial = client.get('/api/projects/one/rules').json()
        assert initial['default_content'] and initial['settings']['enabled']
        custom = {'enabled': True, 'include_project_rules': False, 'content': 'Use short answers.'}
        assert client.put('/api/projects/one/rules', json=custom).status_code == 200
        assert client.get('/api/projects/two/rules').json()['settings']['content'] is None
        prepared = app.state.harness.prepare('one', Command(text='test', task='test'))
        assert [r.content for r in prepared[2].rules] == ['Use short answers.']
        app.state.harness.storage.finish_run(prepared[0], 'completed')
    with TestClient(create_app(root)) as client:
        assert all(client.get('/api/projects/one/rules').json()['settings'][key] == value for key,value in custom.items())
        custom['enabled'] = False
        client.put('/api/projects/one/rules', json=custom)
        assert client.get('/api/projects/one/rules').json()['rules'] == []
        assert client.put('/api/projects/one/rules', json={**custom, 'content': 'x'*24001}).status_code == 422


def test_file_rules_can_be_disabled_independently(tmp_path):
    app = create_app(tmp_path / 'ws')
    service = app.state.harness
    with TestClient(app) as client:
        client.post('/api/projects', json={'name':'one'})
        project = service.projects.select('one')
        (project / 'RULES.md').write_text('Project rule', encoding='utf-8')
        rules = service.rules.load(project, preferences=RulebookSettings(enabled=False))
        assert [r.content for r in rules] == ['Project rule']
        assert service.rules.load(project, preferences=RulebookSettings(enabled=False, include_project_rules=False)) == []


def test_multiple_rulebooks_folders_and_validation(tmp_path):
    root = tmp_path / 'ws'
    app = create_app(root)
    with TestClient(app) as client:
        client.post('/api/projects', json={'name':'one'})
        library = {'include_project_rules':False, 'folders':['Development'], 'books':[
            {'id':'base','name':'Base','folder':'','enabled':True,'content':'Base instruction'},
            {'id':'ui','name':'UI','folder':'Development','enabled':True,'content':'UI instruction'},
            {'id':'off','name':'Off','folder':'Development','enabled':False,'content':'Do not include'}]}
        assert client.put('/api/projects/one/rules',json=library).status_code == 200
        prepared = app.state.harness.prepare('one',Command(text='test',task='test'))
        assert [r.content for r in prepared[2].rules] == ['Base instruction','UI instruction']
        app.state.harness.storage.finish_run(prepared[0],'completed')
        invalid = {**library,'folders':[]}
        assert client.put('/api/projects/one/rules',json=invalid).status_code == 422
        assert client.put('/api/projects/one/rules',json={**library,'books':[library['books'][0]]*2}).status_code == 422
    with TestClient(create_app(root)) as client:
        assert client.get('/api/projects/one/rules').json()['settings']['books'] == [{**b,'trashed':False} for b in library['books']]
        assert client.put('/api/projects/one/rules',json={'books':[],'include_project_rules':False}).status_code == 200
        assert client.get('/api/projects/one/rules').json()['rules'] == []


def test_folder_depth_and_parent_validation():
    import pytest
    from pydantic import ValidationError
    folders = ['Index','Index/UI','Index/UI/CSS']
    assert RulebookSettings(folders=folders).folders == folders
    for invalid in [folders+['Index/UI/CSS/Too deep'], ['Index/UI'], ['Index','Index/'], ['Index','Index/../CSS']]:
        with pytest.raises(ValidationError):
            RulebookSettings(folders=invalid)


def test_managed_library_requires_explicit_file_import(tmp_path):
    app = create_app(tmp_path/'ws')
    service = app.state.harness
    with TestClient(app) as client:
        client.post('/api/projects',json={'name':'one'})
        root = service.projects.select('one')
        (root/'RULES.md').write_text('Do not auto attach',encoding='utf-8')
        settings = RulebookSettings(books=[],include_project_rules=True)
        assert service.rules.load(root,preferences=settings) == []
        settings = RulebookSettings(books=[{'id':'imported','name':'RULES.md','enabled':True,'content':'Imported copy'}])
        assert [r.content for r in service.rules.load(root,preferences=settings)] == ['Imported copy']


def test_trashed_rules_persist_and_are_never_applied(tmp_path):
    root=tmp_path/'ws'
    with TestClient(create_app(root)) as client:
        client.post('/api/projects',json={'name':'one'})
        book={'id':'saved','name':'Saved','content':'Keep me','enabled':True,'trashed':True}
        assert client.put('/api/projects/one/rules',json={'books':[book]}).status_code==200
        assert client.get('/api/projects/one/rules').json()['rules']==[]
    with TestClient(create_app(root)) as client:
        saved=client.get('/api/projects/one/rules').json()['settings']['books'][0]
        assert saved['trashed'] and saved['content']=='Keep me'
        saved.update(trashed=False,enabled=False)
        client.put('/api/projects/one/rules',json={'books':[saved]})
        assert client.get('/api/projects/one/rules').json()['rules']==[]
        saved['enabled']=True
        client.put('/api/projects/one/rules',json={'books':[saved]})
        assert client.get('/api/projects/one/rules').json()['rules'][0]['content']=='Keep me'
