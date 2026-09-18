"""Explicit agent questions, separate from native tool permission approvals."""
import json
import re
from pydantic import ValidationError
from app.models.schemas import UserQuestion

QUESTION_INSTRUCTION = """\n필수 정보가 없어 사용자 답변 없이는 진행할 수 없다면 작업을 멈추고 최종 응답 전체를 다음 형식으로 작성하세요.
```codast-question
{"question":"사용자가 답해야 할 구체적인 질문", "choices":["선택지 1", "선택지 2"]}
```
choices는 선택 사항이며 자유 입력을 허용합니다. 일반 설명이나 작업 완료 응답에는 이 형식을 사용하지 마세요.
이 형식은 대화 질문이며 도구 권한 승인이나 권한 상승을 대신하지 않습니다. 답변을 받기 전에는 답을 추정해 후속 작업을 실행하지 마세요.\n"""


def parse_question(output):
    match = re.fullmatch(r'\s*```codast-question\s*\n(.*?)\n```\s*', output, re.DOTALL)
    if not match:
        return None
    try:
        return UserQuestion.model_validate(json.loads(match[1])).model_dump()
    except (ValueError, ValidationError):
        return None  # Malformed or quoted output remains visible as ordinary output.
