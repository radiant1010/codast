from fastapi import APIRouter, Request

from app.models.schemas import StrictModel

router = APIRouter(prefix='/api/toolchain')


class InstallDefaults(StrictModel):
    pass


def paths(request):
    storage = request.app.state.harness.storage
    return {client: storage.client_path(client) for client in ('codex', 'claude')}


@router.get('')
async def listing(request: Request):
    return await request.app.state.tool_catalog.read(paths(request))


@router.post('/install')
async def install(body: InstallDefaults, request: Request):
    return await request.app.state.tool_catalog.initialize(paths(request))
