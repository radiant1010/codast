from app.models.schemas import AgentContext, AgentResult


class CodexAgentAdapter:
    """Integration seam. Enable only after transport, auth and sandbox are specified."""
    async def run(self, context: AgentContext) -> AgentResult:
        raise NotImplementedError("Phase 1은 Mock Adapter를 사용합니다. Codex 전송 계층은 미연결입니다.")

