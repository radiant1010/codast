from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import Command


def test_terminal_feed_survives_restart_short_runs_and_paging(tmp_path):
    root=tmp_path/'ws'
    app=create_app(root);s=app.state.harness
    s.projects.create('one');s.projects.create('two')
    ids=[]
    for project,status in [('one','completed'),('one','failed'),('two','interrupted')]:
        run=s.storage.start_run(project,Command(text='fixture',task='chat'),'mock')
        s.storage.finish_run(run,status)
        s.storage.finish_run(run,'failed',error='duplicate must not overwrite')
        ids.append(run)
    with TestClient(create_app(root)) as client:
        first=client.get('/api/notifications?limit=1').json()
        assert len(first['events'])==1 and first['has_more']
        assert first['events'][0]['status']=='completed'
        second=client.get('/api/notifications',params={'after':first['cursor']}).json()
        assert [e['run_id'] for e in first['events']+second['events']]==ids
        assert client.get('/api/notifications',params={'after':second['cursor']}).json()['events']==[]
        assert client.get('/api/notifications?after=-1').status_code==422
    assert len(s.storage.notifications(['one'])['events'])==2


def test_unknown_running_is_not_a_completion_notification(tmp_path):
    root=tmp_path/'ws';app=create_app(root);s=app.state.harness;s.projects.create('one')
    run=s.storage.start_run('one',Command(text='fixture',task='chat'),'mock')
    with TestClient(create_app(root)) as client:
        record=client.get('/api/projects/one/runs/'+run).json()
        assert record['status']=='running' and not record['cancellable']
        replay=client.get('/api/projects/one/runs/'+run+'/events').text
        assert 'event: detached' in replay and 'event: end' not in replay
        assert client.get('/api/notifications').json()['events']==[]
        assert client.post('/api/projects/one/runs/'+run+'/cancel').status_code==409
        assert client.post('/api/projects/one/runs/'+run+'/reconcile').status_code==200
        assert client.post('/api/projects/one/runs/'+run+'/reconcile').status_code==200
        events=client.get('/api/notifications').json()['events']
        assert len(events)==1 and events[0]['status']=='interrupted'
