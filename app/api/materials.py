"""Browser uploads use a bounded raw body, avoiding disk-backed multipart spooling."""
import asyncio
from fastapi import APIRouter, Request, Query
from app.core.data_guard import GuardOptions
from app.core.material_extract import MAX_BYTES

router = APIRouter(prefix='/api/projects/{name}')


def service(request, name):
    harness = request.app.state.harness
    harness.projects.select(name)
    return harness.materials


@router.get('/guard')
def options(name: str, request: Request):
    return service(request,name).options(name)


@router.put('/guard')
def configure(name: str, body: GuardOptions, request: Request):
    return service(request,name).configure(name,body)


@router.get('/materials')
def materials(name: str, request: Request):
    return {'materials':service(request,name).list(name)}


@router.post('/materials', status_code=201)
async def upload(name: str, request: Request, filename: str = Query(max_length=255), test_data: bool = False):
    store = service(request,name)
    content = bytearray()
    async for chunk in request.stream():
        if len(content)+len(chunk)>MAX_BYTES: raise ValueError('파일은 8 MiB 이하만 지원합니다.')
        content.extend(chunk)
    return await asyncio.to_thread(store.import_file,name,filename,bytes(content),test_data)


@router.get('/materials/{identity}')
def preview(name: str, identity: str, request: Request):
    return {'content':service(request,name).read(name,identity)['content']}


@router.delete('/materials/{identity}')
def delete(name: str, identity: str, request: Request):
    service(request,name).delete(name,identity)
    return {'deleted':True}
