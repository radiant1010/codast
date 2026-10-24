from app.models.schemas import AgentContext, ContextPart


class ContextBuilder:
    max_chars = 32000

    def build(self, command, rules, selected: list[ContextPart]) -> AgentContext:
        context = AgentContext(task=command.text, rules=rules, files=selected)
        size = len(context.model_dump_json())
        if size > self.max_chars:
            raise ValueError(f"Context 한도를 초과했습니다. 입력 {size:,}자, 한도 {self.max_chars:,}자입니다. "
                             "전체 전달이나 참조 포함이 필요한 자료는 자동으로 자르거나 일부를 생략하지 않습니다. "
                             "자료를 필요한 범위로 나누어 첨부하거나 선택 파일과 Rule을 줄이세요.")
        return context

