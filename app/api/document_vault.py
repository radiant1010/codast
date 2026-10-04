from typing import Literal
from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix='/api/projects/{name}/document-vault')


class Connection(BaseModel):
    path: str = Field(min_length=1, max_length=2048)
    mode: Literal['create', 'connect']
    layout: Literal['direct', 'project'] = 'direct'
    expected_connection_id: str | None = None


class DocumentInput(BaseModel):
    connection_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(max_length=200_000)


class DraftInput(DocumentInput):
    expected_revision: int = Field(ge=1)


class ReviewInput(BaseModel):
    connection_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    expected_revision: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=2000)


class DecisionInput(BaseModel):
    connection_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    expected_revision: int = Field(ge=1)
    decision: Literal['approved', 'rejected']
    comment: str = Field(min_length=1, max_length=2000)


def service(request):
    return request.app.state.document_vault


@router.get('')
def settings(name: str, request: Request):
    return service(request).settings(name)


@router.put('')
def connect(name: str, body: Connection, request: Request):
    return service(request).connect(name, **body.model_dump())


@router.get('/documents')
def documents(name: str, request: Request, connection_id: str = Query(max_length=32)):
    return service(request).list(name, connection_id)


@router.post('/documents', status_code=201)
def create(name: str, body: DocumentInput, request: Request):
    return service(request).create(name, **body.model_dump())


@router.get('/documents/{identity}')
def document(name: str, identity: str, request: Request, connection_id: str = Query(max_length=32)):
    return service(request).read(name, connection_id, identity)


@router.put('/documents/{identity}')
def save(name: str, identity: str, body: DraftInput, request: Request):
    return service(request).change(name, identity=identity, action='saved', **body.model_dump())


@router.post('/documents/{identity}/reviews', status_code=201)
def submit(name: str, identity: str, body: ReviewInput, request: Request):
    return service(request).change(name, identity=identity, action='submitted', **body.model_dump())


@router.get('/documents/{identity}/reviews/{number}')
def review(name: str, identity: str, number: int, request: Request, connection_id: str = Query(max_length=32)):
    return service(request).read_review(name, connection_id, identity, number)


@router.post('/documents/{identity}/reviews/{number}/decision')
def decide(name: str, identity: str, number: int, body: DecisionInput, request: Request):
    data = body.model_dump()
    action = data.pop('decision')
    return service(request).change(name, identity=identity, number=number, action=action, **data)
