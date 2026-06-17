"""CLI-level tests mirroring packages/sdk/test/cli.test.ts."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from leji.cli import main

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"
FIXTURES = REPO_ROOT / "fixtures"


def run_cli(capsys, argv: list[str]) -> tuple[int, str, str]:
    code = main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_version_prints_sdk_version() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "leji.cli", "--version"], capture_output=True, text=True
    )
    assert result.returncode == 0
    assert result.stdout.strip().count(".") == 2


def test_no_command_shows_usage_exits_2(capsys) -> None:
    code, out, _ = run_cli(capsys, [])
    assert code == 2
    assert "usage" in out.lower()


def test_unknown_command_exits_2() -> None:
    with pytest.raises(SystemExit) as exc:
        main(["frobnicate"])
    assert exc.value.code == 2


def test_unknown_flag_exits_2() -> None:
    with pytest.raises(SystemExit) as exc:
        main(["validate", "--frobnicate"])
    assert exc.value.code == 2


def test_validate_json_emits_stable_shape(capsys) -> None:
    code, out, _ = run_cli(
        capsys, ["validate", "--root", str(FIXTURES / "invalid-bad-decision"), "--json"]
    )
    assert code == 1
    payload = json.loads(out)
    assert payload["command"] == "validate"
    assert payload["ok"] is False
    assert payload["summary"]["errors"] == 2
    for f in payload["findings"]:
        assert f["rule"] and f["severity"] and f["message"]


def test_index_check_json_reports_staleness(capsys) -> None:
    code, out, _ = run_cli(
        capsys, ["index", "--check", "--root", str(FIXTURES / "invalid-stale-index"), "--json"]
    )
    assert code == 1
    assert json.loads(out)["stale"] is True


def test_changelog_without_subcommand_exits_2(capsys) -> None:
    code, _, err = run_cli(capsys, ["changelog"])
    assert code == 2
    assert "usage" in err.lower()


def test_changelog_check_strict_makes_unverifiable_error(tmp_path, capsys) -> None:
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    code, out, _ = run_cli(capsys, ["changelog", "check", "--root", str(layer)])
    assert code == 0
    assert "changelog-unverifiable" in out
    code, _, _ = run_cli(capsys, ["changelog", "check", "--root", str(layer), "--strict"])
    assert code == 1


def test_freshness_json_carries_lists(capsys) -> None:
    code, out, _ = run_cli(capsys, ["freshness", "--root", str(EXAMPLE), "--json"])
    assert code == 0
    payload = json.loads(out)
    assert payload["declared"] == 1
    assert payload["expired"] == []
    assert payload["upcoming"] == []


def test_rejects_undeclared_flags() -> None:
    # Per-command flag surface from cli.json: a flag not declared for the command is
    # a usage error (exit 2). argparse enforces this natively.
    for argv in (
        ["validate", "--strict"],
        ["validate", "--check"],
        ["validate", "--serve"],
        ["conformance", "--strict"],
        ["index", "--serve"],
    ):
        with pytest.raises(SystemExit) as exc:
            main([*argv, "--root", str(EXAMPLE)])
        assert exc.value.code == 2


def test_conformance_json_carries_items(capsys) -> None:
    code, out, _ = run_cli(capsys, ["conformance", "--root", str(EXAMPLE), "--json"])
    assert code == 0
    payload = json.loads(out)
    assert payload["claimedLevel"] == "indexed"
    assert payload["verifiedLevel"] == "indexed"
    ids = [i["id"] for i in payload["items"]]
    for item_id in [
        "manifest-valid",
        "git",
        "boot-profile",
        "categories",
        "owner",
        "vendor-redirects",
        "index-current",
        "changelog",
        "review-gate",
        "agent-profiles",
        "ci-validates",
        "freshness-declared",
        "consumed-externally",
        "stale-pin-reporting",
        "sibling-mounts",
    ]:
        assert item_id in ids, f"checklist item {item_id} present"


def test_init_interactive_prompts(tmp_path, monkeypatch, capsys) -> None:
    answers = iter(
        [
            "acme-context",
            "Acme layer.",
            "context/",
            "Jo",
            "jo@acme.example",
            "y",
            "n",
            "n",
            "n",
            "y",
        ]
    )
    monkeypatch.setattr("builtins.input", lambda _prompt: next(answers))
    code, _, _ = run_cli(capsys, ["init", "--dir", str(tmp_path)])
    assert code == 0
    manifest = json.loads((tmp_path / "leji.json").read_text())
    assert manifest["name"] == "acme-context"
    assert manifest["rootPath"] == "context/"
    assert manifest["conformance"]["claimedLevel"] == "indexed"
    assert list(manifest["categories"]) == ["domain", "decisions"]
    assert (tmp_path / "context" / "context-index.json").is_file()
    code, _, _ = run_cli(capsys, ["validate", "--root", str(tmp_path)])
    assert code == 0


def test_init_refusal_exits_2(tmp_path, capsys) -> None:
    assert run_cli(capsys, ["init", "--dir", str(tmp_path), "--yes"])[0] == 0
    code, _, err = run_cli(capsys, ["init", "--dir", str(tmp_path), "--yes"])
    assert code == 2
    assert "refuses to overwrite" in err


def test_index_generate_writes_and_reports(tmp_path, capsys) -> None:
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    code, out, _ = run_cli(capsys, ["index", "--root", str(layer), "--json"])
    assert code == 0
    payload = json.loads(out)
    assert payload["written"] == "docs/context-index.json"
    assert payload["entries"] == 3


def test_conformance_marks_failing_core_items(capsys) -> None:
    code, out, _ = run_cli(
        capsys, ["conformance", "--root", str(FIXTURES / "invalid-missing-boot-profile"), "--json"]
    )
    assert code == 1
    payload = json.loads(out)
    boot = next(i for i in payload["items"] if i["id"] == "boot-profile")
    assert boot["status"] == "fail"
    assert payload["verifiedLevel"] == "none"

    _, out, _ = run_cli(
        capsys, ["conformance", "--root", str(FIXTURES / "invalid-vendor-no-redirect"), "--json"]
    )
    item = next(i for i in json.loads(out)["items"] if i["id"] == "vendor-redirects")
    assert item["status"] == "fail"


def test_init_forces_domain_when_both_declined(tmp_path, monkeypatch, capsys) -> None:
    answers = iter(["", "", "", "Jo", "", "n", "n", "n", "n", "n"])
    monkeypatch.setattr("builtins.input", lambda _prompt: next(answers))
    code, _, _ = run_cli(capsys, ["init", "--dir", str(tmp_path)])
    assert code == 0
    manifest = json.loads((tmp_path / "leji.json").read_text())
    assert "domain" in manifest["categories"]


def test_clijson_documents_exactly_the_accepted_commands(capsys, tmp_path) -> None:
    import tempfile

    cli = json.loads((REPO_ROOT / "packages" / "sdk" / "cli.json").read_text())
    documented = sorted(c["name"] for c in cli["commands"])
    # Each runs against a fresh empty dir so init bootstraps cleanly while the
    # read commands report a missing manifest, never a usage error.
    for name in documented:
        d = tempfile.mkdtemp(prefix="leji-cmd-")
        argv = name.split(" ") + ["--root", d]
        if name == "init":
            argv.append("--yes")  # init prompts otherwise
        code = main(argv)
        capsys.readouterr()
        assert code != 2, f'"{name}" should not be a usage error'
    # The documented set matches the canonical command list.
    assert documented == [
        "changelog check",
        "conformance",
        "docs",
        "freshness",
        "index",
        "init",
        "validate",
    ]
