# API 연결 시나리오

사용자가 자신의 프로젝트·CLI·계정을 연결한다. 자동 점검은 등록된 설정을 확인하며 로그인, 프로젝트 선택, 설치, Docker 시작을 임의로 수행하지 않는다. 현재 개발 PC의 연결값을 소스나 배포 초기값에 넣지 않는다.

## 실행 순서와 완료 조건

| 단계 | API | 시나리오와 판정 |
| --- | --- | --- |
| 프로젝트 | POST /api/workspaces, GET /api/projects/{name}/workspace | 사용자가 선택한 경로 등록 → 실존·접근 경계 확인. 폴더 이동/삭제는 재연결 필요 |
| CLI | PUT /api/clients/{client}, GET /api/clients | 사용자 경로 등록 → 버전 확인 → 인증 확인. installed와 auth=ready를 구분 |
| 로그인 | GET /api/clients/{client}/login-instructions | 검증된 실행 파일의 로그인 argv 제공 → 사용자가 공식 CLI로 로그인 → GET /api/clients 재확인. 이 API 자체는 로그인 창을 시작하지 않음 |
| 일괄 진단 | POST /api/connections/check | CLI·인증·프로젝트 환경·Codex 모델/한도 조회. attention에 조치 필요 항목 반환. 모델 실행이나 설정 변경 없음 |
| 모델·한도 | GET /api/clients/codex/status | Codex 실제 목록·계정 한도 조회. 불가/부분 수집 구분. Claude 모델 목록·계정 한도 조회는 미구현 |
| 모델 전달 | POST /api/projects/{name}/chat | model 선택값을 CLI --model 인자로 전달하고 requested_model 기록. 요청 모델을 실제 실행 모델로 추정하지 않음 |
| 실행 | POST /api/projects/{name}/chat, GET .../runs/{id} | 별도 테스트 프로젝트에서 짧은 요청 → 완료 응답·usage·세션 ID 저장 확인 |
| 재개 | 같은 task/client/cwd/mode로 두 번째 요청 | 저장된 세션 재개 및 이전 표식 기억 확인. CLI 실패 시 후속 검증 중단 |
| 스트림·취소 | GET .../runs/{id}/events, POST .../runs/{id}/cancel | 순번 재수신 중복 방지와 interrupted 저장. 자동 계약 테스트로 검증 |
| 기록 복원 | GET .../messages, GET /api/session-overview | 앱 재생성 후 기존 기록·세션·집계 유지. 활성 프로세스 복원과는 구분 |
| 규칙·자료 | GET .../rules, GET .../files, GET/PUT .../file | 규칙 전달·파일 접근 경계·설정 저장 계약 유지. 실사용 파일을 검증 목적으로 수정하지 않음 |
| 환경 | GET /api/projects/{name}/environment | Git과 정확한 Compose 경로 라벨 조회. 일반 호스트 포트 자동 연결은 미구현 |

## 사용자가 확인할 예외

- CLI 미설치/잘못된 경로: 설치 또는 경로 선택.
- 로그인 필요: 해당 CLI의 공식 인증 절차. 비밀번호·토큰을 하네스에 입력하거나 복사하지 않는다.
- 로그인 확인 실패: 확인 불가로 유지한다. 설치 성공이나 인증 확인이 모델 호출 권한·잔여 한도를 보장하지 않는다.
- 프로젝트 경로 없음, Docker 엔진 연결 불가: 해당 환경을 복구하거나 선택 기능으로 미연결 유지.
- 모델·컨텍스트·한도를 수집할 수 없음: null/미수집 유지. 가짜 값·0으로 대체하지 않는다.

## 구현 근거

기존 [실행 관리자](../app/core/orchestrator.py)와 [CLI 어댑터](../app/llm/cli.py)의 실행·재개 경로를 유지한다. 새 일괄 진단은 [connections.py](../app/core/connections.py)에서 조합한다. 설치 확인과 인증 확인은 설치된 CLI 도움말 및 [Codex CLI 명령](https://developers.openai.com/codex/cli/reference), [Claude CLI 명령](https://code.claude.com/docs/en/cli-reference)을 따른다. 로그인 argv는 실행 문자열이 아닌 배열로 반환한다.

## 검증 기록 — 2026-09-16

- 전체 자동 테스트 59 passed / 1 skipped. 인증 false/true/비정상 결과, 민감 필드 제외, 진단의 무실행·무등록, 모델 인자 및 실제 Claude init 모델 해석 포함.
- UI는 이번 작업 범위에서 변경하지 않았다. attention은 API 데이터이며 팝업 알림 구현 완료를 뜻하지 않는다.
- 실제 CLI 결과는 별도 로컬 테스트 DB에서 확인하고 개인 연결값·네이티브 세션 ID·로그 원문을 이 문서에 복사하지 않는다.
- Codex 실제 첫 실행·같은 세션 재개 모두 completed, 이전 표식 기억 및 usage 저장 확인. 기존 데스크톱 대화는 사용하지 않았다.
- 현재 서버의 Codex 인증·모델 목록·계정 한도 및 프로젝트 Git 조회 성공. Claude는 인증 필요, Docker는 연결 불가, 일반 호스트 포트는 미수집으로 확인했다. 이는 해당 개발 환경의 결과이며 다른 사용자에게 기본값으로 적용하지 않는다.
- 후속 확인: 사용자가 Docker Desktop을 시작한 뒤 환경 API가 available을 반환했다. 프로젝트에 연결된 Compose 컨테이너와 공개 포트는 빈 목록이었다. 엔진 연결 성공과 프로젝트 컨테이너 존재를 별도로 판정한다.
