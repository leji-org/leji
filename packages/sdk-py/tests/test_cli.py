"""CLI-level tests mirroring packages/sdk/test/cli.test.ts."""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from leji.cli import main
from leji.schemas import load_cli_spec

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"
FIXTURES = REPO_ROOT / "fixtures"


def _snapshot(d: Path) -> dict[str, str]:
    """Content hash of every file under d (excluding .git): relpath -> sha256."""
    out: dict[str, str] = {}
    for p in sorted(d.rglob("*")):
        if ".git" in p.parts or not p.is_file():
            continue
        out[str(p.relative_to(d))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


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


def test_version_flag_aliases(capsys) -> None:
    # --version and lowercase -v print the version and exit 0.
    expected_code, expected_out, _ = run_cli(capsys, ["--version"])
    code, out, _ = run_cli(capsys, ["-v"])
    assert code == expected_code == 0
    assert out == expected_out
    # -V was removed (no --verbose to guard against); it is no longer a version flag.
    code, _, _ = run_cli(capsys, ["-V"])
    assert code == 2


def test_v_flag_short_circuits_command(capsys, tmp_path) -> None:
    # `init -v` prints the version and must not scaffold (no side effects).
    code, out, _ = run_cli(capsys, ["init", "--dir", str(tmp_path), "-v"])
    assert code == 0
    assert out.strip().count(".") == 2
    assert not (tmp_path / "leji.json").exists()


def test_index_auto_seeds_changelog_when_indexed(capsys, tmp_path) -> None:
    run_cli(capsys, ["init", "--dir", str(tmp_path), "--yes", "--name", "demo-context"])
    cl = tmp_path / "docs" / "context-changelog.json"
    assert not cl.exists()  # core init writes no changelog
    mp = tmp_path / "leji.json"
    mp.write_text(mp.read_text().replace('"claimedLevel": "core"', '"claimedLevel": "indexed"'))
    code, out, _ = run_cli(capsys, ["index", "--root", str(tmp_path), "--json"])
    assert code == 0
    assert json.loads(out)["changelog"] == "docs/context-changelog.json"
    assert cl.exists()
    # A second run must not re-seed (never overwrites an existing changelog).
    _, out2, _ = run_cli(capsys, ["index", "--root", str(tmp_path), "--json"])
    assert "changelog" not in json.loads(out2)


def test_index_does_not_seed_changelog_on_core_layer(capsys, tmp_path) -> None:
    run_cli(capsys, ["init", "--dir", str(tmp_path), "--yes", "--name", "demo-context"])
    _, out, _ = run_cli(capsys, ["index", "--root", str(tmp_path), "--json"])
    assert "changelog" not in json.loads(out)
    assert not (tmp_path / "docs" / "context-changelog.json").exists()


def test_index_refuses_symlinked_ancestor_escape(capsys, tmp_path) -> None:
    # writeIndex must refuse to write through a symlinked ancestor that escapes
    # the layer root (the H1 fix). Point machine.indexPath under docs/evil, a
    # symlink to an outside dir, and assert the escape is reported, exit 1, and
    # nothing lands outside the root.
    outside = tmp_path / "outside"
    outside.mkdir()
    layer = tmp_path / "layer"
    layer.mkdir()
    run_cli(capsys, ["init", "--dir", str(layer), "--yes", "--level", "indexed", "--name", "demo"])
    (layer / "docs" / "evil").symlink_to(outside, target_is_directory=True)
    mp = layer / "leji.json"
    manifest = json.loads(mp.read_text())
    machine = manifest.get("machine") or {}
    machine["indexPath"] = "docs/evil/context-index.json"
    manifest["machine"] = machine
    mp.write_text(json.dumps(manifest, indent=2) + "\n")
    code, out, err = run_cli(capsys, ["index", "--root", str(layer), "--json"])
    assert code == 1, out + err
    assert "resolves outside the layer root" in (out + err)
    assert not (outside / "context-index.json").exists()


def test_no_command_shows_usage_exits_2(capsys) -> None:
    code, out, _ = run_cli(capsys, [])
    assert code == 2
    assert "usage" in out.lower()


def test_unknown_command_exits_2(capsys) -> None:
    # Mirrors the Node CLI: the cli.json usage is printed to stderr (not argparse's).
    code, _, err = run_cli(capsys, ["frobnicate"])
    assert code == 2
    assert 'unknown command "frobnicate"' in err
    assert "Usage: leji <command> [options]" in err


def test_unknown_flag_exits_2() -> None:
    # A flag not declared for the command is a usage error (exit 2), rejected by
    # the cli.json-driven allowed-flags path (parity with Node/Go).
    assert main(["validate", "--frobnicate"]) == 2


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


def test_changelog_compact_without_flags_exits_2(capsys) -> None:
    code, _, err = run_cli(capsys, ["changelog", "compact", "--root", str(EXAMPLE)])
    assert code == 2
    assert "changelog compact requires --keep or --before" in err


def test_changelog_compact_keep_folds_oldest_and_reports_counts(tmp_path, capsys) -> None:
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    code, out, _ = run_cli(
        capsys, ["changelog", "compact", "--keep", "1", "--root", str(layer), "--json"]
    )
    assert code == 0, out
    payload = json.loads(out)
    assert payload["folded"] == 1  # example has 2 entries; keep newest 1
    assert payload["kept"] == 2  # 1 survivor + the compaction entry
    log = json.loads((layer / "docs" / "context-changelog.json").read_text())
    assert log["entries"][-1]["type"] == "compaction"


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
    # a usage error (exit 2), rejected by the cli.json-driven allowed-flags path.
    for argv in (
        ["validate", "--strict"],
        ["validate", "--check"],
        ["validate", "--open"],
        ["conformance", "--strict"],
        ["index", "--open"],
    ):
        assert main([*argv, "--root", str(EXAMPLE)]) == 2


def test_init_and_adopt_accept_global_json_flag(tmp_path, capsys) -> None:
    # --json is a global flag every command accepts; for init/adopt it is a
    # no-op but must not be a usage error (cross-SDK parity with Node/Go).
    init_dir = tmp_path / "init"
    init_dir.mkdir()
    assert run_cli(capsys, ["init", "--dir", str(init_dir), "--yes", "--json"])[0] == 0
    adopt_dir = tmp_path / "adopt"
    adopt_dir.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=adopt_dir, check=True)
    assert run_cli(capsys, ["adopt", "--dir", str(adopt_dir), "--yes", "--json"])[0] == 0


def test_adopt_rejects_name_flag_exits_2() -> None:
    # adopt does not declare --name (parity with Node/Go); it is a usage error.
    assert main(["adopt", "--name", "x", "--yes"]) == 2


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
        if name in ("init", "adopt"):
            argv.append("--yes")  # these prompt otherwise
        elif name == "changelog compact":
            argv += ["--keep", "1"]  # compact requires --keep or --before
        elif name == "agent":
            argv += ["--host", "codex", "--name", "reviewer"]  # agent requires both
        code = main(argv)
        capsys.readouterr()
        assert code != 2, f'"{name}" should not be a usage error'
    # The documented set matches the canonical command list.
    assert documented == [
        "adopt",
        "agent",
        "changelog check",
        "changelog compact",
        "ci",
        "conformance",
        "detect",
        "freshness",
        "index",
        "init",
        "start",
        "validate",
        "view",
        "viewer",
        "viewer build",
        "viewer serve",
    ]


# --- Filesystem-mutation invariant ------------------------------------------
# Only write-intent commands (init, adopt, index, viewer) may touch the filesystem.
# Read/analysis commands, and any command invoked with a --help/--version meta-
# flag, must leave the working tree unchanged. Regression guard for the bug where
# `leji adopt --help` ran adopt and scaffolded files instead of printing help.

_READ_COMMANDS = [
    ["validate"],
    ["conformance"],
    ["freshness"],
    ["detect"],
    ["index", "--check"],
    ["changelog", "check"],
]

_DOCUMENTED = [c["name"] for c in load_cli_spec()["commands"]]


@pytest.mark.parametrize("argv", _READ_COMMANDS, ids=lambda a: " ".join(a))
def test_read_commands_do_not_write(tmp_path, monkeypatch, capsys, argv):
    shutil.copytree(EXAMPLE, tmp_path, dirs_exist_ok=True)
    before = _snapshot(tmp_path)
    monkeypatch.chdir(tmp_path)
    main(list(argv))
    capsys.readouterr()
    assert _snapshot(tmp_path) == before, f"{' '.join(argv)} modified the filesystem"


@pytest.mark.parametrize("meta", ["--help", "--version"])
@pytest.mark.parametrize("name", _DOCUMENTED)
def test_meta_flags_never_write(tmp_path, monkeypatch, capsys, name, meta):
    (tmp_path / "README.md").write_text("# sandbox\n")
    before = _snapshot(tmp_path)
    monkeypatch.chdir(tmp_path)
    code = main([*name.split(" "), meta])
    out = capsys.readouterr().out
    assert code == 0, f"{name} {meta} exit {code}"
    if meta == "--help":
        assert "Usage: leji" in out
    else:
        assert out.strip().count(".") == 2
    assert _snapshot(tmp_path) == before, f"{name} {meta} wrote files"


@pytest.mark.parametrize("cmd", ["init", "adopt"])
def test_dry_run_never_writes(tmp_path, monkeypatch, capsys, cmd):
    (tmp_path / "README.md").write_text("# sandbox\n")
    before = _snapshot(tmp_path)
    monkeypatch.chdir(tmp_path)
    main([cmd, "--dry-run", "--yes"])
    capsys.readouterr()
    assert _snapshot(tmp_path) == before, f"{cmd} --dry-run wrote files"


def test_init_writes_proving_detector(tmp_path, monkeypatch, capsys):
    # Positive control: a real write-intent run DOES change the tree, proving the
    # snapshot detector can actually see writes.
    (tmp_path / "README.md").write_text("# sandbox\n")
    before = _snapshot(tmp_path)
    monkeypatch.chdir(tmp_path)
    code = main(["init", "--yes"])
    capsys.readouterr()
    assert code == 0
    assert _snapshot(tmp_path) != before, "init --yes should have written files"


def test_viewer_prints_serve_hint(tmp_path, capsys) -> None:
    # The serve hint must match the Node/Python/Go SDKs byte-for-byte (parity).
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    code, out, _ = run_cli(capsys, ["viewer", "--root", str(layer)])
    assert code == 0, out
    assert "serve locally: leji view" in out


def test_viewer_rejects_open(tmp_path, capsys) -> None:
    # --open belongs to `viewer serve`/`view`, not bare `viewer` (which only
    # generates): it must be a usage error, not silently accepted.
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    assert main(["viewer", "--open", "--root", str(layer)]) == 2


def test_viewer_bad_subcommand_is_usage_error(tmp_path, capsys) -> None:
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    code, out, err = run_cli(capsys, ["viewer", "frobnicate", "--root", str(layer)])
    assert code == 2
    assert "usage: leji viewer [serve|build]" in (out + err)


def test_viewer_build_exports_static_folder(tmp_path, capsys) -> None:
    # `leji viewer build` exports a self-contained static folder carrying the
    # protect warning (mirrors the Node units.test.ts viewer build test).
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    code, out, err = run_cli(capsys, ["viewer", "build", "--out", "out", "--root", str(layer)])
    assert code == 0, err
    assert "Exported the static viewer to out/" in out
    out_dir = layer / "out"
    assert (out_dir / "index.html").exists()
    assert (out_dir / "assets" / "docsify.min.js").exists()
    assert (out_dir / "content" / "boot-profile.md").exists()
    assert (out_dir / "content" / "overview.md").exists()
    assert (out_dir / "content" / "_sidebar.md").exists()
    assert (out_dir / "content" / "domain" / "glossary.md").exists()
    assert not (out_dir / "content" / ".leji").exists()
    html = (out_dir / "index.html").read_text(encoding="utf-8")
    assert html.startswith("<!--")
    assert "Host the exported folder behind internal authentication" in html


def test_view_command_recognized_no_manifest_exits_1(capsys, tmp_path) -> None:
    # `view` (alias for `viewer serve`) must dispatch, not be an unknown command. On
    # a dir with no manifest it returns 1 before binding a server, so it can't hang.
    missing = tmp_path / "no-manifest-here"
    missing.mkdir()
    code, _, _ = run_cli(capsys, ["view", "--root", str(missing)])
    assert code == 1


def test_view_bad_subcommand_is_usage_error(tmp_path, capsys) -> None:
    layer = tmp_path / "layer"
    shutil.copytree(EXAMPLE, layer)
    code, out, err = run_cli(capsys, ["view", "serve", "--root", str(layer)])
    assert code == 2
    assert "usage: leji view" in (out + err)


def test_start_no_manifest_exits_1(capsys, tmp_path) -> None:
    code, out, err = run_cli(capsys, ["start", "--root", str(tmp_path / "no-such-layer")])
    assert code == 1
    assert "manifest-missing" in (out + err) or "no leji.json" in (out + err)


def test_start_on_core_layer_non_tty_falls_back(capsys, tmp_path) -> None:
    # Build a real core layer, then `start` it. Under pytest stdin is not a TTY, so
    # interactive=False: never launch, never hang; print the boot commands, exit 0.
    run_cli(capsys, ["init", "--dir", str(tmp_path), "--yes", "--name", "demo"])
    code, out, err = run_cli(capsys, ["start", "--root", str(tmp_path)])
    assert code == 0, out + err
    assert "To enter this context layer" in out
