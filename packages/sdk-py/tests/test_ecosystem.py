"""Shared-fixture conformance for the dependency-ecosystem detector: this port
must report exactly what `fixtures/ecosystem/` pins, byte for byte, and hold the
contract tests that are not fixture cases."""

import json
import os
from pathlib import Path

import pytest

from leji.ecosystem import (
    detect_ecosystem,
    render_ecosystem_block,
    render_ecosystem_line,
    runner_argv,
    text_pip_groups,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CASES_DIR = REPO_ROOT / "fixtures" / "ecosystem"
CASE_NAMES = sorted(p.name for p in CASES_DIR.iterdir() if (p / "expected.json").is_file())


def _serialize(report) -> str:
    """The one committed formatting of an ecosystem expected.json: the report under
    an `ecosystem` key, two-space indent, one trailing newline. Comparing the BYTES
    is what pins key order, which a deep comparison cannot see and which the --json
    surface makes a public contract."""
    return json.dumps({"ecosystem": report.to_json()}, indent=2, ensure_ascii=False) + "\n"


def test_family_is_populated() -> None:
    assert len(CASE_NAMES) >= 111, (
        f"expected the full ecosystem fixture family, found {len(CASE_NAMES)}"
    )


@pytest.mark.parametrize("name", CASE_NAMES)
def test_ecosystem_fixture(name: str) -> None:
    directory = CASES_DIR / name
    expected = (directory / "expected.json").read_text(encoding="utf-8")
    report = detect_ecosystem(str(directory))
    got = _serialize(report)
    # Deep equality first: it names the field that diverged.
    assert json.loads(got) == json.loads(expected), name
    # Then the bytes, which additionally pin key order and formatting.
    assert got == expected, name


POSITIVES = [
    "scan-project-deps-inline",
    "scan-project-deps-multiline",
    "scan-project-deps-specifier",
    "scan-project-deps-spaced-header",
    "scan-project-deps-single-quoted",
    "scan-optional-deps-declared",
    "scan-dependency-groups-declared",
    "scan-tool-uv-dev-declared",
    "scan-tool-uv-dev-marker",
    "scan-poetry-deps-key",
    "scan-poetry-deps-quoted-key",
    "scan-poetry-dev-deps-key",
    "scan-poetry-dev-deps-quoted-key",
    "scan-poetry-group-key",
    "scan-poetry-group-inline-table",
    "scan-pdm-dev-array",
    "scan-pdm-dev-key",
    "scan-pipfile-packages",
    "scan-pipfile-packages-quoted-key",
    "scan-pipfile-dev-packages",
    "scan-pipfile-dev-packages-bare-key",
    "scan-requirements-declared",
    "scan-requirements-bare",
    "scan-requirements-extras",
    "scan-plain-quoted-element",
    "scan-go-2.0",
]

NEGATIVES = [
    "scan-project-deps-absent",
    "scan-project-deps-prefix-only",
    "scan-project-deps-comment",
    "scan-optional-deps-absent",
    "scan-optional-deps-comment",
    "scan-dependency-groups-absent",
    "scan-dependency-groups-comment",
    "scan-dependency-groups-triple-quoted",
    "scan-tool-uv-dev-absent",
    "scan-tool-uv-dev-comment",
    "scan-tool-uv-other-field",
    "scan-poetry-deps-absent",
    "scan-poetry-deps-comment",
    "scan-poetry-dev-deps-absent",
    "scan-poetry-dev-deps-comment",
    "scan-poetry-group-absent",
    "scan-poetry-group-comment",
    "scan-pdm-dev-absent",
    "scan-pdm-dev-comment",
    "scan-pipfile-packages-absent",
    "scan-pipfile-packages-comment",
    "scan-pipfile-dev-packages-absent",
    "scan-pipfile-dev-packages-comment",
    "scan-requirements-indented",
    "scan-requirements-comment",
    "scan-requirements-prefix-only",
    "scan-requirements-include-line",
    "scan-triple-quoted-element",
    "scan-triple-quoted-element-literal",
    "scan-multiline-basic-string",
    "scan-multiline-literal-string",
    "scan-multiline-string-hides-table",
    "scan-project-description",
    "scan-project-keywords",
    "scan-project-classifiers",
    "scan-project-nested-array",
    "scan-unrelated-table-key",
    "scan-poetry-scripts-key",
    "scan-pipfile-scripts",
    "scan-go-closed-block",
    "scan-go-comment",
    "scan-go-1.9",
    "scan-go-1.25",
]


def _declared(name: str) -> bool:
    report = detect_ecosystem(str(CASES_DIR / name))
    assert report.selected is not None, f"{name}: a scanner case always selects one manager"
    return report.selected.direct_declared


@pytest.mark.parametrize("name", POSITIVES)
def test_scanner_positive(name: str) -> None:
    assert _declared(name) is True


@pytest.mark.parametrize("name", NEGATIVES)
def test_scanner_negative(name: str) -> None:
    assert _declared(name) is False


def test_scanner_families_cover_every_shared_case() -> None:
    """A shared case this port does not read is a case it can diverge on."""
    claimed = set(POSITIVES) | set(NEGATIVES)
    on_disk = {n for n in CASE_NAMES if n.startswith("scan-")}
    assert on_disk - claimed == set()


def test_go_directive_threshold() -> None:
    def manager(name: str) -> str:
        report = detect_ecosystem(str(CASES_DIR / name))
        assert report.selected is not None
        return report.selected.manager or ""

    assert manager("scan-go-1.9") == "go-legacy"
    assert manager("go-1.23-legacy") == "go-legacy"
    assert manager("go-no-directive") == "go-legacy"
    assert manager("go-1.24") == "go"
    assert manager("scan-go-1.25") == "go"
    assert manager("scan-go-2.0") == "go"


def _plant(tmp_path: Path, files: dict[str, str], name: str = "root") -> str:
    directory = tmp_path / name
    directory.mkdir()
    for rel, body in files.items():
        (directory / rel).write_text(body, encoding="utf-8")
    return str(directory)


def test_package_manager_grammar(tmp_path: Path) -> None:
    """A recognized name wins whatever the lockfiles say, and a value that does not
    parse never falls through to one."""

    def pm(value, extra: dict[str, str] | None = None, name: str = "pm"):
        files = {"package.json": json.dumps({"packageManager": value})}
        files.update(extra or {})
        return detect_ecosystem(_plant(tmp_path, files, name))

    for i, (value, want) in enumerate(
        [
            ("pnpm@9.12.0", "pnpm"),
            ("bun@1.1.30+e1f2a3b4c5", "bun"),
            ("yarn@4.1.0-rc.1", "yarn"),
            ("npm", "npm"),
        ]
    ):
        report = pm(value, None, f"ok{i}")
        assert report.selected is not None and report.selected.manager == want

    over = pm("pnpm@9.12.0", {"yarn.lock": ""}, "over")
    assert over.selected is not None and over.selected.manager == "pnpm"

    for i, bad in enumerate(
        ["pnpm@@9", "pnpm@", "@9.12.0", "Pnpm@9.12.0", "pnpm 9.12.0", "", "hermit@1.0.0"]
    ):
        report = pm(bad, {"package-lock.json": ""}, f"bad{i}")
        assert report.reason == "unsupported-manager", bad
        assert report.all[0].source == "packageManager"
        assert report.all[0].candidates == []
        assert report.all[0].add is None

    numeric = detect_ecosystem(
        _plant(tmp_path, {"package.json": '{"packageManager":9}'}, "numeric")
    )
    assert numeric.reason == "unsupported-manager"


def test_evidence_eligibility(tmp_path: Path) -> None:
    """A symlinked, dangling or non-regular manifest is refused, never read."""
    outside = _plant(
        tmp_path, {"package.json": '{"dependencies":{"@leji-org/leji":"1"}}'}, "outside"
    )

    linked = tmp_path / "linked"
    linked.mkdir()
    os.symlink(os.path.join(outside, "package.json"), str(linked / "package.json"))
    report = detect_ecosystem(str(linked))
    assert report.reason == "refused-evidence"
    assert report.all[0].evidence == ["package.json"]
    assert report.all[0].direct_declared is False

    dangling = tmp_path / "dangling"
    dangling.mkdir()
    os.symlink(str(dangling / "gone.json"), str(dangling / "package.json"))
    assert detect_ecosystem(str(dangling)).reason == "refused-evidence"

    dir_lock = Path(_plant(tmp_path, {"package.json": "{}"}, "dirlock"))
    (dir_lock / "pnpm-lock.yaml").mkdir()
    as_dir = detect_ecosystem(str(dir_lock))
    assert as_dir.reason == "refused-evidence"
    assert as_dir.all[0].evidence == ["pnpm-lock.yaml"]

    inside = Path(_plant(tmp_path, {"package.json": "{}", "other.json": "{}"}, "inside"))
    os.symlink("./other.json", str(inside / "pnpm-lock.yaml"))
    assert detect_ecosystem(str(inside)).reason == "refused-evidence"

    py_linked = tmp_path / "pylinked"
    py_linked.mkdir()
    os.symlink(os.path.join(outside, "package.json"), str(py_linked / "requirements.txt"))
    py_report = detect_ecosystem(str(py_linked))
    assert py_report.reason == "refused-evidence"
    assert py_report.all[0].ecosystem == "python"


def test_unreadable_manifest(tmp_path: Path) -> None:
    """An unreadable manifest consults neither locks nor defaults."""
    broken = detect_ecosystem(
        _plant(tmp_path, {"package.json": '{ "name": ', "package-lock.json": ""}, "broken")
    )
    assert broken.reason == "unreadable-manifest"
    assert broken.all[0].manager is None
    assert broken.all[0].evidence == []
    assert broken.all[0].add is None

    assert (
        detect_ecosystem(_plant(tmp_path, {"package.json": "[]"}, "array")).reason
        == "unreadable-manifest"
    )

    bom = detect_ecosystem(
        _plant(tmp_path, {"package.json": '﻿{ "packageManager": "yarn@4.1.0" }'}, "bom")
    )
    assert bom.selected is not None and bom.selected.manager == "yarn"


def test_no_walk_up(tmp_path: Path) -> None:
    parent = Path(_plant(tmp_path, {"package.json": "{}", "package-lock.json": ""}, "parent"))
    child = parent / "child"
    child.mkdir()
    report = detect_ecosystem(str(child))
    assert report.selected is None and report.all == [] and report.reason == "none"


def test_runner_argv() -> None:
    """The manager runner only when the repository declares the CLI."""
    for name, want in [
        ("node-declared", ["npx", "--no-install", "@leji-org/leji"]),
        ("node-pnpm-lock", ["leji"]),
        ("go-declared-block", ["go", "tool", "leji"]),
        ("python-declared-pyproject-groups", ["uv", "run", "leji"]),
        ("none", ["leji"]),
        ("node-two-lockfiles", ["leji"]),
    ]:
        assert runner_argv(detect_ecosystem(str(CASES_DIR / name))) == want, name


def test_rendered_block() -> None:
    def block(name: str) -> str:
        return render_ecosystem_block(detect_ecosystem(str(CASES_DIR / name)))

    assert block("node-pnpm-lock") == (
        "Detected pnpm (pnpm-lock.yaml). To declare the Leji CLI as a dev dependency so a clean install "
        "brings leji, run:\n   pnpm add -D @leji-org/leji"
    )
    assert block("node-declared") == "The Leji CLI is already declared in package.json."
    assert block("node-two-lockfiles") == (
        "Detected package.json with package-lock.json and yarn.lock; leji will not guess the package manager. "
        "Declare it with the one this repo uses:\n   npm i -D @leji-org/leji\n   yarn add -D @leji-org/leji"
    )
    for name in (
        "node-packagemanager-unknown",
        "node-unreadable-manifest",
        "node-refused-evidence",
    ):
        text = block(name)
        assert text and "\n   npm" not in text, name
    assert block("python-bare-pyproject") == "\n".join(text_pip_groups("pyproject.toml"))
    assert "pip install -r requirements-dev.txt" in block("python-requirements-only")
    assert "go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest" in block(
        "go-1.23-legacy"
    )
    assert "https://leji.org/quickstart/" in block("none")


def test_rendered_line() -> None:
    def line(name: str) -> str:
        return render_ecosystem_line(detect_ecosystem(str(CASES_DIR / name)))

    assert line("node-pnpm-lock") == "Ecosystem: pnpm (pnpm-lock.yaml); Leji CLI not declared"
    assert line("node-declared") == "Ecosystem: npm (package-lock.json); Leji CLI declared"
    assert line("python-pipfile-only") == "Ecosystem: pipenv (Pipfile); Leji CLI declared"
    assert line("python-tool-uv-no-lock") == "Ecosystem: uv (pyproject.toml); Leji CLI not declared"
    assert line("none") == "Ecosystem: none detected"
    for name in CASE_NAMES:
        assert "\n" not in line(name), name


def test_trailing_content_is_unreadable(tmp_path: Path) -> None:
    """Trailing content after the first value is not strict JSON: JSON.parse and Go's
    decoder both refuse it, and json.loads does too — all three call it unreadable
    rather than reading whatever came first."""
    bad = [
        '{"devDependencies":{"@leji-org/leji":"^1"}} trailing garbage',
        '{"name":"demo"} {"name":"second"}',
        '{"name":"demo"}]',
        '{"name":"demo"} null',
    ]
    for i, body in enumerate(bad):
        root = _plant(tmp_path, {"package.json": body, "package-lock.json": ""}, f"trail{i}")
        assert detect_ecosystem(root).reason == "unreadable-manifest", body
    # Trailing whitespace and a trailing newline are not content.
    for i, body in enumerate(['{"name":"demo"}\n', '  {"name":"demo"}  \n\n']):
        root = _plant(tmp_path, {"package.json": body, "package-lock.json": ""}, f"ws{i}")
        assert detect_ecosystem(root).reason is None, body
