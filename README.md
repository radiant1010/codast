# AI Coding Harness

첨부 `docs/codex_ai_harness_design.docx`를 기준 설계 문서로 보존한 로컬 Phase 1 구현입니다. 현재는 Mock Agent로 Workspace → Rule → 명령 → Adapter → Browser 결과 흐름을 실행합니다. 실제 LLM 호출, 코드 생성 및 테스트 자동 실행은 아직 연결하지 않았습니다.

## 실행

Python 3.12+와 uv가 있는 환경에서 프로젝트 루트에서 실행합니다.

```powershell
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

브라우저에서 http://127.0.0.1:8000 에 접속합니다. 프로젝트를 생성하거나 선택하면 RULES.md가 표시됩니다. 명령을 입력하고 실행하면 Mock 응답이 터미널에 표시됩니다. 파일 편집기를 통해 파일을 읽고 저장할 수 있으며, 왼쪽에서 체크한 파일만 다음 명령의 Context에 추가됩니다. xterm.js 5.5.0은 라이선스와 함께 로컬 정적 파일로 포함되어 있습니다.

이 세션에서 설치한 uv를 사용하려면 다음 명령을 사용합니다.

```powershell
$env:UV_CACHE_DIR = "$PWD/work/uv-cache"
./work/bootstrap/bin/uv.exe run --frozen uvicorn app.main:app --host 127.0.0.1 --port 8000
./work/bootstrap/bin/uv.exe run --frozen pytest -q
```

서버는 Ctrl+C로 종료합니다. 이미 8000 포트에서 실행 중이면 새 서버를 중복 실행하지 않습니다.

## 테스트

```powershell
uv run --frozen pytest -q
```

API 통합 흐름, Adapter 교체, Context 선택과 크기 제한, Rule 계층/재로딩, 파일 읽기/쓰기, 경로 차단, 잘못된 입력, 동일 Origin 제한을 검증합니다. 심볼릭 링크 테스트는 OS 권한이 없으면 건너뜁니다. 브라우저 E2E 자동화 프레임워크는 도입하지 않았습니다.

## Workspace

기본 위치는 프로젝트 루트의 `workspaces/`입니다. 다른 관리 루트는 서버 시작 전에 `HARNESS_WORKSPACES` 환경 변수로 지정합니다. Browser에서 임의 절대 경로를 입력받지 않고, 관리 루트의 직접 하위 디렉터리를 선택합니다. 기존 디렉터리도 유효한 이름이면 표시되며 자동으로 파일을 덮어쓰지 않습니다.

```text
workspaces/sample-project/
  .harness/project.yaml
  .harness/index.json
  RULES.md
  documents/
  source/
  generated/
```

이름은 영문/숫자로 시작하고 영문/숫자/하이픈/밑줄로 최대 64자입니다. 작업 디렉터리 기본값은 `.`입니다. Rule은 Workspace 루트부터 작업 디렉터리까지 순서대로 로딩되며 형제 디렉터리 Rule은 포함하지 않습니다. 서로 충돌하는 Soft Rule의 의미 해석은 향후 Adapter 계약에서 정의할 수 있습니다. Rule 부재는 빈 목록이며 실행 오류가 아닙니다.

## 계층과 변경 파일

- `app/api/routes.py`: 프로젝트 생성/목록, Rule, 파일, 명령 HTTP API
- `app/core/`: ProjectManager, Orchestrator, RuleLoader, ContextBuilder, PolicyEngine
- `app/models/schemas.py`: 요청 및 Adapter 입출력 Pydantic 모델
- `app/llm/`: AgentAdapter Protocol, Mock 구현, 미연결 Codex 구현 지점
- `app/tools/filesystem.py`: UTF-8 파일 읽기/쓰기 및 목록 후보 조회
- `app/guards/filesystem.py`: 경로 정규화 및 링크/Workspace 경계 검사
- `app/parsers/`: Phase 2 Parser 확장 위치
- `app/web/`: Jinja2 페이지, 최소 JavaScript, CSS, xterm.js
- `tests/test_harness.py`: 실제 실행 가능한 pytest
- `docs/`: 원본 설계 문서, Phase 1 범위 및 의존관계 기록
- `pyproject.toml`, `uv.lock`: 의존성과 재현 가능한 환경

API → Core → Tool/Adapter 방향입니다. 객체 조합은 `create_app` 한 곳에서 수행합니다. Adapter는 AgentContext만 전달받으며 파일 경로나 Tool을 직접 전달받지 않습니다. `create_app(workspace_root=..., agent=...)`로 구현체를 교체할 수 있습니다. `CodexAgentAdapter`는 명시적으로 NotImplementedError를 발생시키며 Mock으로 조용히 대체하지 않습니다.

## 현재 제한

HTTP 요청/응답을 사용하며 WebSocket 스트리밍과 PTY/Shell은 미구현입니다. 터미널은 결과 표시이고 입력은 별도 명령 필드입니다. PII/Secret 내용 스캔, 문서 파싱, Spec 생성, Shell/Git/Browser Tool과 승인 시스템은 후속 단계입니다. `.env*`, `.git`, `.harness`, 경로 탈출과 링크는 기본 정책으로 차단합니다. 파일 읽기/쓰기 최대 64 KiB, 명시적 Context 파일 최대 10개, 직렬화된 Context 최대 32,000자입니다. 파일 저장은 기존 내용을 덮어씁니다.

로컬 단일 사용자 개발용입니다. OS sandbox가 아니며 다른 프로세스의 동시 파일 교체/하드링크 공격까지 격리하지 않습니다. 인증과 작업 큐가 없으므로 외부 네트워크 서버로 노출하지 않습니다. 실제 외부 LLM을 연결하기 전에 Phase 3 Guard 및 실행 격리 계약을 완성해야 합니다.

구현 참고: [FastAPI Templates](https://fastapi.tiangolo.com/advanced/templates/), [uv locking and syncing](https://docs.astral.sh/uv/concepts/projects/sync/).
