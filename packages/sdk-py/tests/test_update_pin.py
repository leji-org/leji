"""`leji mounts update-pin` tests, mirroring packages/sdk/test/update-pin.test.ts.

Three halves of one contract. First the pin-span scanner over its own byte
fixtures — the only artifact here that needs no git at all. Then the two factorings
out of ``leji/mounts.py``, checked against the callers they were taken from. Then the
shared fixtures' ``updatePin`` block, driven through the real CLI as a process over a
scaffold every SDK's harness builds identically (``fixtures/README.md`` -> "The
``updatePin`` block").
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from leji.manifest import load_manifest, replace_mount_pin_in_manifest_text
from leji.mounts import (
    MountDecl,
    compare_pins,
    mount_status,
    normalize_source,
    pin_ref_for,
    retain_pin_in_store,
    select_comparison,
    witness_ref_for,
)
from leji.update_pin import update_pin_run

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"
PIN_SPAN_DIR = FIXTURES / "manifest-pin-span"

# --- the pin-span scanner -----------------------------------------------------

PIN_SPAN_CASES = sorted(p.name for p in PIN_SPAN_DIR.iterdir() if p.is_dir())

_ERROR_PATTERNS = {
    "not-located": r"cannot locate the pin of mount",
    "not-from": r"pin of mount .* is not",
    "duplicate-key": r"duplicate key",
}


@pytest.mark.parametrize("name", PIN_SPAN_CASES)
def test_manifest_pin_span_fixture(name: str) -> None:
    case = json.loads((PIN_SPAN_DIR / name / "case.json").read_text(encoding="utf-8"))
    text = (PIN_SPAN_DIR / name / "input.json").read_text(encoding="utf-8")
    if case["outcome"] == "error":
        with pytest.raises(RuntimeError, match=_ERROR_PATTERNS[case["error"]]):
            replace_mount_pin_in_manifest_text(text, case["mount"], case["from"], case["to"])
        return
    expected = (PIN_SPAN_DIR / name / "expected.json").read_text(encoding="utf-8")
    got, changed = replace_mount_pin_in_manifest_text(text, case["mount"], case["from"], case["to"])
    assert changed is True, f"{name}: the span moved"
    assert got == expected, f"{name}: byte-exact output"
    # Every case is a real manifest before and after: the edit never produces
    # something a parser would reject.
    json.loads(got)
    # And the edit is confined: exactly the pin's own characters differ.
    assert len(got) == len(text) + len(case["to"]) - len(case["from"])


def test_a_duplicate_key_on_the_path_to_the_pin_is_refused_never_resolved() -> None:
    # The two readers of this document disagree: a lexical scan takes the FIRST
    # member, `json.loads` keeps the LAST. Rewriting the first span would report a
    # change that every parser of the result still reads as the old pin.
    case = json.loads((PIN_SPAN_DIR / "error-duplicate-pin" / "case.json").read_text())
    text = (PIN_SPAN_DIR / "error-duplicate-pin" / "input.json").read_text(encoding="utf-8")
    parsed_pin = json.loads(text)["federation"]["mounts"][0]["pin"]
    assert parsed_pin != case["from"], (
        "the parser reads the LAST pin, which is not the span a scan finds first"
    )
    with pytest.raises(RuntimeError, match=r'duplicate key "pin" in mount "product-context"'):
        replace_mount_pin_in_manifest_text(text, case["mount"], case["from"], case["to"])
    # Every key the scanner reads on its way to the pin carries the same rule.
    for fixture, message in (
        ("error-duplicate-federation", r'duplicate key "federation" in the manifest root'),
        ("error-duplicate-mounts", r'duplicate key "mounts" in "federation"'),
        ("error-duplicate-name", r'duplicate key "name" in a federation mount'),
    ):
        other = (PIN_SPAN_DIR / fixture / "input.json").read_text(encoding="utf-8")
        with pytest.raises(RuntimeError, match=message):
            replace_mount_pin_in_manifest_text(other, "product-context", case["from"], case["to"])


def test_the_pin_span_moves_only_for_the_addressed_mount() -> None:
    text = (PIN_SPAN_DIR / "shared-prefix" / "input.json").read_text(encoding="utf-8")
    case = json.loads((PIN_SPAN_DIR / "shared-prefix" / "case.json").read_text())
    # The neighbouring mount's pin is untouched by the move above it.
    moved, _ = replace_mount_pin_in_manifest_text(text, case["mount"], case["from"], case["to"])
    before = json.loads(text)["federation"]["mounts"]
    after = json.loads(moved)["federation"]["mounts"]
    assert after[0]["pin"] == before[0]["pin"]
    assert after[1]["pin"] != before[1]["pin"]
    # `from == to` is a no-op the caller can rely on, not a rewrite of equal bytes.
    same, changed = replace_mount_pin_in_manifest_text(
        text, case["mount"], case["from"], case["from"]
    )
    assert changed is False
    assert same == text


# --- the acme-sibling scaffold ------------------------------------------------

#: The recipe's fixed commit ids. Every field a commit hashes is pinned by the recipe
#: (``fixtures/README.md``), so these are constants, not observations.
OID_A = "6b06fe51a323212156bb267842bf10187ed4c20e"
OID_B = "3ff2a04361ca9d601180037bdfbc8b6c0a0a8723"
OID_S = "50305153f1a107c6871ab3b3047cb4c225603b0c"
OID_O = "0cb1fb59e73d78ff04cf41de7f177ea0fb940002"
ACME_SOURCE = "https://github.com/acme/product-context"
ACME_IDENTITY = normalize_source(ACME_SOURCE)
assert ACME_IDENTITY is not None


def _recipe_env() -> dict[str, str]:
    """Author, committer, date, message and content are all fixed, so every commit id
    the recipe produces is a constant an ``expected.json`` can carry."""
    env = dict(os.environ)
    env.pop("GIT_DIR", None)
    env.update(
        GIT_AUTHOR_NAME="Leji Fixtures",
        GIT_AUTHOR_EMAIL="fixtures@leji.org",
        GIT_COMMITTER_NAME="Leji Fixtures",
        GIT_COMMITTER_EMAIL="fixtures@leji.org",
        GIT_AUTHOR_DATE="2026-01-01T00:00:00 +0000",
        GIT_COMMITTER_DATE="2026-01-01T00:00:00 +0000",
    )
    return env


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", *args],
        cwd=cwd,
        env=_recipe_env(),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _commit(repo: Path, file: str) -> str:
    stem = file[:-3]
    (repo / file).write_text(f"# {stem}\n", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", stem)
    return git(repo, "rev-parse", "HEAD")


def build_acme_sibling(directory: Path) -> None:
    """The ``acme-sibling`` recipe, normative in ``fixtures/README.md``: a -> b on
    main, a side branch off ``a``, and an unrelated orphan branch."""
    directory.mkdir(parents=True, exist_ok=True)
    git(directory, "init", "-q", "-b", "main", ".")
    assert _commit(directory, "a.md") == OID_A, "recipe commit a"
    assert _commit(directory, "b.md") == OID_B, "recipe commit b"
    git(directory, "checkout", "-q", "-b", "side", OID_A)
    assert _commit(directory, "s.md") == OID_S, "recipe commit s"
    git(directory, "checkout", "-q", "--orphan", "other")
    git(directory, "rm", "-q", "-rf", ".")
    assert _commit(directory, "o.md") == OID_O, "recipe commit o"
    git(directory, "checkout", "-q", "main")
    # Fetching a commit by id is how the resolver retains a pin, so the recipe's
    # repository must serve one the way a real host does.
    git(directory, "config", "uploadpack.allowAnySHA1InWant", "true")


def _store_path(host: Path) -> Path:
    key = hashlib.sha256(ACME_IDENTITY.encode("utf-8")).hexdigest()
    return host / ".leji" / "mounts" / "store" / key


def build_store(host: Path, sibling: Path, spec: dict) -> None:
    """Build the managed store exactly as a successful ``--fetch`` leaves it."""
    store = _store_path(host)
    store.mkdir(parents=True, exist_ok=True)
    git(host, "init", "--bare", "-q", str(store))
    depth = [] if spec["depth"] is None else ["--depth", str(spec["depth"])]
    if spec["pin"] is not None:
        git(store, "fetch", "-q", *depth, str(sibling), spec["pin"])
        git(store, "update-ref", pin_ref_for(ACME_IDENTITY, spec["pin"]), spec["pin"])
    if spec["witnessRef"] is not None and spec["witnessOid"] is not None:
        git(
            store,
            "fetch",
            "-q",
            *depth,
            str(sibling),
            f"+{spec['witnessOid']}:{witness_ref_for(ACME_IDENTITY, spec['witnessRef'])}",
        )
    (store / "FETCH_HEAD").unlink(missing_ok=True)


def repin(host: Path, pin: str, tracking_ref) -> None:
    """Apply a case's declaration rewrite: the pin it starts from, and whether the
    tracking ref is declared at all. A raw-text splice, as the fixture's own contract
    requires — the harness never reserializes a manifest either."""
    mp = host / "leji.json"
    text = mp.read_text(encoding="utf-8")
    text = re.sub(r'("pin": ")[0-9a-f]{40}(")', rf"\g<1>{pin}\g<2>", text, count=1)
    if tracking_ref is None:
        text = re.sub(r'\s*"trackingRef": "[^"]*",\n', "\n", text, count=1)
    mp.write_text(text, encoding="utf-8")


def run_cli_proc(args: list[str], env: dict[str, str]) -> tuple[int, str]:
    r = subprocess.run(
        [sys.executable, "-m", "leji.cli", *args],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    return r.returncode, r.stdout


def _plain_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("GIT_DIR", None)
    return env


def _routed_env(routed: Path) -> dict[str, str]:
    env = _plain_env()
    env["GIT_CONFIG_COUNT"] = "1"
    env["GIT_CONFIG_KEY_0"] = f"url.{routed}.insteadOf"
    env["GIT_CONFIG_VALUE_0"] = ACME_SOURCE
    return env


# --- the two factorings, against the callers they came out of -----------------


def test_select_comparison_and_compare_pins_answer_what_mount_status_reports(tmp_path) -> None:
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    build_acme_sibling(sibling)
    for pin, expected in (
        (OID_A, "behind"),
        (OID_B, "up-to-date"),
        (OID_S, "diverged"),
        (OID_O, "unrelated"),
    ):
        shutil.rmtree(host, ignore_errors=True)
        shutil.copytree(FIXTURES / "warn-update-pin", host)
        repin(host, pin, "keep")
        build_store(
            host,
            sibling,
            {"pin": pin, "witnessRef": "refs/heads/main", "witnessOid": OID_B, "depth": None},
        )
        manifest = load_manifest(str(host)).manifest
        assert manifest is not None
        row = mount_status(str(host), manifest)[0]
        report = row["pinReport"]
        assert report["state"] == expected, f"status says {expected}"
        selection = select_comparison(
            str(host),
            MountDecl(
                name="product-context",
                source=ACME_SOURCE,
                pin=pin,
                tracking_ref="refs/heads/main",
            ),
            "refs/heads/main",
        )
        assert selection.reason is None, "the matrix selected a repository"
        # The helper reports the same repository, provenance and ref status does…
        assert selection.comparison_repository == report["comparisonRepository"]
        assert selection.witness_provenance == report["witnessProvenance"]
        assert selection.compared_ref == report["comparedRef"]
        assert selection.tip_oid == OID_B, "the single witness snapshot"
        # …and comparing against that one snapshot reproduces the report exactly.
        cmp_result = compare_pins(str(selection.repo), pin, str(selection.tip_oid))
        assert cmp_result.reason is None
        assert cmp_result.state == report["state"]
        assert cmp_result.behind == report["behind"]
        assert cmp_result.ahead == report["ahead"]
        assert cmp_result.ancestry_complete == report["ancestryComplete"]


def test_select_comparison_reports_every_degraded_reason_status_reports(tmp_path) -> None:
    mount = MountDecl(
        name="product-context", source=ACME_SOURCE, pin=OID_A, tracking_ref="refs/heads/main"
    )
    # Nothing holds the pin.
    assert (
        select_comparison(str(tmp_path), mount, "refs/heads/main").reason == "mount-pin-unavailable"
    )
    # A locator no resolver can normalize, and a ref the resolver refuses.
    unnormalizable = MountDecl(
        name=mount.name, source="file:///srv/x", pin=mount.pin, tracking_ref=mount.tracking_ref
    )
    assert (
        select_comparison(str(tmp_path), unnormalizable, "refs/heads/main").reason
        == "mount-source-unnormalizable"
    )
    assert (
        select_comparison(str(tmp_path), mount, "refs/heads/main@{1}").reason
        == "mount-tracking-ref-invalid"
    )


def test_retain_pin_in_store_retains_one_commit_without_touching_the_witness(tmp_path) -> None:
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    build_acme_sibling(sibling)
    host.mkdir()
    mount = MountDecl(
        name="product-context", source=str(sibling), pin=OID_A, tracking_ref="refs/heads/main"
    )
    first = retain_pin_in_store(str(host), mount, ACME_IDENTITY, OID_A)
    assert first.repo is not None, first.error
    assert git(Path(first.repo), "rev-parse", pin_ref_for(ACME_IDENTITY, OID_A)) == OID_A
    # The witness namespace belongs to the refresh, which this primitive is not.
    assert git(Path(first.repo), "for-each-ref", "--format=%(refname)", "refs/leji-witness") == ""
    # A second commit is retained beside the first, not instead of it.
    second = retain_pin_in_store(str(host), mount, ACME_IDENTITY, OID_B)
    assert second.repo is not None, second.error
    assert git(Path(second.repo), "rev-parse", pin_ref_for(ACME_IDENTITY, OID_A)) == OID_A
    assert git(Path(second.repo), "rev-parse", pin_ref_for(ACME_IDENTITY, OID_B)) == OID_B
    # A source that serves nothing is a stated failure, never a partial success.
    gone = MountDecl(
        name=mount.name,
        source=str(tmp_path / "gone"),
        pin=mount.pin,
        tracking_ref=mount.tracking_ref,
    )
    missing = retain_pin_in_store(str(host), gone, ACME_IDENTITY, OID_S)
    assert missing.repo is None
    assert missing.error == "the pin could not be fetched from the source"


# --- the shared fixtures' `updatePin` block -----------------------------------

#: Exactly the keys `--json` emits, under every outcome that emits a document.
DOCUMENT_KEYS = [
    "command",
    "ok",
    "findings",
    "summary",
    "mount",
    "pinReport",
    "action",
    "override",
]


def _update_pin_blocks() -> list[tuple[str, dict, dict]]:
    out: list[tuple[str, dict, dict]] = []
    for name in sorted(p.name for p in FIXTURES.iterdir() if (p / "expected.json").is_file()):
        block = json.loads((FIXTURES / name / "expected.json").read_text()).get("updatePin")
        if not block:
            continue
        for case in block["cases"]:
            out.append((name, block, case))
    return out


UPDATE_PIN_CASES = _update_pin_blocks()


@pytest.mark.parametrize(
    ("fixture", "block", "case"),
    UPDATE_PIN_CASES,
    ids=[f"{name}-{case['id']}" for name, _, case in UPDATE_PIN_CASES],
)
def test_fixture_update_pin_block(fixture: str, block: dict, case: dict, tmp_path) -> None:
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    build_acme_sibling(sibling)
    shutil.copytree(FIXTURES / fixture, host)
    repin(host, case["pin"], case.get("trackingRef", "keep"))
    if case["store"]:
        build_store(host, sibling, case["store"])
    if case["hint"]:
        (host / ".leji").mkdir(parents=True, exist_ok=True)
        (host / ".leji" / "mounts.local.json").write_text(
            json.dumps({"mounts": {block["mount"]: {"repo": str(sibling)}}}) + "\n",
            encoding="utf-8",
        )
    # The declared source is a locator no test may actually reach, so it is routed at
    # git's own level: to the recipe repository for a run that must succeed, and to a
    # path that does not exist for one that must fail.
    if case["source"] == "none":
        env = _plain_env()
    else:
        env = _routed_env(sibling if case["source"] == "local" else tmp_path / "never-created")

    manifest_path = host / "leji.json"
    before = manifest_path.read_bytes()
    code, stdout = run_cli_proc([*case["args"], "--root", str(host), "--json"], env)
    assert code == case["exit"], f"{case['id']}: exit code ({stdout})"

    if case["action"] is None:
        # A usage error reports no outcome at all, and touches nothing.
        assert stdout.strip() == "", f"{case['id']}: no document"
        assert manifest_path.read_bytes() == before, f"{case['id']}: nothing written"
        return
    doc = json.loads(stdout)
    keys = sorted(DOCUMENT_KEYS + ([] if case["reason"] is None else ["reason"]))
    assert sorted(doc.keys()) == keys, f"{case['id']}: the exact JSON key set"
    assert doc["command"] == "mounts update-pin"
    assert doc["action"] == case["action"], f"{case['id']}: action"
    assert doc["override"] == case["override"], f"{case['id']}: override"
    assert doc.get("reason") == case["reason"], f"{case['id']}: reason"
    assert doc["mount"]["from"] == case["from"], f"{case['id']}: from"
    assert doc["mount"]["to"] == case["to"], f"{case['id']}: to"
    assert doc["ok"] == (case["reason"] is None), f"{case['id']}: ok tracks the refusal"
    assert doc["summary"] == {
        "errors": 0 if case["reason"] is None else 1,
        "warnings": 1 if case["override"] else 0,
    }, f"{case['id']}: the literal summary"
    # The findings are what the block pins, never read off the document: a refusal
    # names its reason code, an override warns under its own.
    expected_findings = sorted(
        (
            []
            if case["reason"] is None
            else [{"rule": case["reason"], "severity": "error", "path": doc["mount"]["name"]}]
        )
        + (
            [
                {
                    "rule": "mount-pin-non-fast-forward-override",
                    "severity": "warning",
                    "path": doc["mount"]["name"],
                }
            ]
            if case["override"]
            else []
        ),
        key=lambda f: f["rule"],
    )
    assert [
        {"rule": f["rule"], "severity": f["severity"], "path": f.get("path")}
        for f in doc["findings"]
    ] == expected_findings, f"{case['id']}: the exact findings"
    if "comparisonRepository" in case:
        assert doc["pinReport"]["comparisonRepository"] == case["comparisonRepository"]
    if "comparedRef" in case:
        assert doc["pinReport"]["comparedRef"] == case["comparedRef"]

    after = manifest_path.read_bytes()
    if case["manifestGolden"] is not None:
        golden = (FIXTURES / case["manifestGolden"]).read_bytes()
        assert after == golden, f"{case['id']}: the written manifest bytes"
    # `written: false` is one claim: the manifest is byte-identical to the manifest
    # this run started from.
    if not case["written"]:
        assert after == before, f"{case['id']}: leji.json is byte-untouched"
    # A `--fetch` run does the store acts it was asked for even when the rewrite is
    # suppressed: dry-run withholds the manifest, not the fetch.
    if case["id"] == "dry-run-fetch":
        store = _store_path(host)
        assert store.is_dir(), "the managed store was established"
        assert git(store, "rev-parse", pin_ref_for(ACME_IDENTITY, OID_A)) == OID_A
    # Every fetch this command makes passes --no-write-fetch-head, so a run that
    # reached the source leaves no per-run record inside the store.
    if case["source"] == "local":
        assert not (_store_path(host) / "FETCH_HEAD").exists(), f"{case['id']}: no FETCH_HEAD"


# --- the branches no fixture can construct ------------------------------------


def test_a_declaration_that_changes_under_the_run_is_refused(tmp_path) -> None:
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    build_acme_sibling(sibling)
    shutil.copytree(FIXTURES / "warn-update-pin", host)
    repin(host, OID_A, "keep")
    build_store(
        host,
        sibling,
        {"pin": OID_A, "witnessRef": "refs/heads/main", "witnessOid": OID_B, "depth": None},
    )
    manifest = load_manifest(str(host)).manifest
    assert manifest is not None
    # The comparison runs against the manifest object in hand; the file changes its
    # `source` before the verified read the rewrite makes.
    mp = host / "leji.json"
    original = mp.read_text(encoding="utf-8")
    moved = original.replace(ACME_SOURCE, "https://github.com/acme/moved-context")
    mp.write_text(moved, encoding="utf-8")
    r = update_pin_run(str(host), manifest, "product-context")
    assert r.action == "refused"
    assert r.reason == "mount-declaration-changed"
    assert mp.read_text(encoding="utf-8") == moved


def _declare_tracking_ref(text: str, spelling: str) -> str:
    """Give the mount a ``trackingRef`` member spelled exactly as passed, directly
    after its pin. A raw-text splice, like every other edit these fixtures make."""
    return re.sub(
        r'("pin": "[0-9a-f]{40}",\n)',
        lambda m: f'{m.group(1)}        "trackingRef": {spelling},\n',
        text,
        count=1,
    )


@pytest.mark.parametrize("spelling", ["null", '""'])
def test_a_tracking_ref_that_appears_under_the_run_is_a_changed_declaration(
    tmp_path, monkeypatch, spelling: str
) -> None:
    """A mount declared with NO trackingRef, which gains one while the comparison
    runs, is a changed declaration. Presence is the half a bare lookup loses: absent
    and `null` both read back as None, so without the presence check the pin would be
    spliced into a declaration the schema no longer accepts."""
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    build_acme_sibling(sibling)
    shutil.copytree(FIXTURES / "warn-update-pin", host)
    # Absent at load; only --fetch can resolve the source's advertised default branch,
    # which is the one path that reaches the rewrite with no trackingRef declared.
    repin(host, OID_A, None)
    for key, value in _routed_env(sibling).items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("GIT_DIR", raising=False)
    manifest = load_manifest(str(host)).manifest
    assert manifest is not None
    assert "trackingRef" not in manifest["federation"]["mounts"][0], "absent at load"
    mp = host / "leji.json"
    appeared = _declare_tracking_ref(mp.read_text(encoding="utf-8"), spelling)
    mp.write_text(appeared, encoding="utf-8")
    r = update_pin_run(str(host), manifest, "product-context", fetch=True)
    assert r.action == "refused", f"trackingRef: {spelling} must not read as unchanged"
    assert r.reason == "mount-declaration-changed"
    assert mp.read_text(encoding="utf-8") == appeared, "leji.json is byte-untouched"


def test_a_declaration_still_absent_at_the_reread_proceeds(tmp_path, monkeypatch) -> None:
    """The other half of the same rule: absent-and-still-absent is unchanged, so the
    run that resolved its ref from the source still writes."""
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    build_acme_sibling(sibling)
    shutil.copytree(FIXTURES / "warn-update-pin", host)
    repin(host, OID_A, None)
    for key, value in _routed_env(sibling).items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("GIT_DIR", raising=False)
    manifest = load_manifest(str(host)).manifest
    assert manifest is not None
    r = update_pin_run(str(host), manifest, "product-context", fetch=True)
    assert r.action == "updated", r.reason
    assert json.loads((host / "leji.json").read_text())["federation"]["mounts"][0]["pin"] == OID_B


def test_a_target_that_cannot_be_retained_under_fetch_refuses_the_move(tmp_path) -> None:
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    build_acme_sibling(sibling)
    shutil.copytree(FIXTURES / "warn-update-pin", host)
    repin(host, OID_A, "keep")
    (host / ".leji").mkdir(parents=True, exist_ok=True)
    (host / ".leji" / "mounts.local.json").write_text(
        json.dumps({"mounts": {"product-context": {"repo": str(sibling)}}}) + "\n",
        encoding="utf-8",
    )
    before = (host / "leji.json").read_bytes()
    # By the time the TARGET is retained the store already holds it, so the fetch
    # never runs and only the ref update can fail: the injection is the branch's one
    # reachable path. It names the TARGET, so retaining the current pin — the act
    # before the gate — still succeeds and the refusal is unambiguous.
    env = _routed_env(sibling)
    env["LEJI_TEST_FAIL_PIN_REF"] = OID_B
    code, stdout = run_cli_proc(
        ["mounts", "update-pin", "product-context", "--fetch", "--root", str(host), "--json"], env
    )
    assert code == 1, stdout
    doc = json.loads(stdout)
    assert doc["action"] == "refused"
    assert doc["reason"] == "mount-store-fetch-failed"
    assert doc["mount"]["to"] == OID_B, "the target it declined to retain is still reported"
    assert [f["rule"] for f in doc["findings"]] == ["mount-store-fetch-failed"]
    assert (host / "leji.json").read_bytes() == before, "leji.json is byte-untouched"
    # The refusal leaves the CURRENT pin retained: fetched objects and refs stay,
    # which is exactly what the help text says a failed --fetch may leave behind.
    assert git(_store_path(host), "rev-parse", pin_ref_for(ACME_IDENTITY, OID_A)) == OID_A


def test_a_target_the_manifest_no_longer_pins_from_is_refused_by_the_scanner(tmp_path) -> None:
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    build_acme_sibling(sibling)
    shutil.copytree(FIXTURES / "warn-update-pin", host)
    repin(host, OID_A, "keep")
    build_store(
        host,
        sibling,
        {"pin": OID_A, "witnessRef": "refs/heads/main", "witnessOid": OID_B, "depth": None},
    )
    mp = host / "leji.json"
    with pytest.raises(RuntimeError, match=r'pin of mount "product-context" is not'):
        replace_mount_pin_in_manifest_text(
            mp.read_text(encoding="utf-8"), "product-context", OID_S, OID_B
        )
    # And the same refusal reaches the CLI as exit 2 with no document at all.
    code, stdout = run_cli_proc(
        [
            "mounts",
            "update-pin",
            "product-context",
            "--to",
            "z" * 40,
            "--root",
            str(host),
            "--json",
        ],
        _plain_env(),
    )
    assert code == 2, "a malformed --to never reaches the scanner"
    assert stdout.strip() == ""


# --- the CLI surface ----------------------------------------------------------


def test_the_mounts_sub_guard_accepts_update_pin_and_rejects_everything_else(
    capsys, tmp_path
) -> None:
    from leji.cli import main

    shutil.copytree(FIXTURES / "warn-update-pin", tmp_path / "layer")
    layer = str(tmp_path / "layer")
    # Accepted spellings reach their command (never the sub-guard's exit 2)…
    for sub in ("hydrate", "status", "locate", "update-pin"):
        argv = ["mounts", sub]
        if sub in ("locate", "update-pin"):
            argv.append("product-context")
        argv += ["--root", layer]
        assert main(argv) != 2, " ".join(argv)
        capsys.readouterr()
    # …and every other spelling, including a bare `mounts`, is the guard.
    for sub in ([], ["nope"], ["update"], ["updatepin"], ["update-pins"], ["Update-Pin"]):
        assert main(["mounts", *sub, "--root", layer]) == 2, f"mounts {' '.join(sub)}"
        capsys.readouterr()


def test_update_pin_takes_one_positional_and_only_its_declared_flags(capsys, tmp_path) -> None:
    from leji.cli import main

    shutil.copytree(FIXTURES / "warn-update-pin", tmp_path / "layer")
    layer = str(tmp_path / "layer")

    def run(argv: list[str]) -> int:
        code = main([*argv, "--root", layer])
        capsys.readouterr()
        return code

    # The positional budget gains this command's one name, as `mounts locate` has.
    assert run(["mounts", "update-pin", "product-context"]) != 2
    assert run(["mounts", "update-pin", "product-context", "surplus"]) == 2
    assert run(["mounts", "update-pin"]) == 2, "the name is required"
    # Flags declared on this command are accepted; a flag declared elsewhere is not,
    # and neither is a destination parameter, which this command has none of.
    assert run(["mounts", "update-pin", "product-context", "--dry-run", "--fetch"]) != 2
    for argv in (
        ["mounts", "update-pin", "product-context", "--check-integrity"],
        ["mounts", "update-pin", "product-context", "--strict"],
        ["mounts", "update-pin", "product-context", "--endpoint", "x"],
        ["mounts", "status", "--to", OID_B],
        ["mounts", "status", "--allow-non-fast-forward"],
    ):
        assert run(argv) == 2, " ".join(argv)
    # `--to` takes a full lowercase hex commit id in either spelling, and nothing else.
    assert run(["mounts", "update-pin", "product-context", f"--to={OID_B}"]) != 2
    assert run(["mounts", "update-pin", "product-context", "--to", "0" * 64]) != 2
    for bad in ("xyz", OID_B[:12], OID_B.upper(), "0" * 41, "0" * 63, ""):
        assert run(["mounts", "update-pin", "product-context", "--to", bad]) == 2, f"--to {bad}"
    assert run(["mounts", "update-pin", "product-context", "--to", "--json"]) == 2
    # The override is meaningless without a named target, and says so.
    assert run(["mounts", "update-pin", "product-context", "--allow-non-fast-forward"]) == 2


def test_update_pin_help_exits_zero_and_names_no_network_destination(capsys) -> None:
    from leji.cli import main

    assert main(["mounts", "update-pin", "--help"]) == 0
    help_text = capsys.readouterr().out
    assert "leji mounts update-pin" in help_text
    # The only network vocabulary this command may carry is what `mounts hydrate`
    # already documents: the declared source, and nothing addressable by the caller.
    for banned in ("endpoint", "token", "upload", "registry", "api.", "http://", "account"):
        assert banned not in help_text.lower(), f'help must not mention "{banned}"'
