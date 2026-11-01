from fastapi import APIRouter, Request

from app.models.schemas import WorkItemControl, WorkItemCreate, WorkItemRun, WorkItemVerification

router = APIRouter(prefix='/api/projects/{name}/work-items')


def service(request, name):
    request.app.state.harness.projects.select(name)
    return request.app.state.work_items


@router.get('')
def listing(name: str, request: Request):
    return {'items': service(request, name).list(name)}


@router.post('', status_code=201)
def create(name: str, body: WorkItemCreate, request: Request):
    return service(request, name).create(name, body)


@router.get('/{identity}')
def read(name: str, identity: str, request: Request):
    return service(request, name).read(name, identity)


@router.post('/{identity}/runs')
async def start(name: str, identity: str, body: WorkItemRun, request: Request):
    return {'run_id': service(request, name).start(name, identity, body)}


@router.post('/{identity}/verifications')
def verify(name: str, identity: str, body: WorkItemVerification, request: Request):
    return service(request, name).record_verification(name, identity, body)


@router.post('/{identity}/control')
def control(name: str, identity: str, body: WorkItemControl, request: Request):
    return service(request, name).control(name, identity, body)
