"""Browser uploads use a bounded raw body, avoiding disk-backed multipart spooling."""
import asyncio
from threading import Event
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


@router.post('/material-preparations', status_code=201)
async def prepare(name: str, request: Request, filename: str = Query(max_length=255), test_data: bool = False):
    store = service(request, name)
    content = bytearray()
    async for chunk in request.stream():
        if len(content)+len(chunk)>MAX_BYTES:
            raise ValueError('파일은 8 MiB 이하만 지원합니다.')
        content.extend(chunk)
    stopped = Event()
    def checkpoint():
        if stopped.is_set():
            raise ValueError('첨부 검사를 취소했습니다.')
    async def watch_disconnect():
        # The body is fully consumed; receive now waits for the disconnect event.
        while True:
            if (await request.receive())['type'] == 'http.disconnect':
                stopped.set()
                return
    watcher = asyncio.create_task(watch_disconnect())
    worker = asyncio.create_task(asyncio.to_thread(store.prepare, name, filename, bytes(content), test_data, checkpoint))
    try:
        prepared = await worker
        checkpoint()
        token = store.stage(name, prepared)
        asyncio.get_running_loop().call_later(60, store.discard, name, token)
        return {'token': token}
    finally:
        stopped.set()
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        if not worker.done():
            worker.cancel()


@router.post('/material-preparations/{token}/commit', status_code=201)
def commit(name: str, token: str, request: Request):
    return service(request, name).commit(name, token)


@router.delete('/material-preparations/{token}')
def discard(name: str, token: str, request: Request):
    service(request, name).discard(name, token)
    return {'cancelled': True}
