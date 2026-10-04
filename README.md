# CODAST

CODAST는 Codex와 Claude Code의 작업 지시, 자료, 결과와 실행 기록을 관리하는 개인용 로컬 작업 공간입니다.

## 설치와 실행

Python 3.12 이상과 uv가 필요합니다. 실제 AI 실행에는 사용할 Codex 또는 Claude Code CLI를 별도로 설치하고 인증해야 합니다.

```powershell
uv sync
uv run python start.py
```

브라우저에서 http://127.0.0.1:8765 에 접속한 뒤 사용할 CLI를 연결하고 프로젝트를 등록합니다.

## 주요 기능

- 프로젝트별 채팅, 실행 기록, 스트리밍, 취소와 초안 복원
- 첨부 자료 처리와 산출물 문서함, 결과 버전 검토와 승인
- 승인한 결과 버전을 다음 단계로 전달하는 순차 워크플로
- 같은 승인 입력으로 Codex 설계와 테스트케이스 정의를 동시에 실행하는 읽기 전용 병렬 워크플로

## 개발

```powershell
uv run python -m pytest -q
```

개발 규칙은 [AGENTS.md](AGENTS.md), 작업 요청 양식은 [작업 지시서 예시](docs/task-request-example.md)를 참고하세요.
