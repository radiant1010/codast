# 기준 설계와 Phase 1 결정 기록

기준은 같은 디렉터리의 `codex_ai_harness_design.docx` 원본입니다. 문서는 설계 자료이며 세션 실행 권한으로 해석하지 않습니다. 이번 사용자 요청이 단계별 범위를 정합니다.

최종 목표는 PPT/Excel/HTML/API/DB 문서의 식별자를 연결하고, 관련 정보만 중간 Spec으로 변환하여 Codex 또는 다른 LLM에 전달한 뒤 코드 구현과 검증까지 수행하는 것입니다. 결정론적인 키 매칭은 코드로 처리하고 의미 판단만 LLM에 맡깁니다.

전체 MVP는 특정 화면 ID에 대응하는 PPT 슬라이드, Excel 요구사항과 Validation을 찾아 ScreenSpec을 생성하고 Rule과 함께 전달하여 제한된 Workspace 안에서 코드 수정 및 테스트 결과를 반환하는 것입니다. Phase 1 완료를 전체 MVP 완료로 간주하지 않습니다.

## 의존관계

Browser → API → Orchestrator → ProjectManager / RuleLoader / ContextBuilder / PolicyEngine → FileSystemTool / AgentAdapter입니다. PolicyEngine은 Filesystem Guard를 사용합니다. Tool과 LLM 구현체는 서로 참조하지 않습니다. 모델은 Pydantic 공통 계약입니다. 파일 전체를 읽는 Tool은 Context 선택 책임을 갖지 않습니다.

후속 흐름은 Parser → 인덱스/Resolve → SpecBuilder → ContextBuilder → Guard → AgentAdapter, 이후 Policy가 허용한 Tool 실행과 테스트입니다. 이 조합은 Core에서 수행합니다. 현재 사용하지 않는 Excel/PPT/HTML/PDF, PII/Secret, Shell/Git/Browser 클래스와 SpecBuilder는 동작하는 것처럼 보이는 빈 구현을 만들지 않고 각 계층에 확장 위치만 예약합니다.

## 단계

1. Phase 1: FastAPI, Browser CLI, Workspace, RULES.md, Agent 호출. 현재 구현은 허용된 Mock Adapter 대안입니다.
2. Phase 2: Excel/PPT Parser, 화면/요구사항 ID Index, ScreenSpec.
3. Phase 3: 본격 Policy, 접근 제어, Secret/PII Guard. Phase 1의 파일 도구에 필요한 최소 경계 검사는 선행합니다.
4. Phase 4: Spring/Nuxt 구현, Tool Gateway, 테스트 실행.
5. Phase 5: Playwright E2E 및 화면 전이 시나리오.
6. Phase 6: 필요할 때 사용량/비용, DB, Queue, 다중 Agent.

## 이번 선택

관리 루트 하위 Workspace 선택으로 로컬 경계를 명확히 했습니다. metadata 구조는 요청 예시 그대로 유지합니다. Rule은 루트 및 작업 디렉터리의 조상 체인만 선택하며 명령마다 최신 파일을 로딩합니다. 하위 Rule까지 일괄 주입하지 않습니다. Context에 자동으로 포함되는 파일은 Rule뿐이며 일반 파일은 요청의 context_paths에 명시해야 합니다.

실제 Codex 인증·CLI 전송·sandbox를 확인하지 않은 상태에서 업무 계층에 임의 subprocess 명령을 결합하지 않았습니다. Mock은 외부 호출과 코드 변경이 없음을 Browser에 명시합니다. 실제 교체는 AgentAdapter.run 계약 구현 및 create_app 조합 변경으로 수행합니다.

설치/테스트에는 FastAPI, Pydantic, Jinja2, Uvicorn, pytest, HTTPX와 uv만 사용하며 UI는 로컬 xterm.js 및 최소 JavaScript입니다. PostgreSQL/Redis/Kafka/Vector DB/Kubernetes/LangChain/LangGraph/복잡한 다중 Agent는 도입하지 않았습니다.
