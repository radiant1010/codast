from fastapi import APIRouter, Query, Request

router = APIRouter(prefix='/api/projects/{name}/session-search')


@router.get('')
def search(name: str, request: Request, q: str = Query('', max_length=200), offset: int = Query(0, ge=0, le=1_000_000)):
    root = request.app.state.harness.projects.select(name)
    return request.app.state.session_search.search(name, root, q, offset)


@router.post('/refresh')
def refresh(name: str, request: Request):
    root = request.app.state.harness.projects.select(name)
    return request.app.state.session_search.refresh(name, root)


@router.get('/{key}')
def context(name: str, key: str, request: Request, offset: int | None = Query(None, ge=0, le=1_000_000)):
    root = request.app.state.harness.projects.select(name)
    return request.app.state.session_search.context(name, root, key, offset)
