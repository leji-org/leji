"""The shared render fixtures, driven through the real command: their pinned
findings, their layout, their golden export bytes, and their idempotency.

The detector's own families live with the detector (test_renderlint.py); what this
file asserts is the contract the three SDKs share — the findings a `--json` consumer
reads, in the canonical order, and the exported tree byte for byte against the
committed goldens. Mirrors the fixture half of packages/sdk/test/renderlint.test.ts.
"""

from __future__ import annotations

import hashlib
import json
import posixpath
import shutil
from pathlib import Path

import pytest

from leji.cli import main

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"

# The layout fixtures are driven by test_canary.py, which asserts their trust corpus
# alongside the same export block; this harness takes the rest.
CANARY_DRIVEN = {
    "valid-unified-leji-fresh",
    "valid-unified-leji-stale-tree",
    "valid-trust-canary-nested-root",
    "valid-trust-canary-dot-root",
}

FINDING_KEYS = ("rule", "severity", "path", "line", "construct")


def _expected(name: str) -> dict:
    return json.loads((FIXTURES / name / "expected.json").read_text(encoding="utf-8"))


EXPORT_FIXTURES = sorted(
    p.name
    for p in FIXTURES.iterdir()
    if (p / "expected.json").is_file()
    and p.name not in CANARY_DRIVEN
    and "export" in _expected(p.name)
)


def _fixture_rel(value: str, what: str) -> str:
    """A fixture-declared path, as the README fixes it: repository-root-relative
    POSIX, normalized, no `..` segment, never absolute."""
    assert not posixpath.isabs(value), f"{what} must be relative: {value}"
    normalized = posixpath.normpath(value).rstrip("/")
    assert normalized == value.rstrip("/"), f"{what} must be normalized: {value}"
    assert ".." not in normalized.split("/"), f"{what} must not escape the fixture: {value}"
    return normalized


def _fixture_abs(directory: Path, rel: str) -> Path:
    return directory.joinpath(*rel.split("/"))


def _snapshot(directory: Path) -> list[tuple[str, str]]:
    """Every path under `directory` as `rel -> content digest` (directories as `rel/`
    -> ''), so a comparison covers appearance and disappearance as well as content."""
    acc: list[tuple[str, str]] = []

    def walk(rel: str) -> None:
        base = directory if rel == "" else directory / rel
        for entry in sorted(base.iterdir(), key=lambda p: p.name):
            child = entry.name if rel == "" else f"{rel}/{entry.name}"
            if entry.is_symlink():
                acc.append((child, "non-regular"))
            elif entry.is_dir():
                acc.append((child + "/", ""))
                walk(child)
            elif entry.is_file():
                acc.append((child, hashlib.sha256(entry.read_bytes()).hexdigest()))
            else:
                acc.append((child, "non-regular"))

    walk("")
    return sorted(acc)


def _golden_path(fixture_root: Path, declared: str, what: str) -> Path:
    """A golden artifact at its declared name, or at the dot-prefixed name beside it:
    a `rootPath: "."` fixture exports its own root, so a plainly named golden would be
    exported into the next bake of itself (fixtures/README.md)."""
    head, _, rest = _fixture_rel(declared, what).partition("/")
    plain = _fixture_abs(fixture_root, head if not rest else f"{head}/{rest}")
    if plain.exists():
        return plain
    return _fixture_abs(fixture_root, "." + head if not rest else f".{head}/{rest}")


def _files_under(directory: Path) -> list[str]:
    """Every file under `directory`, as export-root-relative POSIX paths, sorted."""
    return sorted(
        str(p.relative_to(directory)).replace("\\", "/")
        for p in directory.rglob("*")
        if p.is_file()
    )


@pytest.mark.parametrize("name", EXPORT_FIXTURES)
def test_render_fixture_export_block(name: str, tmp_path: Path, capsys) -> None:
    block = _expected(name)["export"]
    directory = tmp_path / name
    shutil.copytree(FIXTURES / name, directory)

    preserved_before: dict[str, str] = {}
    for rel in block.get("layout", {}).get("preserved", []):
        abs_path = _fixture_abs(directory, _fixture_rel(rel, "preserved entry"))
        assert abs_path.exists(), f"preserved path exists before the run: {rel}"
        if abs_path.is_file():
            preserved_before[rel] = abs_path.read_text(encoding="utf-8")

    # The whole command, under the fixture's own argv: the exit code is the process's,
    # and the findings are the ones a `--json` consumer reads.
    argv = [*(block.get("args") or ["export"]), "--root", str(directory), "--json"]
    code = main(list(argv))
    stdout = capsys.readouterr().out
    assert code == block["exit"], f"exit code for {name}: {stdout}"
    doc = json.loads(stdout)
    assert doc["out"].replace("\\", "/") == block["out"], "the declared output directory"
    # Matched on (rule, severity, path, line, construct) IN ORDER — message text is
    # never compared, and the order is the canonical one the three SDKs share.
    got = [{k: f.get(k) for k in FINDING_KEYS} for f in doc["findings"]]
    assert got == block["findings"], f"findings for {name}"

    # `roles` is the layout's role map — which directory each role NAMES — and
    # present/absent say which of them a given run establishes: a `--strict` run names
    # the export role and deliberately writes nothing at it.
    layout = block.get("layout") or {}
    absent = {_fixture_rel(rel, "absent entry") for rel in layout.get("absent", [])}
    for role, role_dir in (layout.get("roles") or {}).items():
        rel = _fixture_rel(role_dir, f"role {role}")
        if rel in absent:
            continue
        assert _fixture_abs(directory, rel).is_dir(), f"role {role} established at {role_dir}"
    for rel in layout.get("present", []):
        assert _fixture_abs(directory, _fixture_rel(rel, "present entry")).exists(), (
            f"present after the run: {rel}"
        )
    for rel in absent:
        assert not _fixture_abs(directory, rel).exists(), f"never created: {rel}"
    for rel, before in preserved_before.items():
        assert _fixture_abs(directory, rel).read_text(encoding="utf-8") == before, (
            f"byte-identical after the run: {rel}"
        )

    # --- the golden tree -----------------------------------------------------
    out = _fixture_abs(directory, _fixture_rel(block["out"], "export out"))
    golden = block["goldenTree"]
    if golden["status"] == "none":
        assert not out.exists(), "a run that writes no export tree has nothing to bake"
    if golden["status"] == "baked":
        content_dir = _golden_path(FIXTURES / name, golden["contentDir"], "goldenTree.contentDir")
        manifest_file = _golden_path(FIXTURES / name, golden["manifest"], "goldenTree.manifest")
        written = _files_under(out)
        in_content = [f[len("content/") :] for f in written if f.startswith("content/")]
        outside = [f for f in written if not f.startswith("content/")]

        # The committed bytes ARE the export's content tree: same paths, same bytes, in
        # both directions, so a file that appears or disappears fails here.
        assert in_content == _files_under(content_dir), (
            f"{name}: the golden content tree lists exactly what the export wrote"
        )
        for rel in in_content:
            assert (out / "content").joinpath(*rel.split("/")).read_bytes() == content_dir.joinpath(
                *rel.split("/")
            ).read_bytes(), f"{name}: exported bytes differ from the golden for content/{rel}"

        # Everything else — chrome, vendored assets, fonts — by digest and size. The two
        # sets are disjoint by construction and exhaustive by this comparison.
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        assert manifest["version"] == 1, "the manifest states its version"
        assert sorted(manifest["files"]) == outside, (
            f"{name}: the manifest pins every file outside content/"
        )
        for rel in outside:
            data = out.joinpath(*rel.split("/")).read_bytes()
            pin = manifest["files"][rel]
            assert hashlib.sha256(data).hexdigest() == pin["sha256"], rel
            assert len(data) == pin["size"], f"{rel} size"

    # --- idempotency ---------------------------------------------------------
    if (block.get("rerun") or {}).get("byteIdentical"):
        after_first = _snapshot(directory)
        assert main(list(argv)) == block["exit"], "the second run answers the same"
        capsys.readouterr()
        assert _snapshot(directory) == after_first, (
            "a second run is a byte-level no-op across the whole working tree"
        )
