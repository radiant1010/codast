from pathlib import Path
from app.guards.filesystem import confined


class PolicyEngine:
    """Hard rules; RULES.md cannot override these checks."""

    def file_path(self, root: Path, relative: str, *, write: bool = False) -> Path:
        path = confined(root, relative)
        parts = [p.lower() for p in path.relative_to(root.resolve()).parts]
        if any(p in {".git", ".harness"} or p == ".env" or p.startswith(".env.") for p in parts):
            raise PermissionError("보호된 파일 또는 디렉터리입니다.")
        return path

