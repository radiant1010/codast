from pathlib import Path
from datetime import datetime, timezone
import json
from app.guards.filesystem import confined
from app.models.schemas import ProjectCreate


class ProjectManager:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def entry(self, name: str, *, include_deleted=False) -> Path:
        ProjectCreate(name=name)
        path = confined(self.root, name)
        if not path.is_dir():
            raise FileNotFoundError("Workspace를 찾을 수 없습니다.")
        if not include_deleted and self.deletion_marker(path).exists():
            raise FileNotFoundError('삭제된 프로젝트입니다. 휴지통에서 복원하세요.')
        return path

    def select(self, name: str, *, include_deleted=False) -> Path:
        entry = self.entry(name, include_deleted=include_deleted)
        descriptor = confined(entry, '.harness/workspace.json')
        if descriptor.exists():
            return self.validate_workspace(json.loads(descriptor.read_text(encoding='utf-8'))['path'])
        return entry

    def validate_workspace(self, value):
        path = Path(value)
        if not path.is_absolute() or path == Path(path.anchor):
            raise ValueError('드라이브 전체가 아닌 작업 폴더를 선택하세요.')
        for part in (path, *path.parents):
            if part.is_symlink() or part.is_junction():
                raise PermissionError('링크 폴더는 워크스페이스로 등록할 수 없습니다.')
        path = path.resolve()
        if not path.is_dir():
            raise FileNotFoundError('선택한 작업 폴더를 찾을 수 없습니다.')
        if path == self.root or path.is_relative_to(self.root):
            raise ValueError('앱에서 관리하는 프로젝트는 기존 프로젝트 목록에서 선택하세요.')
        if any(part.lower() in ('.git', '.harness') for part in path.parts):
            raise PermissionError('내부 관리 폴더는 워크스페이스로 등록할 수 없습니다.')
        return path

    def register(self, name, value):
        target = self.validate_workspace(value)
        for existing in self.list() + self.list(deleted=True):
            entry = self.entry(existing, include_deleted=True)
            descriptor = confined(entry, '.harness/workspace.json')
            if descriptor.exists() and Path(json.loads(descriptor.read_text(encoding='utf-8'))['path']) == target:
                raise FileExistsError(f'이미 등록한 폴더입니다: {existing}. 삭제한 프로젝트라면 휴지통에서 복원하세요.')
        ProjectCreate(name=name)
        entry = confined(self.root, name)
        entry.mkdir(exist_ok=False)
        (entry / '.harness').mkdir()
        (entry / '.harness/workspace.json').write_text(json.dumps({'path': str(target)}, ensure_ascii=False), encoding='utf-8')
        return target

    @staticmethod
    def deletion_marker(path):
        return confined(path, '.harness/deleted.json')

    def list(self, *, deleted=False) -> list[str]:
        result = []
        for path in self.root.iterdir():
            try:
                self.entry(path.name, include_deleted=True)
                if self.deletion_marker(path).exists() == deleted:
                    result.append(path.name)
            except (ValueError, PermissionError, FileNotFoundError):
                continue
        return sorted(result)

    def delete(self, name):
        path = self.entry(name)
        marker = self.deletion_marker(path)
        marker.parent.mkdir(exist_ok=True)
        marker.write_text(json.dumps({'deleted_at': datetime.now(timezone.utc).isoformat()}), encoding='utf-8')

    def restore(self, name):
        path = self.entry(name, include_deleted=True)
        self.deletion_marker(path).unlink(missing_ok=True)

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
