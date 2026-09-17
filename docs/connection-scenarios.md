# API 연결 시나리오

사용자가 자신의 프로젝트·CLI·계정을 연결한다. 자동 점검은 등록된 설정을 확인하며 로그인, 프로젝트 선택, 설치, Docker 시작을 임의로 수행하지 않는다. 현재 개발 PC의 연결값을 소스나 배포 초기값에 넣지 않는다.

## 실행 순서와 완료 조건

### 최초 설정 API

Codex·Claude 모두 같은 진행·복원 계약을 사용한다. Claude는 `claude auth status --json`의 loggedIn을 확인하여 기존 CLI 인증이 유효하면 로그인 단계를 통과한다. Claude Desktop 로그인 유무로 CLI 인증을 추정하거나 Desktop 자격 증명을 추출하지 않는다. 미인증이면 `claude auth login` 안내 후 재확인한다. 로그인 상태와 실제 모델 호출 권한은 별개이며 실제 실행 검증은 따로 수행한다.

- `GET /api/onboarding`: 기록이 없으면 pending. 기존 진행 상태와 선택한 프로젝트·클라이언트 복원.
- `PUT /api/onboarding`: project/client/deferred 저장. 프로젝트는 기존 등록 API를 사용하며 Codex·Claude 중 사용할 하나를 선택한다. 클라이언트 선택이나 변경만으로 완료되지 않는다.
- `POST /api/onboarding/check`: 선택 CLI 설치 → 인증 상태 재검사 → 프로젝트 접근 확인. 기존 인증이 유효하면 로그인 절차 없이 completed. 다른 에이전트 미설치는 완료를 막지 않는다. 인증 해제·프로젝트 소실은 재검사 시 in_progress로 돌아간다.
- completed는 연결 설정 확인 완료이며 실제 모델 실행 성공과 별개다. 결과에 execution_state=not_verified를 유지한다. 모델 호출·로그인·로그아웃은 이 API가 자동 수행하지 않는다.
- SQLite v5의 onboarding_state 단일 행에 진행 상태만 저장한다. 인증키·계정 식별자는 저장하지 않는다. 기존 v4 데이터는 보존한다. 이번 구현은 서버 구조이며 최초 실행 안내 UI와 로그인 시작 버튼은 후속 작업이다.

기존 인증 재사용 근거: [Codex 인증 캐시와 저장소](https://developers.openai.com/codex/auth). 데스크톱 로그인 표시를 대신 읽는 것이 아니라 실제 실행할 CLI의 login status로 판정한다. 별도 CODEX_HOME 테스트도 OS 자격 증명 저장소·환경 변수까지 확인하기 전에는 완전한 인증 격리로 간주하지 않는다.

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

## 초기 설정 화면·모델 선택 연결

서버 상태가 pending/in_progress이면 연결 모달을 연다. 보류 시 자동 재표시를 멈추고 시작 도움말에서 재개한다. 에이전트 하나 선택·CLI 경로 등록·기존 인증 확인 후 프로젝트 생성·선택 및 PowerShell 로그인 명령 안내를 제공한다. 완료 후 프로젝트로 이동하며 새로고침에서 해당 프로젝트 설정을 복원한다. 입력부 모델 목록은 Codex 조회 결과를 사용하고 실행 설정 저장 시 프로젝트별 model을 보존한다. 다른 에이전트의 슬래시 명령에는 선택 모델을 전달하지 않는다. Claude 모델 목록과 브라우저 로그인 자동 시작은 후속 범위다.

검증: 전체 62 passed / 1 skipped, JS 문법 검사, 브라우저에서 Codex 기존 인증 확인·프로젝트 진입·모델 목록 표시 확인. 실제 인증정보를 지운 최초 로그인 실검증은 수행하지 않았다.

초기 설정 순서는 STEP 1 에이전트 로그인·연결 → STEP 2 프로젝트 생성·선택이다. 둘 중 하나의 에이전트 인증만 필요하며 미선택 에이전트는 검사하지 않는다. 개인의 연결 예정 장소·일정을 제품 문구에 포함하지 않는다.

## 세션 불러오기 범위

사용자 결정: 현재 프로젝트 루트와 작업 경로가 일치하는 세션만 조회·미리보기·연결한다. 전체 프로젝트 조회 옵션은 제공하지 않는다. 창에 프로젝트 이름과 범위를 표시하고 빈 결과도 현재 프로젝트 기준으로 안내한다. 서버는 목록뿐 아니라 개별 조회·연결 시에도 경로 경계를 검사한다.

## 에이전트별 연결 화면 보완 — 2026-09-17

연결 화면과 에이전트 연결 메뉴를 통합했다. Codex·Claude 버튼에 각각 설치/인증 상태를 표시하고, 선택한 에이전트의 경로·로그인 안내를 확인한다. 두 에이전트의 경로는 기존 클라이언트별 설정에 독립 저장하며, 시작할 때는 기존처럼 사용할 에이전트 하나를 선택한다.

폴더 아이콘은 `POST /api/clients/{client}/executable-picker`로 Windows OpenFileDialog를 열어 `.exe`를 선택한다. 선택 API 자체는 설정을 변경하거나 파일을 실행하지 않는다. UI는 선택 성공 후 해당 에이전트 경로를 저장하고 설치·인증을 확인하며, 취소 시 설정을 유지하고 취소 안내를 표시한다. 직접 입력한 경로는 연결 아이콘으로 저장한다. 자동 검색 아이콘은 해당 클라이언트의 경로 재정의를 지우고 다시 검색한다. 선택창은 서버가 실행되는 로컬 Windows 데스크톱에 열린다.

자동 검색은 PATH를 우선하고 Windows에서는 사용자 `.local/bin/{client}.exe`, Codex 데스크톱의 `LOCALAPPDATA/OpenAI/Codex/bin/*/codex.exe`도 확인한다. 셸 래퍼는 실행하지 않는다. 명시적으로 저장한 잘못된 경로를 임의의 다른 실행 파일로 대체하지 않으며 사용자가 자동 검색을 선택하면 해제한다. 근거는 [기존 실행 파일 검증과 후보 검색](../app/llm/cli.py), [기존 폴더 선택기의 파일 선택 확장](../app/core/folder_picker.py)이다.

검증: 브라우저에서 테스트 대역으로 양쪽 상태 전환·경로 분리·파일 선택 결과 저장·취소 안내를 확인했다. Windows 실제 파일 선택창의 클릭 조작은 미검증이며 OpenFileDialog 생성·선택/취소 API·Origin 검사·기본 위치 자동 검색은 자동 테스트로 확인한다. 실제 로컬 서버는 Codex 설치/인증 확인, Claude 설치/로그인 필요로 조회됐다. Claude의 존재하지 않는 데스크톱 앱 경로 설정을 자동 검색으로 되돌려 설치된 CLI를 찾았다. 실제 경로·인증값은 공개 문서에 남기지 않는다.
