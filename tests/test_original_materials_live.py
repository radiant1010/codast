"""Explicitly opted-in acceptance tests: real CLI credentials and model usage."""
import asyncio
import os
import secrets

import pytest

from app.main import create_app
from app.models.schemas import Command, ProjectSettings
from tests.test_pdf_materials import pdf_bytes


pytestmark = pytest.mark.skipif(
    os.environ.get('CODAST_LIVE_CLI') != '1',
    reason='Set CODAST_LIVE_CLI=1 to call authenticated native CLIs and real models.',
)


@pytest.fixture(autouse=True)
def no_real_claude_tool_probe():
    # Override the shared mock guard only in this opted-in module: use real tool discovery.
    yield


@pytest.mark.parametrize('provider', ['codex', 'claude'])
def test_native_cli_reads_two_original_pdf_pages(tmp_path, provider):
    harness = create_app(tmp_path / 'workspace').state.harness
    harness.projects.create('synthetic')
    harness.save_settings('synthetic', ProjectSettings(timeout_seconds=180))
    codes = [secrets.token_hex(12).upper() for _ in range(2)]
    # Hex-encoded PDF strings keep the answer out of plain byte searches as well as the prompt.
    source = pdf_bytes([
        b'BT /F1 14 Tf 50 740 Td <' + code.encode().hex().encode() + b'> Tj ET'
        for code in codes
    ])
    report = harness.materials.import_file('synthetic', 'two-pages.pdf', source, mode='original')
    path, delivered = harness.materials.original('synthetic', report['id'])
    assert delivered == source
    command = Command(
        client=provider, mode='read-only', material_ids=[report['id']],
        text='Read both pages of the attached original PDF with your available tools. '
             'Return two lines: PAGE1=<exact code on page 1> and PAGE2=<exact code on page 2>. '
             'If you cannot read it, report the reason instead of guessing. '
             'Do not modify files, install software, or inspect unrelated files.',
    )
    prepared = harness.prepare('synthetic', command)
    prompt = prepared[2].model_dump_json()
    assert all(code not in prompt and code.encode() not in delivered for code in codes)
    result = asyncio.run(harness.perform('synthetic', prepared))
    for page, code in enumerate(codes, 1):
        assert f'PAGE{page}={code}' in result.output, f'{provider}: page {page} was not verified: {result.output}'
    assert path.read_bytes() == source
