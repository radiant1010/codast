from fastapi import APIRouter, Request
from app.models.schemas import ProjectCreate, Command, FileWrite, AgentResult

router = APIRouter(prefix="/api")


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

