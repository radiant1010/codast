from app.models.schemas import AgentContext, AgentResult


class MockAgentAdapter:
    async def run(self, context: AgentContext) -> AgentResult:
        return AgentResult(adapter="mock", output=(
            "[MOCK] 명령을 수신했습니다. 실제 LLM 호출/코드 변경은 수행하지 않았습니다.\n"
            f"Task: {context.task}\n"
            f"Rules: {', '.join(p.path for p in context.rules) or '(없음)'}\n"
            f"Context files: {', '.join(p.path for p in context.files) or '(없음)'}"
        ))

