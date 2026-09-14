from pathlib import Path
import os


class FileSystemTool:
    """Receives already authorized paths from Core; never calls LLMs."""
    max_bytes = 65536

    def read(self, path: Path) -> str:
        with path.open("rb") as stream:
            data = stream.read(self.max_bytes + 1)
        if len(data) > self.max_bytes:
            raise ValueError("파일 크기 제한은 64 KiB입니다.")
        return data.decode("utf-8")

    def write(self, path: Path, content: str) -> None:
        if len(content.encode("utf-8")) > self.max_bytes:
            raise ValueError("파일 크기 제한은 64 KiB입니다.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def list_candidates(self, root: Path):
        ignored = {'.git', '.harness', '.venv', 'node_modules', '__pycache__', '.pytest_cache'}
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d.lower() not in ignored and not (Path(directory)/d).is_symlink() and not (Path(directory)/d).is_junction())
            for name in sorted(files):
                yield (Path(directory) / name).relative_to(root).as_posix()
