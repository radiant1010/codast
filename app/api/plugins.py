from typing import Literal

from fastapi import APIRouter, Request
from pydantic import Field

from app.llm.plugins import SELECTOR
from app.models.schemas import StrictModel

router = APIRouter(prefix='/api/projects/{name}/plugins')
Client = Literal['codex', 'claude']


class PluginChange(StrictModel):
    id: str = Field(max_length=256, pattern=SELECTOR)
    scope: Literal['user', 'project', 'local', 'managed', 'cli', 'unknown']
    revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    action: Literal['enable', 'disable', 'update', 'remove']


@router.get('/{client}')
async def listing(name: str, client: Client, request: Request):
    harness = request.app.state.harness
    root = harness.projects.select(name)
    return await request.app.state.plugins.read(client, harness.storage.client_path(client), root)


@router.post('/{client}')
async def change(name: str, client: Client, body: PluginChange, request: Request):
    harness = request.app.state.harness
    root = harness.projects.select(name)
    return await request.app.state.plugins.change(client, harness.storage.client_path(client), root, body)
