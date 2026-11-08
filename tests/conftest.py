"""Shared test guards."""
import pytest


@pytest.fixture(autouse=True)
def no_real_claude_tool_probe(monkeypatch):
    # #8: Claude runs probe the CLI for its default tool list. A real claude.exe on PATH must never be
    # started by tests that only fake the run itself; tests that need the probe call it explicitly.
    monkeypatch.setattr('app.llm.cli.claude_builtin_tools', lambda path: None, raising=False)
