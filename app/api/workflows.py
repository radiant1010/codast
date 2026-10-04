from typing import Literal
from fastapi import APIRouter, Request, Query
from fastapi.responses import Response
from pydantic import Field
from app.models.schemas import StrictModel

router = APIRouter(prefix='/api/projects/{name}/workflows')


class Step(StrictModel):
    title: str = Field(min_length=1, max_length=120, pattern=r'\S')
    instruction: str = Field(min_length=1, max_length=4000, pattern=r'\S')
    client: Literal['codex', 'claude']
    mode: Literal['read-only', 'workspace-write'] = 'read-only'
    model: str | None = Field(default=None, min_length=1, max_length=200, pattern=r'^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$')


class Material(StrictModel):
    id: str = Field(pattern=r'^[a-f0-9]{32}$')
    role: Literal['요구사항', '화면', '테스트 케이스', '기타 파일']


class Create(StrictModel):
    connection_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    title: str = Field(min_length=1, max_length=120, pattern=r'\S')
    steps: list[Step] = Field(min_length=1, max_length=8)
    materials: list[Material] = Field(default_factory=list, max_length=10)


class Change(StrictModel):
    connection_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    expected_revision: int = Field(ge=1)
    action: Literal['approve', 'run']
    instruction: str = Field(default='', max_length=4000)
    comment: str = Field(default='', max_length=2000)
    client: Literal['codex', 'claude'] = 'codex'
    mode: Literal['read-only', 'workspace-write'] = 'read-only'
    model: str | None = Field(default=None, min_length=1, max_length=200, pattern=r'^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$')


@router.get('')
def listing(name: str, request: Request, connection_id: str = Query(max_length=32)):
    return request.app.state.workflows.list(name, connection_id)


@router.post('', status_code=201)
def create(name: str, body: Create, request: Request):
    return request.app.state.workflows.create(name, **body.model_dump())


class ApprovedSource(StrictModel):
    kind: Literal['document', 'workflow']
    identity: str = Field(pattern=r'^(CDS-DOC-[0-9]{3,}|CDS-WF-[a-f0-9]{32})$')
    version: int = Field(ge=1, le=100)
    expected_revision: int = Field(ge=1)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    step: int | None = Field(default=None, ge=0, le=7)


class ParallelCreate(StrictModel):
    connection_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    title: str = Field(min_length=1, max_length=120, pattern=r'\S')
    source: ApprovedSource


class ParallelChange(StrictModel):
    connection_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    expected_revision: int = Field(ge=1)
    action: Literal['start', 'retry', 'approve']
    role: int | None = Field(default=None, ge=0, le=1)
    comment: str = Field(default='', max_length=2000)


@router.post('/parallel', status_code=201)
def parallel_create(name: str, body: ParallelCreate, request: Request):
    return request.app.state.workflows.parallel.create(name, **body.model_dump())


@router.post('/{identity}/parallel')
async def parallel_change(name: str, identity: str, body: ParallelChange, request: Request):
    return request.app.state.workflows.parallel.change(name, identity=identity, **body.model_dump())


@router.get('/{identity}')
def read(name: str, identity: str, request: Request, connection_id: str = Query(max_length=32)):
    return request.app.state.workflows.read(name, connection_id, identity)


@router.get('/{identity}/export')
def export(name: str, identity: str, request: Request, connection_id: str = Query(max_length=32)):
    content = request.app.state.workflows.export(name, connection_id, identity)
    return Response(content, media_type='application/zip', headers={
        'Content-Disposition': 'attachment; filename="workflow-results.zip"'})


@router.post('/{identity}')
async def change(name: str, identity: str, body: Change, request: Request):
    if body.action == 'run' and not body.instruction.strip():
        raise ValueError('작업 지시를 입력하세요.')
    return request.app.state.workflows.change(name, identity=identity, **body.model_dump())
