"""`leji ci` tests, mirroring packages/sdk/test/run.test.ts
"ci: writes the workflow when absent, is idempotent, and exits 1 with no manifest"."""

from __future__ import annotations

import json
import os
from pathlib import Path

from leji.cli import main
from leji.init_cmd import (
    build_azure_pipeline,
    build_circleci_config,
    build_circleci_snippet,
)


def run(capsys, argv: list[str]) -> tuple[int, str, str]:
    code = main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_ci_writes_when_absent_idempotent_and_exits_1_with_no_manifest(
    capsys, tmp_path: Path
) -> None:
    layer = tmp_path / "layer"
    layer.mkdir()
    main(["init", "--dir", str(layer), "--yes", "--name", "demo"])
    capsys.readouterr()

    wf = layer / ".github" / "workflows" / "leji.yml"
    assert not wf.exists(), "core init writes no CI workflow"

    code, out, _ = run(capsys, ["ci", "--root", str(layer)])
    assert code == 0
    assert "Wrote" in out and "leji.yml" in out
    assert wf.exists(), "workflow written"
    before = wf.read_text(encoding="utf-8")

    code, out, _ = run(capsys, ["ci", "--root", str(layer), "--json"])
    assert code == 0
    assert json.loads(out)["created"] is False, "idempotent: not re-created"
    assert wf.read_text(encoding="utf-8") == before, "existing workflow left untouched"

    missing = tmp_path / "no-such-layer"
    code, out, err = run(capsys, ["ci", "--root", str(missing)])
    assert code == 1
    assert "manifest-missing" in (out + err) or "no leji.json" in (out + err)


GITLAB_BLOCK = (
    "# >>> leji ci (managed) >>>\n"
    "leji-validate:\n"
    "  image: node:22\n"
    "  script:\n"
    "    - npx -y @leji-org/leji@latest validate\n"
    "# <<< leji ci (managed) <<<\n"
)


def _seeded_ci_dir(capsys, tmp_path: Path) -> Path:
    layer = tmp_path / "layer"
    layer.mkdir()
    main(["init", "--dir", str(layer), "--yes", "--name", "demo"])
    capsys.readouterr()
    return layer


# Mirrors run.test.ts "ci --provider github: explicit github matches the default,
# JSON carries provider/action/created".
def test_ci_provider_github(capsys, tmp_path: Path) -> None:
    layer = _seeded_ci_dir(capsys, tmp_path)
    code, out, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "github", "--json"])
    assert code == 0
    j = json.loads(out)
    assert j["provider"] == "github"
    assert j["action"] == "created"
    assert j["created"] is True
    assert j["workflow"] == ".github/workflows/leji.yml"
    assert (layer / ".github" / "workflows" / "leji.yml").exists()


# Mirrors run.test.ts "ci --provider gitlab: creates the managed block, is idempotent".
def test_ci_provider_gitlab_create(capsys, tmp_path: Path) -> None:
    layer = _seeded_ci_dir(capsys, tmp_path)
    gl = layer / ".gitlab-ci.yml"
    code, out, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "gitlab", "--json"])
    assert code == 0
    j = json.loads(out)
    assert j["provider"] == "gitlab"
    assert j["action"] == "created"
    assert gl.read_text(encoding="utf-8") == GITLAB_BLOCK
    code, out, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "gitlab", "--json"])
    assert json.loads(out)["action"] == "unchanged"
    assert gl.read_text(encoding="utf-8") == GITLAB_BLOCK


# Mirrors run.test.ts "ci --provider gitlab: appends to an existing config,
# byte-exactly, for every trailing-newline case".
def test_ci_provider_gitlab_merge(capsys, tmp_path: Path) -> None:
    cases = [
        ("trailing newline", "stages:\n  - test\n", "stages:\n  - test\n" + "\n" + GITLAB_BLOCK),
        ("no trailing newline", "stages:\n  - test", "stages:\n  - test" + "\n\n" + GITLAB_BLOCK),
        ("empty file", "", GITLAB_BLOCK),
    ]
    for i, (label, base, expected) in enumerate(cases):
        layer = tmp_path / f"layer-{i}"
        layer.mkdir()
        main(["init", "--dir", str(layer), "--yes", "--name", "demo"])
        capsys.readouterr()
        gl = layer / ".gitlab-ci.yml"
        gl.write_text(base, encoding="utf-8")
        code, _, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "gitlab"])
        assert code == 0, label
        assert gl.read_text(encoding="utf-8") == expected, label
        code, out, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "gitlab", "--json"])
        assert json.loads(out)["action"] == "unchanged", label


# Mirrors run.test.ts "ci --provider gitlab: replaces a stale managed block,
# preserving surrounding content".
def test_ci_provider_gitlab_replace_stale(capsys, tmp_path: Path) -> None:
    layer = _seeded_ci_dir(capsys, tmp_path)
    gl = layer / ".gitlab-ci.yml"
    stale = "# >>> leji ci (managed) >>>\nleji-validate:\n  image: node:18\n# <<< leji ci (managed) <<<\n"
    gl.write_text("before:\n  keep: 1\n\n" + stale + "\nafter:\n  keep: 2\n", encoding="utf-8")
    code, _, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "gitlab"])
    assert code == 0
    out = gl.read_text(encoding="utf-8")
    assert out == "before:\n  keep: 1\n\n" + GITLAB_BLOCK + "\nafter:\n  keep: 2\n"
    assert "node:18" not in out


# Mirrors run.test.ts "ci --provider circleci: creates when absent, prints a
# snippet (no edit) when present".
def test_ci_provider_circleci(capsys, tmp_path: Path) -> None:
    layer = _seeded_ci_dir(capsys, tmp_path)
    cc = layer / ".circleci" / "config.yml"
    code, out, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "circleci", "--json"])
    assert code == 0
    assert json.loads(out)["action"] == "created"
    before = cc.read_text(encoding="utf-8")
    assert before == build_circleci_config(), "created config is byte-exact"
    code, out, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "circleci", "--json"])
    assert code == 0
    j = json.loads(out)
    assert j["action"] == "manual"
    assert j["created"] is False
    assert j["snippet"] == build_circleci_snippet(), "manual snippet is byte-exact"
    assert cc.read_text(encoding="utf-8") == before, "existing config left untouched"


# Mirrors run.test.ts "ci --provider azure: dedicated pipeline file + activation
# note (JSON and human), idempotent, byte-exact".
def test_ci_provider_azure(capsys, tmp_path: Path) -> None:
    d1 = _seeded_ci_dir(capsys, tmp_path)
    az = d1 / ".azure-pipelines" / "leji.yml"
    code, out, _ = run(capsys, ["ci", "--root", str(d1), "--provider", "azure", "--json"])
    assert code == 0
    j = json.loads(out)
    assert j["provider"] == "azure"
    assert j["action"] == "created"
    assert j["created"] is True
    assert j["workflow"] == ".azure-pipelines/leji.yml"
    assert "Azure Pipelines does not auto-run" in j["note"]
    assert az.read_text(encoding="utf-8") == build_azure_pipeline(), "pipeline file is byte-exact"
    code, out, _ = run(capsys, ["ci", "--root", str(d1), "--provider", "azure", "--json"])
    assert code == 0
    assert json.loads(out)["action"] == "unchanged", "idempotent"
    # a fresh create prints the activation note in human output
    sub = tmp_path / "azure2"
    sub.mkdir()
    main(["init", "--dir", str(sub), "--yes", "--name", "demo"])
    capsys.readouterr()
    code, out, _ = run(capsys, ["ci", "--root", str(sub), "--provider", "azure"])
    assert code == 0
    assert "Wrote" in out and ".azure-pipelines/leji.yml" in out
    assert "Azure Pipelines does not auto-run this file" in out


# Mirrors run.test.ts "ci --provider: invalid value and missing value both fail
# with usage exit 2".
def test_ci_provider_invalid_and_missing(capsys, tmp_path: Path) -> None:
    layer = _seeded_ci_dir(capsys, tmp_path)
    code, _, err = run(capsys, ["ci", "--root", str(layer), "--provider", "bogus"])
    assert code == 2
    assert 'unknown provider "bogus"; expected github, gitlab, circleci, or azure' in err
    code, _, err = run(capsys, ["ci", "--root", str(layer), "--provider"])
    assert code == 2
    assert "--provider requires a value" in err


# Mirrors run.test.ts "ci: refuses to write through a symlink that escapes the root".
def test_ci_symlink_refused(capsys, tmp_path: Path) -> None:
    # GitLab guards before it reads/rewrites: a symlinked target escaping the root
    # is refused outright (no read, no write).
    layer = _seeded_ci_dir(capsys, tmp_path)
    (layer / ".gitlab-ci.yml").symlink_to("/etc/hosts")
    code, _, err = run(capsys, ["ci", "--root", str(layer), "--provider", "gitlab"])
    assert code == 2
    assert "refusing to write through a symlink that escapes the target" in err
    # Every provider guards before touching the target, so a final-file symlink that
    # escapes the root is refused outright (no read, no write), even when it exists.
    for i, (provider, target_rel) in enumerate(
        [
            ("github", ".github/workflows/leji.yml"),
            ("circleci", ".circleci/config.yml"),
            ("azure", ".azure-pipelines/leji.yml"),
        ]
    ):
        sub = tmp_path / f"target-{i}"
        sub.mkdir()
        main(["init", "--dir", str(sub), "--yes", "--name", "demo"])
        capsys.readouterr()
        target = sub / target_rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to("/etc/hosts")
        code, _, err = run(capsys, ["ci", "--root", str(sub), "--provider", provider])
        assert code == 2, provider
        assert "refusing to write through a symlink that escapes the target" in err
    # A symlinked PARENT directory that escapes the root is likewise caught.
    for i, (provider, parent_rel) in enumerate(
        [
            ("github", ".github/workflows"),
            ("circleci", ".circleci"),
            ("azure", ".azure-pipelines"),
        ]
    ):
        sub = tmp_path / f"parent-{i}"
        sub.mkdir()
        main(["init", "--dir", str(sub), "--yes", "--name", "demo"])
        capsys.readouterr()
        parent = sub / parent_rel
        parent.parent.mkdir(parents=True, exist_ok=True)
        parent.symlink_to("/etc")
        code, _, err = run(capsys, ["ci", "--root", str(sub), "--provider", provider])
        assert code == 2, provider
        assert "refusing to write through a symlink that escapes the target" in err
    # The atomic-write sibling temp path (<target>.leji-tmp) must also be guarded.
    for i, (provider, target_rel) in enumerate(
        [
            ("github", ".github/workflows/leji.yml"),
            ("gitlab", ".gitlab-ci.yml"),
            ("circleci", ".circleci/config.yml"),
            ("azure", ".azure-pipelines/leji.yml"),
        ]
    ):
        sub = tmp_path / f"tmp-{i}"
        sub.mkdir()
        main(["init", "--dir", str(sub), "--yes", "--name", "demo"])
        capsys.readouterr()
        tmp = sub / f"{target_rel}.leji-tmp"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.symlink_to("/etc/hosts")
        code, _, err = run(capsys, ["ci", "--root", str(sub), "--provider", provider])
        assert code == 2, provider
        assert "refusing to write through a symlink that escapes the target" in err


# Mirrors run.test.ts "ci: an unwritable target dir yields a normalized error".
def test_ci_unwritable_target(capsys, tmp_path: Path) -> None:
    # Root bypasses permission bits, so the write would succeed; skip there.
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return
    layer = _seeded_ci_dir(capsys, tmp_path)
    wf = layer / ".github" / "workflows"
    wf.mkdir(parents=True, exist_ok=True)
    wf.chmod(0o555)
    try:
        code, _, err = run(capsys, ["ci", "--root", str(layer), "--provider", "github"])
        assert code == 2
        assert 'cannot write ".github/workflows/leji.yml": permission denied' in err
    finally:
        wf.chmod(0o755)  # restore so the temp tree can be cleaned up


# Mirrors run.test.ts "ci: a write failure after the temp file cleans up".
def test_ci_write_failure_cleans_up(capsys, tmp_path: Path, monkeypatch) -> None:
    layer = _seeded_ci_dir(capsys, tmp_path)
    monkeypatch.setenv("LEJI_TEST_FAIL_RENAME", "1")
    code, _, err = run(capsys, ["ci", "--root", str(layer), "--provider", "github"])
    assert code == 2
    assert 'cannot write ".github/workflows/leji.yml"' in err
    assert "permission denied" not in err
    wf = layer / ".github" / "workflows"
    assert not (wf / "leji.yml").exists()
    assert not (wf / "leji.yml.leji-tmp").exists()
