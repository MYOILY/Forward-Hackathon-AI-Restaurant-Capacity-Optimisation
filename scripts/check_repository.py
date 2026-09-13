"""Check documentation links and that the submitted source is self-contained."""

from __future__ import annotations

from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = ("processor", "service", "evaluator", "shared", "web", "tests", "scripts")


def check_repository(root: Path = ROOT) -> list[str]:
    errors = []
    documents = [root / "README.md", *sorted((root / "docs").glob("*.md"))]
    required = {
        "SETUP.md",
        "BEHAVIOR.md",
        "ARCHITECTURE.md",
        "REFERENCE.md",
        "DEPLOYMENT.md",
        "VALIDATION.md",
    }
    actual = {path.name for path in (root / "docs").glob("*.md")}
    if actual != required:
        errors.append("docs/ must contain exactly the six current guides")
    for document in documents:
        if not document.is_file():
            errors.append(f"Missing document: {document.relative_to(root)}")
            continue
        content = re.sub(r"```.*?```", "", document.read_text(), flags=re.S)
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", content):
            target = target.strip().split(' "', 1)[0].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            resolved = (document.parent / unquote(parsed.path)).resolve()
            if not resolved.is_relative_to(root) or not resolved.exists():
                errors.append(
                    f"Broken or external local link in {document.relative_to(root)}: {target}"
                )
    forbidden_imports = re.compile(
        r"(?:pipeline|geometry|evaluate)_v[12]\b|engine-v[12]\b|CalibrationEditorV[12]\b"
    )
    old_project = "restaurant-" + "occupancy-mvp"
    for folder in SOURCE_DIRS:
        for path in (root / folder).rglob("*"):
            if path.is_symlink() and not path.resolve().is_relative_to(root):
                errors.append(f"External source symlink: {path.relative_to(root)}")
            if (
                path.suffix not in {".py", ".ts", ".tsx", ".mjs", ".json", ".html"}
                or "__pycache__" in path.parts
            ):
                continue
            content = path.read_text()
            if "/" + "Users/" in content or old_project in content:
                errors.append(
                    f"Original-project or machine-specific path in {path.relative_to(root)}"
                )
            if folder in {
                "processor",
                "service",
                "evaluator",
                "web",
            } and forbidden_imports.search(content):
                errors.append(
                    f"Legacy implementation reference in {path.relative_to(root)}"
                )
    for name in ("videos", "mappings"):
        folder = root / "examples" / name
        if not folder.is_dir() or {path.name for path in folder.iterdir()} != {
            ".gitkeep"
        }:
            errors.append(
                f"examples/{name} must contain only .gitkeep for a clean submission"
            )
    public = root / "web" / "public"
    if public.exists() and any(public.iterdir()):
        errors.append("web/public must not contain sample bundles or recordings")
    return errors


if __name__ == "__main__":
    issues = check_repository()
    for issue in issues:
        print(issue, file=sys.stderr)
    if issues:
        raise SystemExit(1)
    print("Current documentation links, source boundaries and empty examples verified.")
