# CODAST 문서

프로젝트 소개와 실행 방법은 [README](../README.md)를 참고하세요.

## 기능과 구현

- [작업 오케스트레이션의 목적과 설계 근거](orchestration-design.md) — 해결할 문제, 공식 레퍼런스, 설계 판단과 평가 계획
- [오케스트레이션과 실행 하네스의 책임 경계](harness-architecture.md) — Anthropic·OpenAI 공식 설명과 현재 구현 비교

- [구현 노트](implementation-notes.md) — 주요 기술 과제와 구현·검증 근거
- [세션과 실행 동작](client-runtime.md) — 채팅, 네이티브 세션, 실행 복구와 UI 동작
- [CLI 연결 안내](connection-scenarios.md) — 설치·인증 상태 확인과 기존 세션 연결
- [첨부 자료 가드](data-guard.md) — 지원 형식, 보호 정책, 처리 한도와 검증

## 개발

- [공통 개발 가이드](development-guide.md)
- [UI 레이아웃 가이드](ui-layout-guide.md)
- [개발 계획](TODO.md)
- [에이전트 작업 지침](../AGENTS.md)

## 검증 기록

- [세션 연속성 검증 — 2026-09-18](validation-session-continuity-2026-09-18.md)
- [원본 CLI 재개·DB 복원 검증 — 2026-09-19](validation-resume-gaps-2026-09-19.md)
- [첨부 자료 가드 검증](data-guard.md#검증)

검증 기록은 작성 당시의 환경과 결과를 설명합니다. 현재 지원 범위는 관련 기능 문서에서 확인하세요.

## 이전 설계와 기록

- [초기 설계와 단계별 결정](phase1.md)
- [최초 설계 원본](codex_ai_harness_design.docx)
- [인수인계 — 2026-09-14](handoff-next-session.md)
- [이전 개발 계획 — 2026-09-14](TODO-history-2026-09-14.md)

이전 기록은 배경 참고용이며 현재 작업 순서는 [개발 계획](TODO.md)을 따릅니다.

## 문서 관리

문서는 내용이 드러나는 파일명과 상대 링크로 연결합니다. 추가하거나 이동할 때 이 목록과 관련 링크를 함께 수정합니다. 유지할 문서는 `docs/`, 로컬 산출물은 `outputs/`, 임시 파일은 `work/`에 보관합니다. 개인 설정·인증 정보·실행 DB와 원문 로그는 공개 문서에 포함하지 않습니다.
