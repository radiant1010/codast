from typing import Literal
from pydantic import BaseModel, Field, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectCreate(StrictModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


class WorkspaceRegister(ProjectCreate):
    path: str = Field(min_length=1, max_length=4096)


class Command(StrictModel):
    text: str = Field(min_length=1, max_length=8000, pattern=r"\S")
    raw_text: str | None = Field(default=None, max_length=8000)
    cwd: str = "."
    context_paths: list[str] = Field(default_factory=list, max_length=10)
    task: str = Field(default="", max_length=120)
    client: Literal['mock', 'codex', 'claude'] = 'mock'
    mode: Literal['read-only', 'workspace-write'] = 'read-only'
    fresh: bool = False
    model: str | None = Field(default=None, min_length=1, max_length=200, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$")


class MessageCreate(StrictModel):
    text: str = Field(min_length=1, max_length=8000, pattern=r"\S")
    task: str = Field(default="", max_length=120)


class MessageMove(StrictModel):
    task: str = Field(max_length=120)


class FileWrite(StrictModel):
    path: str
    content: str = Field(max_length=65536)


class ProjectSettings(StrictModel):
    model: str | None = Field(default=None, min_length=1, max_length=200, pattern=r'^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$')
    cwd: str = Field(default=".", max_length=1024)
    context_paths: list[str] = Field(default_factory=list, max_length=10)
    client: Literal['mock', 'codex', 'claude'] = 'mock'
    mode: Literal['read-only', 'workspace-write'] = 'read-only'


class ChatRequest(Command):
    request_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r'^[a-zA-Z0-9_-]+$')
    action: Literal['note', 'run'] = 'note'
    auto_route: bool = True


class TaskUpdate(StrictModel):
    task: str = Field(min_length=1, max_length=120, pattern=r'\S')
    title: str | None = Field(default=None, min_length=1, max_length=120, pattern=r'\S')
    status: Literal['active', 'paused', 'done'] | None = None


class ChatCreate(StrictModel):
    task: str = Field(min_length=1, max_length=120, pattern=r'\S')


class ClientConfig(StrictModel):
    path: str = Field(default='', max_length=2048)


class OnboardingSelection(StrictModel):
    project: str | None = Field(default=None, pattern=r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')
    client: Literal['codex', 'claude'] | None = None
    deferred: bool = False


class RouteRequest(StrictModel):
    text: str = Field(min_length=1, max_length=8000, pattern=r'\S')


class ContextPart(BaseModel):
    path: str
    content: str


class AgentContext(BaseModel):
    task: str
    rules: list[ContextPart]
    files: list[ContextPart]
    history: list[dict] = Field(default_factory=list)


class AgentResult(BaseModel):
    adapter: str
    output: str
    run_id: str | None = None
    session_id: str | None = None
    usage: dict | None = None
    execution_model: str | None = None
