"""Two halves of one contract. First the constants: every level rendered and
byte-compared against `fixtures/badge/`, the sole oracle, plus the `--out` acceptance
table, the existing-file rule, and the containment matrix over temp trees. Then the
shared fixtures' `badge` blocks, driven through the real CLI entry point.

Mirrors packages/sdk/test/badge.test.ts.
"""

from __future__ import annotations

import json
import re
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import pytest

from helpers.snapshot import snapshot_tree
from leji import badge_markdown, badge_run, render_badge
from leji.cli import main

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"
GOLDEN_DIR = FIXTURES / "badge"

LEVELS = ["core", "indexed", "governed", "federated"]


def _committed_fixture(name: str) -> Path:
    """A committed working copy of a fixture: the level a badge states needs a git
    baseline, since the `indexed` changelog item is `unknown` until the changelog is in
    HEAD (`fixtures/README.md` -> "The `badge` block"). Under the OS temp directory
    rather than pytest's, whose paths are long enough to exceed the unix-socket path
    limit the containment tests bind at."""
    directory = Path(tempfile.mkdtemp(prefix="leji-badge-")).resolve()
    shutil.copytree(FIXTURES / name, directory, dirs_exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=directory, check=True)
    subprocess.run(["git", "add", "-A"], cwd=directory, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Badge Test",
            "-c",
            "user.email=badge@example.com",
            "commit",
            "-q",
            "-m",
            "seed",
        ],
        cwd=directory,
        check=True,
    )
    return directory


def _run_cli(capsys, args: list[str]) -> tuple[int, str]:
    """The CLI entry point as the bin runs it: the exit code and what it wrote to
    stdout."""
    code = main(args)
    return code, capsys.readouterr().out


def _bind_socket(target: Path) -> socket.socket:
    """A unix socket standing at `target`. The caller skips the test when the platform
    cannot bind one."""
    if not hasattr(socket, "AF_UNIX"):
        pytest.skip("this platform has no unix sockets")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        server.bind(str(target))
    except OSError as error:
        server.close()
        pytest.skip(f"this platform cannot bind a unix socket at {target}: {error}")
    return server


def _finding_keys(findings) -> list[dict]:
    """A finding as `fixtures/README.md` -> "Matching rules" compares one: the triple
    (rule, severity, path). Message text is implementation-specific and is never
    compared."""
    out = []
    for f in findings:
        if isinstance(f, dict):
            out.append({"rule": f["rule"], "severity": f["severity"], "path": f.get("path")})
        else:
            out.append({"rule": f.rule, "severity": f.severity, "path": f.path})
    return out


# --- the canonical bytes ------------------------------------------------------


def test_every_level_renders_the_canonical_badge_byte_for_byte() -> None:
    for level in LEVELS:
        assert render_badge(level) == (GOLDEN_DIR / f"{level}.svg").read_text(encoding="utf-8"), (
            f"{level}.svg differs from the golden"
        )
        assert badge_markdown(level, "leji-badge.svg") == (GOLDEN_DIR / f"{level}.md").read_text(
            encoding="utf-8"
        ), f"{level}.md differs from the golden"


def test_the_claim_is_structural_not_drawn() -> None:
    for level in LEVELS:
        claim = f"Leji 1.0 · {level} · self-attested"
        # The markdown fixture — the alt text an adopter pastes into a README — carries
        # the whole claim, which is what lets the face drop it.
        md = (GOLDEN_DIR / f"{level}.md").read_text(encoding="utf-8")
        assert f"[![{claim}]" in md, f"{level}.md must carry the full alt claim"

        svg = (GOLDEN_DIR / f"{level}.svg").read_text(encoding="utf-8")
        assert f"<title>{claim}</title>" in svg, f"{level}.svg <title> must carry the claim"
        assert f'aria-label="{claim}"' in svg, f"{level}.svg aria-label must carry the claim"

        # The visible segment is the level alone: the two `<text>` bodies are the
        # wordmark and the level, and `self-attested` appears nowhere a renderer draws.
        drawn = re.findall(r"<text\b[^>]*>([^<]*)</text>", svg)
        assert drawn == ["Leji 1.0", level], (
            f"{level}.svg draws the wordmark and the level, and nothing else"
        )


def test_the_markdown_carries_the_canonical_out_value_not_the_default() -> None:
    assert badge_markdown("governed", "docs/badge.svg") == (
        "[![Leji 1.0 · governed · self-attested](docs/badge.svg)](https://leji.org/agent-ready/)\n"
    )


# --- the `--out` acceptance rule ----------------------------------------------


def test_out_accepts_a_repository_relative_posix_svg_path_and_rejects_everything_else() -> None:
    directory = _committed_fixture("valid-badge-governed")
    try:
        # Accepted, with the canonical POSIX form echoed back: a `.` segment is dropped,
        # and a nested target has its parent directories created.
        for given, canonical in [
            ("leji-badge.svg", "leji-badge.svg"),
            ("./badge.svg", "badge.svg"),
            ("docs/badge.svg", "docs/badge.svg"),
            ("a/b/c-1_2.svg", "a/b/c-1_2.svg"),
        ]:
            r = badge_run(str(directory), given)
            assert r.usage_error is None, f"{given} must be accepted"
            assert r.out == canonical, f"{given} canonicalizes to {canonical}"
            assert directory.joinpath(*canonical.split("/")).exists(), f"{canonical} was written"
        # Rejected at argument parsing, before conformance runs: no level is reported at
        # all, and nothing is written.
        for bad in [
            "/abs.svg",
            "../x.svg",
            "docs/../x.svg",
            "a\\b.svg",
            "x.png",
            "x.svg ",
            "a//b.svg",
            "doc s/x.svg",
            "x.svg#frag",
            ".leji/x.svg",
            ".leji/dist/x.svg",
            ".leji/a/b/x.svg",
        ]:
            r = badge_run(str(directory), bad)
            assert r.usage_error is not None, f"{bad} must be rejected"
            assert r.out is None
            assert r.level is None
            assert r.claimed_level is None, f"{bad} reports no level"
            assert r.verified_level is None, f"{bad} reports no level"
        # A directory at the target is a rejection too, and the directory survives it.
        (directory / "adir.svg").mkdir()
        assert badge_run(str(directory), "adir.svg").usage_error is not None, (
            "a directory is never a badge target"
        )
        assert (directory / "adir.svg").is_dir()
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# --- the existing-file rule ---------------------------------------------------


def test_the_target_file_decides_the_action_by_its_bytes_and_nothing_else() -> None:
    directory = _committed_fixture("valid-badge-governed")
    target = directory / "leji-badge.svg"
    try:
        # Absent: written.
        assert badge_run(str(directory)).action == "wrote"
        assert target.read_text(encoding="utf-8") == render_badge("governed")

        # These exact bytes: unchanged, and not rewritten (the mtime stands).
        before = target.stat().st_mtime_ns
        assert badge_run(str(directory)).action == "unchanged"
        assert target.stat().st_mtime_ns == before, "an unchanged target is never rewritten"

        # Another canonical badge of this contract: overwritten, which is how a level
        # change regenerates. All three of the others, not just the neighbouring one.
        for level in [lv for lv in LEVELS if lv != "governed"]:
            target.write_text(render_badge(level), encoding="utf-8")
            assert badge_run(str(directory)).action == "overwrote", (
                f"a stale {level} badge regenerates"
            )
            assert target.read_text(encoding="utf-8") == render_badge("governed")

        # Anything else: refused, exit 2's message, the file untouched and never
        # truncated. The levels are still reported, the rule running after conformance.
        foreign = "<svg><!-- somebody elses file --></svg>\n"
        target.write_text(foreign, encoding="utf-8")
        r = badge_run(str(directory))
        assert r.refusal == "leji-badge.svg exists and is not a leji badge; remove or rename it"
        assert r.out is None
        assert r.action is None
        assert r.claimed_level == "governed"
        assert r.verified_level == "governed"
        assert target.read_text(encoding="utf-8") == foreign, (
            "a refusal never edits and never truncates"
        )
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_a_nested_out_creates_its_parent_directories_only_when_the_write_happens() -> None:
    directory = _committed_fixture("valid-records")  # claims core, verifies core
    try:
        (directory / "leji-badge.svg").write_text("not a badge\n", encoding="utf-8")
        assert badge_run(str(directory), "docs/nested/badge.svg").out is not None
        assert (directory / "docs" / "nested" / "badge.svg").exists()
        # The refusal path writes nothing, so it establishes no directory either.
        assert badge_run(str(directory), "leji-badge.svg").refusal is not None
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_a_run_that_writes_nothing_establishes_no_directory_on_the_way_to_not_writing() -> None:
    # Exit 1 (a claim this run refutes): the nested target and its parent are both absent
    # afterwards, so the directory is a consequence of the write and not of the attempt.
    failing = _committed_fixture("invalid-governed-no-profile")
    try:
        r = badge_run(str(failing), "pub/x/badge.svg")
        assert r.out is None
        assert r.action is None
        assert any(f.severity == "error" for f in r.findings)
        assert not (failing / "pub" / "x" / "badge.svg").exists(), "the target was never created"
        assert not (failing / "pub" / "x").exists(), "the parent was never created"
        assert not (failing / "pub").exists(), "nor its parent"
    finally:
        shutil.rmtree(failing, ignore_errors=True)

    # Exit 2 (a foreign file at a nested target whose parent already exists): the parent
    # is left exactly as it was and the target's bytes are untouched.
    directory = _committed_fixture("valid-badge-governed")
    try:
        parent = directory / "pub"
        parent.mkdir()
        (parent / "sibling.txt").write_text("untouched\n", encoding="utf-8")
        foreign = "not a badge\n"
        (parent / "badge.svg").write_text(foreign, encoding="utf-8")
        before = snapshot_tree(directory)
        r = badge_run(str(directory), "pub/badge.svg")
        assert r.refusal == "pub/badge.svg exists and is not a leji badge; remove or rename it"
        assert (parent / "badge.svg").read_text(encoding="utf-8") == foreign, (
            "the target is byte-untouched"
        )
        assert snapshot_tree(directory) == before, "the tree is untouched"
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# --- containment: the resolved path decides, in both directions -----------------


def test_an_out_whose_parent_resolves_outside_the_repository_is_refused_and_reads_nothing() -> None:
    outside = Path(tempfile.mkdtemp(prefix="leji-outside-")).resolve()
    directory = _committed_fixture("valid-badge-governed")
    try:
        # A file already standing at the escaped location: the run must neither read it
        # (it is not the target the check cleared) nor replace it.
        planted = "somebody elses file\n"
        (outside / "x.svg").write_text(planted, encoding="utf-8")
        (directory / "pub").symlink_to(outside, target_is_directory=True)
        before = snapshot_tree(directory)

        r = badge_run(str(directory), "pub/x.svg")
        assert r.usage_error is not None or r.refusal is not None, "the escape is refused"
        assert r.out is None
        assert r.action is None
        assert (outside / "x.svg").read_text(encoding="utf-8") == planted, (
            "the outside file is untouched"
        )
        assert sorted(p.name for p in outside.iterdir()) == ["x.svg"], (
            "nothing was created outside the repository"
        )
        assert snapshot_tree(directory) == before, "and nothing inside it"
    finally:
        shutil.rmtree(directory, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


def test_an_out_whose_parent_resolves_into_leji_is_refused_at_any_depth() -> None:
    directory = _committed_fixture("valid-badge-governed")
    try:
        (directory / ".leji" / "dist").mkdir(parents=True, exist_ok=True)
        (directory / "pub").symlink_to(directory / ".leji" / "dist", target_is_directory=True)
        r = badge_run(str(directory), "pub/x.svg")
        assert r.usage_error is not None or r.refusal is not None, ".leji/ is never a badge target"
        assert r.out is None
        assert list((directory / ".leji" / "dist").iterdir()) == [], "the private role stays empty"
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_an_out_that_is_itself_a_symlink_out_of_the_repository_is_refused() -> None:
    outside = Path(tempfile.mkdtemp(prefix="leji-outside-")).resolve()
    directory = _committed_fixture("valid-badge-governed")
    try:
        planted = "somebody elses file\n"
        escaped = outside / "foreign.svg"
        escaped.write_text(planted, encoding="utf-8")
        (directory / "leji-badge.svg").symlink_to(escaped)

        r = badge_run(str(directory))
        assert r.usage_error is not None or r.refusal is not None, (
            "a link out of the repository is refused"
        )
        assert r.out is None
        assert r.action is None
        assert escaped.read_text(encoding="utf-8") == planted, "the link target is byte-untouched"
        assert (directory / "leji-badge.svg").is_symlink(), "the link itself is left alone"
    finally:
        shutil.rmtree(directory, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


def test_an_out_that_is_a_dangling_symlink_inside_the_repository_is_refused() -> None:
    directory = _committed_fixture("valid-badge-governed")
    try:
        # The link resolves to a missing file INSIDE the repository, so the resolved
        # destination is absent while the entry at the target path is not. A write would
        # follow the link and create the destination; a standing entry that could not be
        # verified as a badge is a refusal instead.
        (directory / "leji-badge.svg").symlink_to("missing-file.svg")
        before = snapshot_tree(directory)

        r = badge_run(str(directory))
        assert r.refusal == (
            "leji-badge.svg does not resolve to a regular file inside the repository; "
            "nothing was written"
        ), "a dangling in-repository link is refused, not written through"
        assert r.out is None
        assert r.action is None
        assert _finding_keys(r.findings) == [
            {"rule": "badge-target-refused", "severity": "error", "path": "leji-badge.svg"}
        ]
        assert (directory / "leji-badge.svg").is_symlink(), "the link itself is left alone"
        assert not (directory / "missing-file.svg").exists(), (
            "the link destination was never created"
        )
        assert snapshot_tree(directory) == before, "the tree is untouched"
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_an_out_that_is_a_unix_socket_is_refused_as_a_document_not_as_a_crash(capsys) -> None:
    directory = _committed_fixture("valid-badge-governed")
    target = directory / "leji-badge.svg"
    server: Optional[socket.socket] = None
    try:
        # A socket is the non-regular entry that no earlier check rejects: it is not a
        # directory, and opening it fails with something other than ENOENT. Binding one is
        # not portable, so a platform that cannot is skipped rather than failed.
        server = _bind_socket(target)
        before = snapshot_tree(directory)

        r = badge_run(str(directory))
        assert r.refusal == (
            "leji-badge.svg does not resolve to a regular file inside the repository; "
            "nothing was written"
        ), "a socket at the target is refused, in the same words as every other entry"
        assert r.out is None
        assert r.action is None
        assert _finding_keys(r.findings) == [
            {"rule": "badge-target-refused", "severity": "error", "path": "leji-badge.svg"}
        ]
        assert snapshot_tree(directory) == before, "the tree is untouched"

        # Through the CLI: the refusal is the ordinary badge document at exit 2, which is
        # exactly what an escaping error would deny this case.
        code, stdout = _run_cli(capsys, ["badge", "--root", str(directory), "--json"])
        assert code == 2, "the refusal exits 2"
        doc = json.loads(stdout)
        assert sorted(doc.keys()) == sorted(DOCUMENT_KEYS), "the exact JSON key set"
        assert doc["command"] == "badge"
        assert doc["ok"] is False
        assert doc["out"] is None
        assert doc["level"] is None
        assert doc["markdown"] is None
        assert doc["action"] is None
        assert _finding_keys(doc["findings"]) == [
            {"rule": "badge-target-refused", "severity": "error", "path": "leji-badge.svg"}
        ]
        assert doc["summary"] == {"errors": 1, "warnings": 0}
    finally:
        if server is not None:
            server.close()
        shutil.rmtree(directory, ignore_errors=True)


def test_an_out_symlinked_to_a_unix_socket_is_refused_as_a_document_too(capsys) -> None:
    directory = _committed_fixture("valid-badge-governed")
    target = directory / "leji-badge.svg"
    server: Optional[socket.socket] = None
    try:
        # The link passes an entry-kind check that stops at the link itself, and the
        # verified open then follows it to the socket and fails before it can fstat. So
        # the kind that decides is the one at the END of the link.
        server = _bind_socket(directory / "sock")
        target.symlink_to("sock")
        assert target.is_symlink(), "the target is a symlink"
        before = snapshot_tree(directory)

        r = badge_run(str(directory))
        assert r.refusal == (
            "leji-badge.svg does not resolve to a regular file inside the repository; "
            "nothing was written"
        ), "a link to a socket is refused, in the same words as the socket itself"
        assert r.out is None
        assert r.action is None
        assert _finding_keys(r.findings) == [
            {"rule": "badge-target-refused", "severity": "error", "path": "leji-badge.svg"}
        ]
        assert target.is_symlink(), "the link itself is left alone"
        assert snapshot_tree(directory) == before, "the tree is untouched"

        # Through the CLI: the ordinary badge document at exit 2, not a bare error.
        code, stdout = _run_cli(capsys, ["badge", "--root", str(directory), "--json"])
        assert code == 2, "the refusal exits 2"
        doc = json.loads(stdout)
        assert sorted(doc.keys()) == sorted(DOCUMENT_KEYS), "the exact JSON key set"
        assert doc["command"] == "badge"
        assert doc["ok"] is False
        assert doc["out"] is None
        assert doc["level"] is None
        assert doc["markdown"] is None
        assert doc["action"] is None
        assert _finding_keys(doc["findings"]) == [
            {"rule": "badge-target-refused", "severity": "error", "path": "leji-badge.svg"}
        ]
        assert doc["summary"] == {"errors": 1, "warnings": 0}
    finally:
        if server is not None:
            server.close()
        shutil.rmtree(directory, ignore_errors=True)


# --- the shared fixtures' `badge` blocks --------------------------------------

#: Exactly the keys `--json` emits, under every outcome: a consumer parses one document
#: whether the run wrote a badge, refuted a claim, or refused a file.
DOCUMENT_KEYS = [
    "command",
    "ok",
    "findings",
    "summary",
    "out",
    "level",
    "claimedLevel",
    "verifiedLevel",
    "markdown",
    "action",
]


def _expected(name: str) -> dict:
    return json.loads((FIXTURES / name / "expected.json").read_text(encoding="utf-8"))


BADGE_FIXTURES = sorted(
    p.name
    for p in FIXTURES.iterdir()
    if (p / "expected.json").is_file() and "badge" in _expected(p.name)
)


def _expected_document(block: dict, target_rel: str) -> tuple[list[dict], dict]:
    """The findings and the summary a `badge` block PINS — fixed by the block alone, never
    read off the document being judged, so a different rule, an extra finding or a missing
    one fails. Three outcomes exhaust the block: a success reports nothing; an exit-2
    refusal names the foreign file it would not overwrite; an exit-1 run reports the
    conformance error that left nothing honest to state — the claim gate when this run
    verified a level below the claim, `badge-unverified` when it verified no level."""
    if block["exit"] == 0:
        return [], {"errors": 0, "warnings": 0}
    if block["exit"] == 2:
        refused = {"rule": "badge-target-foreign", "severity": "error", "path": target_rel}
    else:
        refused = {
            "rule": "badge-unverified" if block["verifiedLevel"] is None else "conformance-claim",
            "severity": "error",
            "path": "leji.json",
        }
    return [refused], {"errors": 1, "warnings": 0}


def _assert_badge_document(stdout: str, block: dict, target_rel: str, where: str) -> None:
    """The whole `--json` document against the block: the exact key set, and every value
    the block fixes — including the findings and the summary, pinned above rather than
    derived from the document, which is what makes a wrong rule or a stray finding fail
    here. The summary's exact key set, its agreement with the findings beside it, and
    `ok`'s agreement with both follow from comparing the pinned pair, so they are asserted
    by that comparison and not again."""
    doc = json.loads(stdout)
    assert sorted(doc.keys()) == sorted(DOCUMENT_KEYS), f"{where}: the exact JSON key set"
    assert doc["command"] == "badge", f"{where}: command"
    assert doc["out"] == block["out"], f"{where}: out"
    assert doc["level"] == block["level"], f"{where}: level"
    assert doc["claimedLevel"] == block["claimedLevel"], f"{where}: claimedLevel"
    assert doc["verifiedLevel"] == block["verifiedLevel"], f"{where}: verifiedLevel"
    assert doc["action"] == block["action"], f"{where}: action"
    expected_markdown = (
        None
        if block["level"] is None or block["out"] is None
        else badge_markdown(block["level"], block["out"])
    )
    assert doc["markdown"] == expected_markdown, f"{where}: markdown"
    assert doc["ok"] is (block["exit"] == 0), f"{where}: ok tracks the exit code"
    findings, summary = _expected_document(block, target_rel)
    assert _finding_keys(doc["findings"]) == findings, (
        f"{where}: the exact findings, on (rule, severity, path)"
    )
    assert doc["summary"] == summary, f"{where}: the literal summary"


def test_an_out_usage_error_exits_2_and_emits_no_json_document_at_all(capsys) -> None:
    directory = _committed_fixture("valid-badge-governed")
    try:
        for bad in ["x.png", "../x.svg", "/abs.svg", ".leji/x.svg"]:
            code, stdout = _run_cli(
                capsys, ["badge", "--root", str(directory), "--json", "--out", bad]
            )
            assert code == 2, f"{bad} is a usage error"
            assert stdout.strip() == "", f"{bad} writes nothing to stdout, so no level"
        assert not (directory / "leji-badge.svg").exists(), "and nothing was written"
    finally:
        shutil.rmtree(directory, ignore_errors=True)


@pytest.mark.parametrize("name", BADGE_FIXTURES)
def test_fixture_badge_block(name: str, capsys) -> None:
    block = _expected(name)["badge"]
    directory = _committed_fixture(name)
    try:
        preseed = block.get("preseed")
        target_rel = (preseed or {}).get("path") or block["out"] or "leji-badge.svg"
        target = directory.joinpath(*target_rel.split("/"))
        if preseed:
            planted_bytes = (
                FIXTURES.joinpath(*preseed["from"].split("/")).read_bytes()
                if preseed.get("from")
                else preseed.get("bytes", "").encode("utf-8")
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(planted_bytes)
        planted = target.read_bytes() if preseed else None

        args = block.get("args") or ["badge"]
        code, stdout = _run_cli(capsys, [*args, "--root", str(directory), "--json"])
        assert code == block["exit"], f"exit code for {name}: {stdout}"
        # The document carries every outcome, refusals included: `ok:false` and the rule
        # that refused, at the target path, are pinned inside it.
        _assert_badge_document(stdout, block, target_rel, f"{name} (first run)")

        if block["golden"] is not None:
            golden = FIXTURES.joinpath(*block["golden"].split("/")).read_bytes()
            written = directory.joinpath(*block["out"].split("/")).read_bytes()
            assert written == golden, "the written bytes"
        # `written: false` is two claims in one: the target does not exist after the run,
        # or — when `preseed` planted it — its planted bytes are still there.
        if block.get("written") is False:
            if planted is None:
                assert not target.exists(), f"{target_rel} was never created"
            else:
                assert target.read_bytes() == planted, f"{target_rel} is byte-untouched"

        rerun = block.get("rerun")
        if rerun:
            after_first = snapshot_tree(directory)
            code, stdout = _run_cli(capsys, [*args, "--root", str(directory), "--json"])
            assert code == 0, "the steady state exits 0"
            # The whole document again, not just `action`: the steady state is the same
            # run reported the same way, with the write already done.
            _assert_badge_document(
                stdout, {**block, "action": rerun["action"]}, target_rel, f"{name} (rerun)"
            )
            if rerun["byteIdentical"]:
                assert snapshot_tree(directory) == after_first, (
                    "a second run is a byte-level no-op across the whole working tree"
                )
    finally:
        shutil.rmtree(directory, ignore_errors=True)
