from typing import Protocol
from app.models.schemas import AgentContext, AgentResult


class AgentAdapter(Protocol):
    async def run(self, context: AgentContext) -> AgentResult: ...

