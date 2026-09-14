from pathlib import Path
import json
from app.guards.filesystem import confined
from app.models.schemas import ProjectCreate


class ProjectManager:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def select(self, name: str) -> Path:
        ProjectCreate(name=name)
        path = confined(self.root, name)
        if not path.is_dir():
            raise FileNotFoundError("Workspace를 찾을 수 없습니다.")
        return path

    def list(self) -> list[str]:
        result = []
        for path in self.root.iterdir():
            try:
                self.select(path.name)
                result.append(path.name)
            except (ValueError, PermissionError, FileNotFoundError):
                continue
        return sorted(result)

    def create(self, name: str) -> Path:
        ProjectCreate(name=name)
        path = confined(self.root, name)
        path.mkdir(exist_ok=False)
        for directory in (".harness", "documents", "source", "generated"):
            (path / directory).mkdir()
        (path / ".harness/project.yaml").write_text(f"name: {name}\nversion: 1\n", encoding="utf-8")
        (path / ".harness/index.json").write_text(json.dumps({"version": 1, "entries": []}), encoding="utf-8")
        (path / "RULES.md").write_text("# Project rules\n\n변경 내용을 설명하고 필요한 테스트를 작성하세요.\n", encoding="utf-8")
        return path

