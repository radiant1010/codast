from typing import Literal
from pydantic import BaseModel, Field, ConfigDict, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectCreate(StrictModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


class WorkspaceRegister(ProjectCreate):
    path: str = Field(min_length=1, max_length=4096)


class Command(StrictModel):
    chat_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')
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
    chat_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')
    task: str = Field(min_length=1, max_length=120, pattern=r'\S')
    title: str | None = Field(default=None, min_length=1, max_length=120, pattern=r'\S')
    status: Literal['active', 'paused', 'done'] | None = None
    pinned: bool | None = None
    archived: bool | None = None


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


class RulebookEntry(StrictModel):
    trashed: bool = False
    id: str = Field(min_length=1, max_length=64, pattern=r'^[a-zA-Z0-9_-]+$')
    name: str = Field(min_length=1, max_length=80, pattern=r'\S')
    folder: str = Field(default='', max_length=242)
    enabled: bool = True
    content: str | None = Field(default=None, max_length=24000)


class RulebookSettings(StrictModel):
    enabled: bool = True
    include_project_rules: bool = True
    content: str | None = Field(default=None, max_length=24000)
    folders: list[str] = Field(default_factory=list, max_length=40)
    books: list[RulebookEntry] | None = Field(default=None, max_length=40)

    @model_validator(mode='after')
    def validate_library(self):
        if any(not f.strip() for f in self.folders) or len(set(self.folders))!=len(self.folders):
            raise ValueError('폴더 이름은 비어 있거나 중복될 수 없습니다.')
        for folder in self.folders:
            parts = folder.split('/')
            if len(parts)>3 or any(not part.strip() or part!=part.strip() or len(part)>80 or part in ('.','..') or '\\' in part for part in parts):
                raise ValueError('폴더는 이름당 80자, 최대 3단계까지 허용합니다.')
            if len(parts)>1 and '/'.join(parts[:-1]) not in self.folders:
                raise ValueError('상위 폴더를 찾을 수 없습니다.')
        if self.books is not None:
            if len({b.id for b in self.books})!=len(self.books):
                raise ValueError('룰북 ID가 중복되었습니다.')
            if any(b.folder and b.folder not in self.folders for b in self.books):
                raise ValueError('룰북 폴더를 찾을 수 없습니다.')
        return self


class UserQuestion(StrictModel):
    question: str = Field(min_length=1, max_length=2000, pattern=r'\S')
    choices: list[str] = Field(default_factory=list, max_length=5)

    @model_validator(mode='after')
    def valid_choices(self):
        if any(not value.strip() or len(value)>200 for value in self.choices):
            raise ValueError('선택지는 1~200자로 입력하세요.')
        return self


class QuestionReply(StrictModel):
    answer: str = Field(min_length=1, max_length=4000, pattern=r'\S')
    request_id: str = Field(min_length=1, max_length=128, pattern=r'^[a-zA-Z0-9_-]+$')
