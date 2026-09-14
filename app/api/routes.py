from fastapi import APIRouter, Request, Query
from app.models.schemas import ChatRequest, Command, TaskUpdate, ClientConfig, RouteRequest
from app.llm.cli import probe, executable
from app.models.schemas import ProjectCreate, Command, FileWrite, AgentResult, ProjectSettings, MessageCreate, MessageMove

router = APIRouter(prefix="/api")


@router.get('/clients')
async def clients(request: Request):
    import asyncio
    s = service(request)
    return {'clients': await asyncio.gather(*(probe(client, s.storage.client_path(client)) for client in ('codex','claude')))}


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
    return s.router.route(name, body.text)


@router.post('/projects/{name}/chat')
async def chat(name: str, body: ChatRequest, request: Request):
    s = service(request)
    s.projects.select(name)
    decision = s.router.route(name, body.text) if body.auto_route and not body.task.strip() else {
        'task': body.task.strip(), 'kind': 'explicit', 'reason': '직접 선택', 'candidates': [], 'engine': 'local'}
    if body.action == 'run' and decision['kind'] == 'ambiguous':
        return {'needs_selection': True, 'routing': decision}
    if body.action == 'note':
        message_id = s.storage.add_message(name, body.text, decision['task'])
        if decision['task']:
            import re
            if re.search(r'(나중에\s*(하자|하죠|해줘)|보류(하자|해줘|로\s*(하자|해줘)))\s*[.!?]*$', body.text):
                s.storage.set_task_status(name, decision['task'], 'paused')
                decision['reason'] += ' · 보류로 기록 (실행 취소는 별도)'
        return {'id': message_id, 'routing': decision, 'action': 'note'}
    command = Command(**body.model_dump(exclude={'action','auto_route'}))
    command.task = decision['task']
    return {'run_id': s.submit(name, command), 'routing': decision, 'action': 'run'}


@router.patch('/projects/{name}/tasks')
def update_task(name: str, body: TaskUpdate, request: Request):
    s = service(request)
    s.projects.select(name)
    s.storage.update_task(name, body.task, body.title, body.status)
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
        s.storage.forget_session(name, command.get('task',''), command.get('client','mock'), str(cwd), command.get('mode','read-only'))
        s.storage.finish_run(run_id, 'interrupted', error='사용자가 프로세스 종료 확인 후 기록을 정리했습니다.')
    return {'reconciled': True}


@router.get("/projects/{name}/tasks")
def tasks(name: str, request: Request):
    s = service(request)
    s.projects.select(name)
    return {"tasks": s.storage.tasks(name)}


@router.get("/projects/{name}/messages")
def messages(name: str, request: Request, task: str | None = Query(None, max_length=120),
             limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    s = service(request)
    s.projects.select(name)
    return {"messages": s.storage.messages(name, task, limit, offset)}


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


@router.post("/projects", status_code=201)
def create(body: ProjectCreate, request: Request):
    service(request).projects.create(body.name)
    return {"name": body.name}


@router.get("/projects/{name}/rules")
def rules(name: str, request: Request, cwd: str = "."):
    s = service(request)
    return {"rules": s.rules.load(s.projects.select(name), cwd)}


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
