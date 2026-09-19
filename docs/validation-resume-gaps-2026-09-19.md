# 원본 CLI 재개·DB 복원 후 실제 재개 검증 — 2026-09-19

Codex CLI 0.155.0-alpha.9와 기존 CLI 인증을 사용해 별도 프로젝트·SQLite DB·새 네이티브 세션에서 읽기 전용 모델 요청 4회를 수행했다. 도구 사용·파일 변경은 요청하지 않았다. 기존 사용자 대화와 실행 중인 데스크톱 작업은 재개하지 않았다.

## 결과

| 검사 | 결과 |
| --- | --- |
| 하네스 종료 후 원본 CLI 직접 재개 | 하네스에서 만든 세션을 `codex exec resume <id>`로 직접 호출하여 동일 세션 ID와 첫 표식 회상 확인 |
| CLI → 하네스 복귀 | CLI에서만 전달한 두 번째 표식이 하네스 DB에 없음을 확인한 뒤, 하네스 재개에서 회상. 동일 세션 ID와 resumed=true 확인 |
| DB 백업·복원 후 실제 재개 | SQLite backup으로 스냅샷을 만들고 별도 DB로 복원. integrity_check·foreign_key_check 통과. 복원 DB의 실행에서 두 표식과 동일 네이티브 세션 확인 |
| 복원 후 중복 요청 | 백업 이전 요청을 같은 요청 ID로 재전송하여 기존 실행 ID 반환과 실행 수 불변 확인 |
| DB 분리 | 복원본의 새 실행 이후 원본 DB 실행 수 불변 확인 |

원본 CLI 호출은 하네스 실행/프롬프트 구성 경로를 거치지 않고 subprocess 기반 ProcessRunner로 수행했다. 실행 인자 구성과 JSON 결과 파싱만 기존 CliAdapter를 재사용했다. 대화 회상 요청에 검증할 표식을 다시 넣지 않았다. 하네스 API는 TestClient로 호출했으며 앱 수명 종료·재생성으로 복귀를 검증했다. 실제 서버 프로세스 재시작 검증은 [전날 기록](validation-session-continuity-2026-09-18.md)을 따른다.

제한 실행 환경의 첫 시도는 Codex 홈을 찾지 못해 모델 실행 전에 실패했다. 일반 사용자 환경에서 전체 경로가 통과했다. 인증 저장소를 복제하거나 개인 설정을 바꾸지 않았다. 원문·세션 ID·DB와 실행 스크립트는 Git 제외 `work/`에만 보관했다.

## 자동 회귀

`uv --cache-dir work/uv-cache run pytest tests/test_native_threads.py tests/test_chat_identity.py tests/test_backup_restore.py tests/test_request_recovery.py -q --basetemp work/pytest-resume-gaps-20260919 --tb=short`

결과: **16 passed**, 기존 의존성 deprecation 경고 2개. 가져온 세션 재개, 실패·취소 후 연결 해제, 채팅 ID, 백업·복원, 요청 중복 방지·재시작 복구를 검사했다. 제품 코드는 변경하지 않았다.

## 남은 범위와 한계

- Claude `auth status`는 loggedIn=false와 종료 코드 1을 반환했다. 실제 Claude 재개는 로그인 이후 검증해야 한다.
- 데스크톱에서 생성한 별도 테스트 세션의 하네스 연결·재개와 데스크톱 표시 확인은 미수행이다. CLI 출처 세션의 성공으로 대신하지 않는다. 현재 작업을 재개하거나 기존 개인 대화를 검증용으로 사용하지 않았다.
- 원본 CLI 직접 재개는 비대화형 `exec resume`이다. 터미널의 대화형 `codex resume` 화면 조작은 미검증이다.
- DB 밖의 프로젝트 경로·CLI 세션 저장소는 그대로 유지했다. 다른 머신 이전, 외부 세션 삭제·만료, 브라우저 초안 복원은 이번 검증 범위가 아니다.
- 원본 DB와 복원 DB는 같은 네이티브 세션을 가리킨다. DB 쓰기 분리는 네이티브 대화의 분기/격리를 뜻하지 않으며, 두 하네스를 동시에 실행하지 않았다.
- 실제 모델 작업 중 강제 종료·장시간 작업·권한/cwd 전환은 이번 검증에 포함하지 않는다. 실패·취소·재시작 뒤 자동 재실행하지 않는 기존 계약과 자동 검사를 유지한다.
