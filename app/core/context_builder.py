from app.models.schemas import AgentContext, ContextPart


class ContextBuilder:
    max_chars = 32000

    def build(self, command, rules, selected: list[ContextPart]) -> AgentContext:
        context = AgentContext(task=command.text, rules=rules, files=selected)
        if len(context.model_dump_json()) > self.max_chars:
            raise ValueError("Context 한도를 초과했습니다. 선택 파일이나 Rule을 줄이세요.")
        return context

