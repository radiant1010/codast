from fastapi import APIRouter, Request, Query
from fastapi.responses import StreamingResponse
import asyncio
import json
from app.core.commands import parse_command
from app.models.schemas import WorkspaceRegister, RulebookSettings
from app.models.schemas import ChatRequest, ChatCreate, Command, TaskUpdate, ClientConfig, RouteRequest
from app.llm.cli import probe, executable
from app.models.schemas import ProjectCreate, Command, FileWrite, AgentResult, ProjectSettings, MessageCreate, MessageMove

router = APIRouter(prefix="/api")


@router.get('/onboarding')
def onboarding(request: Request):
    return request.app.state.onboarding.read()


from app.models.schemas import OnboardingSelection


@router.put('/onboarding')
async def select_onboarding(body: OnboardingSelection, request: Request):
    return await request.app.state.onboarding.select(body)


@router.post('/onboarding/check')
async def check_onboarding(request: Request):
    return await request.app.state.onboarding.check()


@router.get('/projects/{name}/codex-threads')
def codex_threads(name: str, request: Request, cursor: str | None = Query(None, max_length=2048)):
    from app.core.native_threads import list_threads
    s = service(request)
    return list_threads(s.projects.select(name), s.storage.client_path('codex'), cursor)


def thread_provider(client):
    from app.core import native_threads, claude_threads
    if client not in ('codex', 'claude'):
        raise ValueError('지원하지 않는 에이전트입니다.')
    return native_threads if client == 'codex' else claude_threads


@router.get('/projects/{name}/native-threads/{client}')
def native_threads(name: str, client: str, request: Request, cursor: str | None = Query(None, max_length=2048)):
    s = service(request)
    return thread_provider(client).list_threads(s.projects.select(name), s.storage.client_path(client), cursor)


@router.get('/projects/{name}/native-threads/{client}/{identity}')
def native_thread(name: str, client: str, identity: str, request: Request):
    s = service(request)
    return thread_provider(client).read_thread(s.projects.select(name), identity, s.storage.client_path(client))


@router.post('/projects/{name}/native-threads/{client}/{identity}/attach')
def attach_native_thread(name: str, client: str, identity: str, body: TaskUpdate, request: Request):
    s = service(request)
    root = s.projects.select(name)
    thread = thread_provider(client).read_thread(root, identity, s.storage.client_path(client), include_turns=False)
    task = body.task.strip()
    if not task:
        raise ValueError('채팅 이름을 입력하세요.')
    s.storage.attach_native_thread(name, task, str(root), thread['id'], client)
    return {'task': task, 'client': client, 'cwd': '.', 'mode': 'read-only'}


@router.get('/projects/{name}/codex-threads/{identity}')
def codex_thread(name: str, identity: str, request: Request):
    from app.core.native_threads import read_thread
    s = service(request)
    return read_thread(s.projects.select(name), identity, s.storage.client_path('codex'))


@router.post('/projects/{name}/codex-threads/{identity}/attach')
def attach_codex_thread(name: str, identity: str, body: TaskUpdate, request: Request):
    from app.core.native_threads import read_thread
    s = service(request)
    root = s.projects.select(name)
    thread = read_thread(root, identity, s.storage.client_path('codex'), include_turns=False)
    task = body.task.strip()
    if not task:
        raise ValueError('채팅 이름을 입력하세요.')
    s.storage.attach_native_thread(name, task, str(root), thread['id'])
    return {'task': task, 'client': 'codex', 'cwd': '.', 'mode': 'read-only'}


@router.get('/clients/codex/status')
def codex_status(request: Request):
    return request.app.state.codex_status.read(service(request).storage.client_path('codex'))


@router.get('/clients')
async def clients(request: Request):
    import asyncio
    s = service(request)
    return {'clients': await asyncio.gather(*(probe(client, s.storage.client_path(client)) for client in ('codex','claude')))}


@router.post('/connections/check')
async def connections_check(request: Request):
    from app.core.connections import check_connections
    return await check_connections(service(request), request.app.state.environment_status, request.app.state.codex_status)


@router.get('/clients/{client}/login-instructions')
def client_login_instructions(client: str, request: Request):
    from app.core.connections import login_instructions
    return login_instructions(client, service(request).storage.client_path(client))


@router.post('/clients/{client}/executable-picker')
async def pick_client_executable(client: str, request: Request):
    if client not in ('codex', 'claude'):
        raise ValueError('지원하지 않는 클라이언트입니다.')
    path = await request.app.state.folder_picker.pick(executable=True)
    # Selection alone does not change settings or execute the chosen file.
    return {'path': executable(client, path) if path else None}


@router.put('/clients/{client}')
def configure_client(client: str, body: ClientConfig, request: Request):
    if client not in ('codex','claude'):
        raise ValueError('지원하지 않는 클라이언트입니다.')
    path = executable(client, body.path) if body.path else ''
    service(request).storage.save_client_path(client, path)
    return {'client': client, 'path': path}


@router.post('/projects/{name}/route')
def route(name: str, body: RouteRequest, request: Request):
    s = service(request)
    s.projects.select(name)
    _, text = parse_command(body.text)
    return s.router.route(name, text)


@router.post('/projects/{name}/chat')
async def chat(name: str, body: ChatRequest, request: Request):
    s = service(request)
    s.projects.select(name)
    if body.chat_id:
        body = body.model_copy(update={'task': s.storage.resolve_chat(name, chat_id=body.chat_id)['task']})
    client, text = parse_command(body.text)
    if client:
        body = body.model_copy(update={'text': text, 'raw_text': body.text, 'client': client, 'action': 'run'})
    decision = s.router.route(name, body.text) if body.auto_route and not body.task.strip() else {
        'task': body.task.strip(), 'kind': 'explicit', 'reason': '직접 선택', 'candidates': [], 'engine': 'local'}
    if body.action == 'run' and decision['kind'] == 'ambiguous':
        return {'needs_selection': True, 'routing': decision}
    if body.action == 'note':
        message_id = s.storage.add_message(name, body.text, decision['task'], chat_id=body.chat_id)
        if decision['task']:
            import re
            if re.search(r'(나중에\s*(하자|하죠|해줘)|보류(하자|해줘|로\s*(하자|해줘)))\s*[.!?]*$', body.text):
                s.storage.set_task_status(name, decision['task'], 'paused')
                decision['reason'] += ' · 보류로 기록 (실행 취소는 별도)'
        return {'id': message_id, 'routing': decision, 'action': 'note'}
    command = Command(**body.model_dump(exclude={'action','auto_route','request_id'}))
    command.task = decision['task']
    return {'run_id': s.submit(name, command, body.request_id), 'routing': decision, 'action': 'run'}


@router.post('/projects/{name}/tasks', status_code=201)
def create_task(name: str, body: ChatCreate, request: Request):
    s = service(request)
    s.projects.select(name)
    return s.storage.create_task(name, body.task)


@router.patch('/projects/{name}/tasks')
def update_task(name: str, body: TaskUpdate, request: Request):
    s = service(request)
    s.projects.select(name)
    s.storage.update_task(name, body.task, body.title, body.status, pinned=body.pinned, archived=body.archived, chat_id=body.chat_id)
    return {'updated': True}


@router.get('/projects/{name}/runs/{run_id}')
def run_detail(name: str, run_id: str, request: Request):
    s = service(request)
    s.projects.select(name)
    result = s.storage.run(name, run_id)
    result['cancellable'] = run_id in s.active
    return result


@router.post('/projects/{name}/runs/{run_id}/cancel')
async def cancel_run(name: str, run_id: str, request: Request):
    s = service(request)
    s.projects.select(name)
    await s.cancel(name, run_id)
    return {'cancelled': True}


@router.get('/projects/{name}/runs/{run_id}/events')
async def run_events(name: str, run_id: str, request: Request, after: int = Query(0, ge=0)):
    s = service(request)
    s.projects.select(name)
    s.storage.run(name, run_id)
    try:
        cursor = max(after, int(request.headers.get('last-event-id', '0')))
    except ValueError as exc:
        raise ValueError('이벤트 위치가 올바르지 않습니다.') from exc
    if cursor < 0:
        raise ValueError('이벤트 위치가 올바르지 않습니다.')

    async def stream():
        nonlocal cursor
        while not await request.is_disconnected():
            # Read terminal status before events so completion cannot race the final drain.
            status = s.storage.run(name, run_id)['status']
            rows = s.storage.events(name, run_id, cursor)
            for row in rows:
                cursor = row['seq']
                yield f"id: {cursor}\nevent: run_event\ndata: {json.dumps(row, ensure_ascii=False)}\n\n"
            if len(rows) == 200:
                continue
            if status != 'running':
                yield f"event: end\ndata: {json.dumps({'status': status})}\n\n"
                return
            if run_id not in s.active:
                latest = s.storage.run(name, run_id)['status']
                if latest == 'running':
                    yield 'event: detached\ndata: {"status":"unknown"}\n\n'
                    return
                continue  # Completion raced this page; drain its terminal event next.
            yield ': heartbeat\n\n'
            await asyncio.sleep(.3)

    return StreamingResponse(stream(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@router.post('/projects/{name}/runs/{run_id}/reconcile')
def reconcile_run(name: str, run_id: str, request: Request):
    s = service(request)
    s.projects.select(name)
    record = s.storage.run(name, run_id)
    if run_id in s.active:
        raise FileExistsError('진행 중인 실행은 취소 버튼을 사용하세요.')
    if record['status'] == 'running':
        command = record['command']
        cwd = s.policy.file_path(s.projects.select(name), command.get('cwd', '.'))
        s.storage.forget_session(name, command.get('task',''), command.get('client','mock'), str(cwd), command.get('mode','read-only'), chat_id=command.get('chat_id'))
        s.storage.finish_run(run_id, 'interrupted', error='사용자가 프로세스 종료 확인 후 기록을 정리했습니다.')
    return {'reconciled': True}


@router.get("/projects/{name}/tasks")
def tasks(name: str, request: Request):
    s = service(request)
    s.projects.select(name)
    return {"tasks": s.storage.tasks(name)}


@router.get('/notifications')
def notifications(request: Request, after: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100)):
    s = service(request)
    return s.storage.notifications(s.projects.list(), after, limit)


@router.get('/session-overview')
def session_overview(request: Request):
    s = service(request)
    result = {'sessions': [], 'running': [], 'usage': []}
    for project in s.projects.list():
        overview = s.storage.session_overview(project)
        result['sessions'].extend(overview['sessions'])
        result['usage'].extend(overview['usage'])
        for row in overview['running']:
            row['cancellable'] = row['id'] in s.active
            result['running'].append(row)
    return result


@router.get("/projects/{name}/messages")
def messages(name: str, request: Request, chat_id: str | None = Query(None, pattern=r'^[a-f0-9]{32}$'), task: str | None = Query(None, max_length=120),
             limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    s = service(request)
    s.projects.select(name)
    rows = s.storage.messages(name, task, limit, offset, chat_id=chat_id)
    for row in rows:
        row['cancellable'] = row['status'] == 'running' and row['run_id'] in s.active
    return {"messages": rows}


@router.post("/projects/{name}/messages", status_code=201)
def add_message(name: str, body: MessageCreate, request: Request):
    s = service(request)
    s.projects.select(name)
    return {"id": s.storage.add_message(name, body.text, body.task)}


@router.patch("/projects/{name}/messages/{message_id}")
def move_message(name: str, message_id: str, body: MessageMove, request: Request):
    s = service(request)
    s.projects.select(name)
    s.storage.move_message(name, message_id, body.task)
    return {"id": message_id, "task": body.task.strip()}


def service(request: Request):
    return request.app.state.harness


@router.get("/projects")
def projects(request: Request):
    return {"projects": service(request).projects.list()}


@router.get('/deleted-projects')
def deleted_projects(request: Request):
    return {'projects': service(request).projects.list(deleted=True)}


@router.post('/workspace-folder')
async def pick_workspace_folder(request: Request):
    return {'path': await request.app.state.folder_picker.pick()}


@router.post('/workspaces', status_code=201)
def register_workspace(body: WorkspaceRegister, request: Request):
    s = service(request)
    with s.storage.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        path = s.projects.register(body.name, body.path)
    return {'name': body.name, 'path': str(path)}


@router.get('/projects/{name}/workspace')
def workspace_detail(name: str, request: Request):
    return {'path': str(service(request).projects.select(name))}


@router.get('/projects/{name}/environment')
async def environment_status(name: str, request: Request):
    root = service(request).projects.select(name)
    return await request.app.state.environment_status.read(root)


@router.delete('/projects/{name}')
async def delete_project(name: str, request: Request):
    s = service(request)
    s.projects.entry(name)
    # Serialize against run registration. Files and all DB history stay intact.
    with s.storage.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (name,)).fetchone():
            raise FileExistsError('실행 중이거나 종료 확인이 필요한 작업이 있습니다. 중지·종료 확인 후 삭제하세요.')
        s.projects.delete(name)
    return {'deleted': True, 'recoverable': True}


@router.post('/deleted-projects/{name}/restore')
async def restore_project(name: str, request: Request):
    service(request).projects.restore(name)
    return {'restored': True, 'name': name}


@router.post("/projects", status_code=201)
def create(body: ProjectCreate, request: Request):
    service(request).projects.create(body.name)
    return {"name": body.name}


@router.get("/projects/{name}/rules")
def rules(name: str, request: Request, cwd: str = "."):
    s = service(request)
    return s.rulebook(name, cwd)


@router.get("/projects/{name}/settings", response_model=ProjectSettings)
def settings(name: str, request: Request):
    return service(request).settings(name)


@router.put("/projects/{name}/settings", response_model=ProjectSettings)
def save_settings(name: str, body: ProjectSettings, request: Request):
    return service(request).save_settings(name, body)


@router.get("/projects/{name}/runs")
def runs(name: str, request: Request, limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    s = service(request)
    s.projects.select(name)
    return {"runs": s.storage.runs(name, limit, offset)}


@router.get("/projects/{name}/files")
def files(name: str, request: Request):
    return {"files": service(request).list_files(name)}


@router.get("/projects/{name}/file")
def read(name: str, path: str, request: Request):
    return {"path": path, "content": service(request).read_file(name, path)}


@router.put("/projects/{name}/file")
def write(name: str, body: FileWrite, request: Request):
    service(request).write_file(name, body.path, body.content)
    return {"path": body.path, "saved": True}


@router.post("/projects/{name}/commands", response_model=AgentResult)
async def command(name: str, body: Command, request: Request):
    return await service(request).execute(name, body)


@router.put('/projects/{name}/rules')
def save_rules(name: str, body: RulebookSettings, request: Request):
    return service(request).save_rulebook(name, body)
