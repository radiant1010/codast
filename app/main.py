from pathlib import Path
import os
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.trustedhost import TrustedHostMiddleware
from app.api.routes import router
from app.core.orchestrator import Orchestrator
from app.core.project_manager import ProjectManager
from app.core.policy_engine import PolicyEngine
from app.tools.filesystem import FileSystemTool
from app.llm.mock import MockAgentAdapter

BASE = Path(__file__).resolve().parent


def create_app(workspace_root: Path | None = None, agent=None) -> FastAPI:
    app = FastAPI(title="AI Coding Harness — Phase 1")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"])
    app.state.harness = Orchestrator(ProjectManager(workspace_root or Path(os.getenv("HARNESS_WORKSPACES", str(BASE.parent / "workspaces")))), PolicyEngine(), FileSystemTool(), agent or MockAgentAdapter())

    @app.middleware("http")
    async def same_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method in {"POST", "PUT", "DELETE", "PATCH"} and origin and origin != str(request.base_url).rstrip("/"):
            return JSONResponse({"detail": "다른 Origin의 변경 요청은 허용하지 않습니다."}, status_code=403)
        return await call_next(request)

    async def error(request, exc):
        status = 403 if isinstance(exc, PermissionError) else 409 if isinstance(exc, FileExistsError) else 404 if isinstance(exc, FileNotFoundError) else 400
        return JSONResponse({"detail": str(exc)}, status_code=status)

    for exception in (PermissionError, FileExistsError, FileNotFoundError, ValueError, IsADirectoryError, NotADirectoryError):
        app.add_exception_handler(exception, error)
    app.include_router(router)
    app.mount("/static", StaticFiles(directory=BASE / "web/static"), name="static")
    templates = Jinja2Templates(directory=BASE / "web/templates")

    @app.get("/")
    def index(request: Request):
        return templates.TemplateResponse(request=request, name="index.html", context={})

    @app.get("/health")
    def health():
        return {"status": "ok", "adapter": type(app.state.harness.agent).__name__}

    return app


app = create_app()
