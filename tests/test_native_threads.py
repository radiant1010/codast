from pathlib import Path
import pytest
from app.core import native_threads
from app.core.storage import Storage
from app.models.schemas import Command


def test_thread_preview_scope(monkeypatch,tmp_path):
    identity='00000000-0000-4000-8000-000000000001'
    monkeypatch.setattr(native_threads,'request',lambda *args: {'thread': {'id':identity,'cwd':str(tmp_path),'turns':[{'items':[{'type':'agentMessage','text':'hello'},{'type':'reasoning','text':'hidden'}]}]}})
    result=native_threads.read_thread(tmp_path,identity)
    assert result['messages']==[{'role':'assistant','text':'hello'}]
    assert result['live_state']=='unknown'
    with pytest.raises(PermissionError):native_threads.read_thread(tmp_path/'other',identity)


def test_attach_atomic_and_preserves_existing(tmp_path):
    storage=Storage(tmp_path/'db.sqlite3')
    storage.attach_native_thread('project','imported',str(tmp_path),'native-test')
    assert storage.session('project','imported','codex',str(tmp_path),'read-only')=='native-test'
    assert len(storage.messages('project','imported',20,0))==1
    with pytest.raises(FileExistsError):storage.attach_native_thread('project','imported',str(tmp_path),'other')
    assert storage.session('project','imported','codex',str(tmp_path),'read-only')=='native-test'
    storage.start_run('project',Command(text='test',task='busy'),'mock')
    with pytest.raises(FileExistsError):storage.attach_native_thread('project','another',str(tmp_path),'another')
    assert storage.session('project','another','codex',str(tmp_path),'read-only') is None
