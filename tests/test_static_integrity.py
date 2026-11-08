"""Static files that index.html pins with Subresource Integrity must stay byte-exact in every checkout.

A Windows checkout with core.autocrlf=true rewrote LF to CRLF, the hash stopped matching
and the browser refused Bootstrap, so the whole UI lost its styles.
"""
import base64
import hashlib
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / 'app/web/static'
PINNED = re.findall(
    r'(?:href|src)="/static/([^"?]+)(?:\?[^"]*)?"[^>]*?\sintegrity="(sha256|sha384|sha512)-([^"]+)"',
    (ROOT / 'app/web/templates/index.html').read_text(encoding='utf-8'),
)


def test_index_pins_at_least_one_static_file():
    assert PINNED, 'the integrity pattern no longer matches index.html'


@pytest.mark.parametrize('path, algorithm, digest', PINNED)
def test_pinned_static_file_matches_its_integrity_hash(path, algorithm, digest):
    data = (STATIC / path).read_bytes()
    assert base64.b64encode(hashlib.new(algorithm, data).digest()).decode() == digest


@pytest.mark.parametrize('path', sorted({path for path, _, _ in PINNED}))
def test_git_never_converts_line_endings_of_pinned_static_files(path):
    if not shutil.which('git') or not (ROOT / '.git').exists():
        pytest.skip('not a Git checkout')
    attributes = subprocess.run(['git', 'check-attr', 'text', '--', f'app/web/static/{path}'],
                                cwd=ROOT, capture_output=True, text=True, check=True).stdout
    assert attributes.strip().endswith('text: unset'), attributes
