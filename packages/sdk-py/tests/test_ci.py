"""`leji ci` tests, mirroring packages/sdk/test/run.test.ts
"ci: writes the workflow when absent, is idempotent, and exits 1 with no manifest"."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from leji.cli import main

REPO_ROOT = Path(__file__).resolve().parents[3]
GOLDENS = REPO_ROOT / "fixtures" / "ci-goldens"


def golden(name: str) -> str:
    """One committed generated-CI golden: the byte oracle both this port and the
    reference are checked against."""
    return (GOLDENS / name).read_text(encoding="utf-8")


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


# `stage: .pre` is deliberate: without an explicit stage GitLab assigns `test`, and a
# pipeline whose own `stages:` list omits it rejects the whole configuration.
GITLAB_BLOCK = (
    "# >>> leji ci (managed) >>>\n"
    "leji-validate:\n"
    "  stage: .pre\n"
    "  image: node:22\n"
    "  script:\n"
    "    - npx -y @leji-org/leji@1 validate\n"
    "    - npx -y @leji-org/leji@1 index --check\n"
    "# <<< leji ci (managed) <<<\n"
)


def _seeded_ci_dir(capsys, tmp_path: Path) -> Path:
    layer = tmp_path / "layer"
    layer.mkdir(parents=True)
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
    assert before == golden("circleci-node-fallback.yml"), "created config is byte-exact"
    # A file leji generated is leji's to keep current: the re-run recognizes its own
    # bytes and reports unchanged rather than handing back a snippet for a file the
    # user never wrote.
    code, out, _ = run(capsys, ["ci", "--root", str(layer), "--provider", "circleci", "--json"])
    assert code == 0
    j = json.loads(out)
    assert j["action"] == "unchanged"
    assert j["created"] is False
    assert cc.read_text(encoding="utf-8") == before, "idempotent byte-for-byte"

    # Someone else's config: never modified, and the snippet comes back to add by hand.
    foreign = _seeded_ci_dir(capsys, tmp_path / "foreign")
    fcc = foreign / ".circleci" / "config.yml"
    fcc.parent.mkdir(parents=True, exist_ok=True)
    fcc.write_text("version: 2.1\njobs:\n  mine: {}\n", encoding="utf-8")
    code, out, _ = run(capsys, ["ci", "--root", str(foreign), "--provider", "circleci", "--json"])
    assert code == 0
    j = json.loads(out)
    assert j["action"] == "manual"
    # The hand-add snippet is the generated config without its two leading lines (the
    # ownership marker and `version: 2.1`): it claims nothing in a file leji does not own.
    assert j["snippet"] == "\n".join(golden("circleci-node-fallback.yml").split("\n")[2:])
    assert fcc.read_text(encoding="utf-8") == "version: 2.1\njobs:\n  mine: {}\n"


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
    assert az.read_text(encoding="utf-8") == golden("azure-node-fallback.yml"), "byte-exact"
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


# Mirrors units.test.ts "ci: provider inference from the origin remote".
def test_ci_provider_inference_from_origin_remote() -> None:
    from leji.init_cmd import ci_provider_from_remote

    assert ci_provider_from_remote("git@github.com:acme/app.git") == "github"
    assert ci_provider_from_remote("git@gitlab.com:acme/app.git") == "gitlab"
    assert ci_provider_from_remote("https://gitlab.example.co/acme/app.git") == "gitlab"
    assert ci_provider_from_remote("https://dev.azure.com/acme/app/_git/app") == "azure"
    assert ci_provider_from_remote("https://bitbucket.org/acme/app.git") is None
    assert ci_provider_from_remote(None) is None


# Mirrors units.test.ts "ci --hooks: managed pre-commit hook is created,
# idempotent, and never clobbers".
def test_ci_hooks_created_idempotent_never_clobbers(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_local_hook

    _git_init(tmp_path)
    first = ensure_local_hook(str(tmp_path))
    assert first.action == "created"
    second = ensure_local_hook(str(tmp_path))
    assert second.action == "unchanged"
    hook_path = tmp_path / ".git" / "hooks" / "pre-commit"
    assert hook_path.stat().st_mode & 0o111, "hook is executable"
    hook_path.write_text("#!/bin/sh\necho custom hook\n", encoding="utf-8")
    third = ensure_local_hook(str(tmp_path))
    assert third.action == "manual", "unmanaged hook is never clobbered"
    assert third.reason == "foreign-hook"
    assert "'leji' validate || exit 1" in (third.snippet or "")
    assert "node_modules" not in (third.snippet or ""), "the scalar shim is gone"
    assert "custom hook" in hook_path.read_text(encoding="utf-8"), "foreign hook untouched"


def test_ci_hooks_requires_git_repo(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_local_hook

    try:
        ensure_local_hook(str(tmp_path))
    except RuntimeError as e:
        assert str(e) == "not a git repository (no .git directory); hooks need one"
    else:
        raise AssertionError("expected the no-git error")


def _git_init(tmp_path: Path) -> None:
    import subprocess

    subprocess.run(["git", "-C", str(tmp_path), "init", "-q"], check=True)


def _set_hooks_path(tmp_path: Path, value: str) -> None:
    import subprocess

    subprocess.run(["git", "-C", str(tmp_path), "config", "core.hooksPath", value], check=True)


# Mirrors units.test.ts "ci --hooks: husky (.husky/_) merges a managed block ...".
def test_ci_hooks_husky_merges_managed_block(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_local_hook

    _git_init(tmp_path)
    _set_hooks_path(tmp_path, ".husky/_")
    husky_pre = tmp_path / ".husky" / "pre-commit"
    husky_pre.parent.mkdir(parents=True)
    husky_pre.write_text("#!/bin/sh\nnpm test\n", encoding="utf-8")
    r = ensure_local_hook(str(tmp_path))
    assert r.path == ".husky/pre-commit"
    assert r.action == "updated"
    assert r.managed == "block"
    merged = husky_pre.read_text(encoding="utf-8")
    assert "npm test" in merged, "existing husky content untouched"
    assert "# >>> leji hooks (managed) >>>" in merged
    assert "'leji' validate || exit 1" in merged
    assert not (tmp_path / ".git" / "hooks" / "pre-commit").exists()
    assert ensure_local_hook(str(tmp_path)).action == "unchanged", "rerun is idempotent"


# Mirrors units.test.ts "ci --hooks: husky repo without .husky/pre-commit ...".
def test_ci_hooks_husky_creates_file_when_absent(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_local_hook

    _git_init(tmp_path)
    _set_hooks_path(tmp_path, ".husky/_")
    r = ensure_local_hook(str(tmp_path))
    assert r.action == "created"
    assert r.managed == "block"
    husky_pre = tmp_path / ".husky" / "pre-commit"
    body = husky_pre.read_text(encoding="utf-8")
    assert body.startswith("#!/bin/sh\n")
    assert husky_pre.stat().st_mode & 0o111, "husky hook is executable"
    assert not (tmp_path / ".git" / "hooks" / "pre-commit").exists()


# Mirrors units.test.ts "ci --hooks: a custom core.hooksPath dir ...".
def test_ci_hooks_custom_dir_writes_managed_file(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_local_hook

    _git_init(tmp_path)
    _set_hooks_path(tmp_path, "githooks")
    r = ensure_local_hook(str(tmp_path))
    assert r.path == "githooks/pre-commit"
    assert r.action == "created"
    assert r.managed == "file"
    custom = tmp_path / "githooks" / "pre-commit"
    assert "# leji pre-commit (managed)" in custom.read_text(encoding="utf-8")
    assert "'leji' validate || exit 1" in custom.read_text(encoding="utf-8")
    assert custom.stat().st_mode & 0o111, "custom hook is executable"
    assert not (tmp_path / ".git" / "hooks" / "pre-commit").exists()


# Mirrors units.test.ts "ci --hooks: direct .husky (v8) hook is executable and
# mode-corrected on rerun".
def test_ci_hooks_direct_husky_v8_mode_correction(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_local_hook

    _git_init(tmp_path)
    _set_hooks_path(tmp_path, ".husky")
    first = ensure_local_hook(str(tmp_path))
    assert first.action == "created"
    assert first.path == ".husky/pre-commit"
    assert first.managed == "block"
    husky_pre = tmp_path / ".husky" / "pre-commit"
    assert husky_pre.stat().st_mode & 0o111, "created hook is executable"
    assert ensure_local_hook(str(tmp_path)).action == "unchanged"
    husky_pre.chmod(0o644)
    third = ensure_local_hook(str(tmp_path))
    assert third.action == "updated", "mode-only correction is updated"
    assert husky_pre.stat().st_mode & 0o111, "hook re-made executable"


# Mirrors units.test.ts "ci --hooks: a core.hooksPath outside the repo ...".
def test_ci_hooks_path_outside_repo_is_manual(
    tmp_path: Path, tmp_path_factory: pytest.TempPathFactory
) -> None:
    from leji.init_cmd import ensure_local_hook

    _git_init(tmp_path)
    outside = tmp_path_factory.mktemp("outside")
    _set_hooks_path(tmp_path, str(outside))
    r = ensure_local_hook(str(tmp_path))
    assert r.action == "manual", "an escaping hooks path is never written"
    assert r.managed == "file"
    assert r.reason == "outside-root"
    assert r.path == f"{outside}/pre-commit", "reports the computed target"
    assert "'leji' validate || exit 1" in (r.snippet or "")
    assert not (outside / "pre-commit").exists(), "nothing written outside the repo"
    assert not (tmp_path / ".git" / "hooks" / "pre-commit").exists()


# Mirrors units.test.ts "ci --hooks: a byte-current .git/hooks/pre-commit that lost
# its exec bit is mode-corrected".
def test_ci_hooks_standalone_mode_correction(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_local_hook

    _git_init(tmp_path)
    assert ensure_local_hook(str(tmp_path)).action == "created"
    hook_path = tmp_path / ".git" / "hooks" / "pre-commit"
    assert hook_path.stat().st_mode & 0o111, "created hook is executable"
    assert ensure_local_hook(str(tmp_path)).action == "unchanged"
    hook_path.chmod(0o644)
    third = ensure_local_hook(str(tmp_path))
    assert third.action == "updated", "mode-only correction is updated"
    assert hook_path.stat().st_mode & 0o111, "hook re-made executable"


# Mirrors units.test.ts "ci --hooks: a relative out-of-root core.hooksPath reports a
# normalized target".
def test_ci_hooks_relative_out_of_root_normalized(tmp_path: Path) -> None:
    from leji.init_cmd import ensure_local_hook

    _git_init(tmp_path)
    _set_hooks_path(tmp_path, "../sibling-ext/.husky/_")
    r = ensure_local_hook(str(tmp_path))
    assert r.action == "manual"
    assert r.reason == "outside-root"
    assert r.managed == "block"
    want = f"{tmp_path.parent}/sibling-ext/.husky/pre-commit"
    assert r.path == want, "the reported target is lexically normalized (no ..)"
    assert ".." not in r.path


# Mirrors units.test.ts "ci: local-first CI variant ..." / "ci: npx @1 fallback ...".
def test_ci_job_follows_the_repository_manager(capsys, tmp_path: Path) -> None:
    """The generated job installs with the manager the repository actually uses, and
    declaring without a lockfile is not enough."""
    pnpm = _seeded_ci_dir(capsys, tmp_path / "pnpm")
    (pnpm / "package.json").write_text(
        '{"devDependencies":{"@leji-org/leji":"^1.3.0"}}', encoding="utf-8"
    )
    (pnpm / "pnpm-lock.yaml").write_text("lockfileVersion: 9\n", encoding="utf-8")
    run(capsys, ["ci", "--root", str(pnpm), "--provider", "github"])
    wf = (pnpm / ".github" / "workflows" / "leji.yml").read_text(encoding="utf-8")
    assert "npm ci" not in wf, "no npm ci in a pnpm repository"
    assert "- run: corepack enable && pnpm install --frozen-lockfile" in wf
    assert "- run: pnpm exec leji validate" in wf
    assert "npx -y @leji-org/leji@1" not in wf, "declared + locked is never the fallback"

    unlocked = _seeded_ci_dir(capsys, tmp_path / "unlocked")
    (unlocked / "package.json").write_text(
        '{"devDependencies":{"@leji-org/leji":"^1.3.0"}}', encoding="utf-8"
    )
    run(capsys, ["ci", "--root", str(unlocked), "--provider", "github"])
    fallback = (unlocked / ".github" / "workflows" / "leji.yml").read_text(encoding="utf-8")
    assert "npx -y @leji-org/leji@1 validate" in fallback


def test_node_declaration_through_the_detector(tmp_path: Path) -> None:
    """The declaration rules, reached only through the detector: the direct
    package.json read this port used to carry is gone."""
    from leji.ecosystem import detect_ecosystem

    def declared(pkg: str, name: str) -> bool:
        root = tmp_path / name
        root.mkdir()
        (root / "package.json").write_text(pkg, encoding="utf-8")
        (root / "package-lock.json").write_text("", encoding="utf-8")
        report = detect_ecosystem(str(root))
        assert report.selected is not None
        return report.selected.direct_declared

    assert not declared("{}", "empty")
    assert declared('{"devDependencies":{"@leji-org/leji":"^1.3.0"}}', "dev")
    assert declared('\ufeff{"dependencies":{"@leji-org/leji":"1.3.0"}}', "bom")
    assert not declared('{"dependencies":["@leji-org/leji"]}', "array")
    for i, bad in enumerate(["{ not json", '{"dependencies":{"@leji-org/leji":NaN}}']):
        root = tmp_path / f"bad{i}"
        root.mkdir()
        (root / "package.json").write_text(bad, encoding="utf-8")
        (root / "package-lock.json").write_text("", encoding="utf-8")
        assert detect_ecosystem(str(root)).reason == "unreadable-manifest"


def test_ci_dangling_target_is_refused_never_written_through(capsys, tmp_path: Path) -> None:
    # Every arm decided presence with an existence check, which follows symlinks: a
    # dangling workflow link read as absent and the create landed at the link's
    # destination, a name inside the repository the tool never planned. The verified
    # read refuses the standing entry instead, in the same words an escaping target gets.
    for i, (provider, target_rel) in enumerate(
        [
            ("github", ".github/workflows/leji.yml"),
            ("gitlab", ".gitlab-ci.yml"),
            ("circleci", ".circleci/config.yml"),
            ("azure", ".azure-pipelines/leji.yml"),
        ]
    ):
        layer = _seeded_ci_dir(capsys, tmp_path / f"dangling-{i}")
        target = layer / target_rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to("never-created.yml")
        code, _, err = run(capsys, ["ci", "--root", str(layer), "--provider", provider])
        assert code == 2, f"{provider}: dangling target refused"
        assert "refusing to write through a symlink that escapes the target" in err
        assert not (target.parent / "never-created.yml").exists(), (
            f"{provider}: the dangling link's destination is never created"
        )
        assert target.is_symlink(), f"{provider}: the planted link is left exactly as it was"


def test_ci_gitlab_refuses_a_standing_entry_that_is_not_a_regular_file(
    capsys, tmp_path: Path
) -> None:
    # The merge reads the bytes it is about to rewrite through the verified read, so a
    # target that is not a regular file is the same hard refusal a write to it would be,
    # reported in the SDK's own words rather than as an OS read error.
    layer = _seeded_ci_dir(capsys, tmp_path)
    (layer / "inside-dir").mkdir()
    (layer / ".gitlab-ci.yml").symlink_to(layer / "inside-dir")
    code, _, err = run(capsys, ["ci", "--root", str(layer), "--provider", "gitlab"])
    assert code == 2
    assert "refusing to write through a symlink that escapes the target" in err
