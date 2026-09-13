from pydantic import BaseModel, Field, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectCreate(StrictModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


class Command(StrictModel):
    text: str = Field(min_length=1, max_length=8000, pattern=r"\S")
    cwd: str = "."
    context_paths: list[str] = Field(default_factory=list, max_length=10)


class FileWrite(StrictModel):
    path: str
    content: str = Field(max_length=65536)


class ContextPart(BaseModel):
    path: str
    content: str


class AgentContext(BaseModel):
    task: str
    rules: list[ContextPart]
    files: list[ContextPart]


class AgentResult(BaseModel):
    adapter: str
    output: str

