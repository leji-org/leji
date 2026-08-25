"""Federation mounts resolver tests, mirroring packages/sdk/test/mounts.test.ts."""

import errno
import hashlib
import json
import os
import shutil
import stat as statmod
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import pytest

from leji.conformance import conformance_report
from leji.manifest import load_manifest
from leji.mounts import (
    MountDecl,
    cache_key_for,
    find_object_source,
    check_pin_reachability,
    federation_enforcement,
    hydrate_mounts,
    locate_mount,
    mount_status,
    normalize_source,
    object_source_candidates,
    pin_ref_for,
    sha256_hex,
    valid_tracking_ref,
    verify_projection,
    witness_ref_for,
)
from leji.validate import validate_layer

REPO_ROOT = Path(__file__).resolve().parents[3]
SIBLING_EXAMPLE = REPO_ROOT / "examples" / "multi-repo" / "product-context"
HOST_EXAMPLE = REPO_ROOT / "examples" / "multi-repo" / "core-context"


def git(cwd: Path, *args: str) -> str:
    env = dict(os.environ)
    env.pop("GIT_DIR", None)
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, check=True
    ).stdout.strip()


def mounted_pair(tmp_path: Path) -> tuple[str, Path, str]:
    """A committed sibling repo (from the multi-repo example) plus a host with a
    pinned mount and a machine-local hint pointing at the sibling checkout."""
    sibling = tmp_path / "sibling"
    host = tmp_path / "host"
    shutil.copytree(SIBLING_EXAMPLE, sibling)
    git(sibling, "init", "-q", "-b", "main")
    git(sibling, "add", "-A")
    git(
        sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed"
    )
    pin = git(sibling, "rev-parse", "HEAD")
    shutil.copytree(HOST_EXAMPLE, host)
    mp = host / "leji.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["federation"]["mounts"][0]["pin"] = pin
    m["federation"]["mounts"][0]["trackingRef"] = "refs/heads/main"
    mp.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
    (host / ".leji").mkdir(parents=True, exist_ok=True)
    (host / ".leji" / "mounts.local.json").write_text(
        json.dumps({"mounts": {"acme-product-context": {"repo": "../sibling"}}}) + "\n",
        encoding="utf-8",
    )
    return str(host), sibling, pin


def test_source_normalization_is_canonical_and_credential_free() -> None:
    assert normalize_source("https://GitHub.com/Acme/Repo.git/") == "https://github.com/Acme/Repo"
    assert normalize_source("https://github.com/acme/repo.git") == "https://github.com/acme/repo"
    assert normalize_source("git@github.com:acme/repo.git") == "ssh://git@github.com/acme/repo"
    assert (
        normalize_source("https://user:token@github.com/acme/repo")
        == "https://github.com/acme/repo"
    )
    assert normalize_source("ssh://git@github.com/acme/repo/") == "ssh://git@github.com/acme/repo"
    assert normalize_source("/Users/someone/local/checkout") is None
    assert normalize_source("file:///x/y") is None
    assert normalize_source("") is None


def test_hydrate_via_hint_materializes_verified_projection_and_clears_warning(tmp_path) -> None:
    host, _sibling, pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    r = hydrate_mounts(host, manifest)
    assert r.fatal is None
    assert [(o["name"], o["status"]) for o in r.outcomes] == [("acme-product-context", "hydrated")]
    # The entry is published at the key derived from source and pin, and nothing
    # records that mapping: the declaration is the only thing that knows it.
    identity = normalize_source("https://github.com/acme/product-context")
    assert identity is not None
    entry = Path(host) / ".leji" / "mounts" / "cache" / cache_key_for(identity, pin) / "projection"
    assert (entry / "complete").is_file(), "the published entry carries its marker"
    assert not (Path(host) / ".leji" / "mounts" / "state.json").exists(), "no state file is written"
    # locate reports present + verified with the projection path.
    loc = locate_mount(host, manifest, "acme-product-context")
    assert loc["present"] is True
    assert loc["verified"] is True
    assert loc["path"] and (Path(str(loc["path"])) / "leji.json").exists()
    # The sibling's own layer content is inside; nothing else of the repo is.
    assert (Path(str(loc["path"])) / "boot-profile.md").exists()
    # validate no longer reports mount-unavailable.
    v = validate_layer(host)
    assert not any(f.rule == "mount-unavailable" for f in v.findings)
    # A second hydrate is a cache hit.
    again = hydrate_mounts(host, manifest)
    assert [o["status"] for o in again.outcomes] == ["cached"]


def test_status_reports_up_to_date_then_behind_against_the_witness_ref(tmp_path) -> None:
    host, sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    hydrate_mounts(host, manifest)
    rows = mount_status(host, manifest)
    report = rows[0]["pinReport"]
    assert report["state"] == "up-to-date"
    assert report["comparedRef"] == "refs/heads/main"
    assert report["ancestryComplete"] is True
    # The sibling moves on; the pin is now behind its witness.
    (sibling / "new-doc.md").write_text("# New\n", encoding="utf-8")
    git(sibling, "add", "-A")
    git(
        sibling,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "later",
    )
    rows = mount_status(host, manifest)
    report = rows[0]["pinReport"]
    assert report["state"] == "behind"
    assert report["behind"] == 1
    assert rows[0]["present"] is True


def test_status_is_unknown_without_reachable_store_and_without_witness(tmp_path) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    # Remove the hint: no store, no submodule -> unknown, never a guess.
    (Path(host) / ".leji" / "mounts.local.json").unlink()
    rows = mount_status(host, manifest)
    assert rows[0]["pinReport"]["state"] == "unknown"
    assert rows[0]["present"] is False


def test_check_integrity_detects_tamper_and_verify_is_none_when_unverifiable(tmp_path) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    hydrate_mounts(host, manifest)
    loc = locate_mount(host, manifest, "acme-product-context")
    with (Path(str(loc["path"])) / "boot-profile.md").open("a", encoding="utf-8") as f:
        f.write("tampered\n")
    rows = mount_status(host, manifest, check_integrity=True)
    assert rows[0]["verified"] is False
    # With the object store gone, verification is unverifiable (None), not a pass.
    (Path(host) / ".leji" / "mounts.local.json").unlink()
    m = manifest["federation"]["mounts"][0]
    mount = MountDecl(
        name=m["name"], source=m["source"], pin=m["pin"], tracking_ref=m.get("trackingRef")
    )
    assert verify_projection(host, mount) is None


def test_hydrate_refuses_while_cache_files_are_git_tracked_in_the_host(tmp_path) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    git(Path(host), "init", "-q")
    (Path(host) / ".leji" / "mounts").mkdir(parents=True, exist_ok=True)
    (Path(host) / ".leji" / "mounts" / "poison.txt").write_text("x\n", encoding="utf-8")
    git(Path(host), "add", "-f", ".leji/mounts/poison.txt")
    manifest = load_manifest(host).manifest
    assert manifest is not None
    r = hydrate_mounts(host, manifest)
    assert r.fatal is not None and "never committed" in r.fatal
    assert r.outcomes == []


def test_projection_with_escaping_symlink_fails_hydration_as_an_error(tmp_path) -> None:
    host, sibling, _pin = mounted_pair(tmp_path)
    # Add an escaping symlink inside the sibling's rootPath and re-pin to it.
    os.symlink("../../outside.md", sibling / "context" / "escape.md")
    git(sibling, "add", "-A")
    git(
        sibling,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "escape",
    )
    new_pin = git(sibling, "rev-parse", "HEAD")
    mp = Path(host) / "leji.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["federation"]["mounts"][0]["pin"] = new_pin
    mp.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
    manifest = load_manifest(host).manifest
    assert manifest is not None
    r = hydrate_mounts(host, manifest)
    assert r.outcomes[0]["status"] == "error"
    assert "escapes the projection" in str(r.outcomes[0]["detail"])
    # Nothing landed in the cache.
    assert locate_mount(host, manifest, "acme-product-context")["present"] is False


def test_hydrate_pulls_the_pin_from_the_managed_store(tmp_path) -> None:
    host, sibling, pin = mounted_pair(tmp_path)
    # Point source at the sibling as a file-less URL is invalid by design; use the
    # hint-free path with a fetchable local bare mirror served via its path as the
    # fetch remote. normalize_source rejects local paths for identity, so the
    # declared https source stays the identity while git fetches from it only in
    # real deployments. Here we emulate by seeding the store from the hint first.
    (Path(host) / ".leji" / "mounts.local.json").unlink()
    identity = normalize_source("https://github.com/acme/product-context")
    assert identity is not None
    manifest = load_manifest(host).manifest
    assert manifest is not None
    # Unavailable offline with no hint/store/submodule…
    r = hydrate_mounts(host, manifest)
    assert r.outcomes[0]["status"] == "unavailable"
    # …but once the store holds the objects (as a --fetch would leave it), hydrate succeeds.
    store_dir = Path(host) / ".leji" / "mounts" / "store"
    store_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    env = dict(os.environ)
    env.pop("GIT_DIR", None)
    subprocess.run(
        ["git", "clone", "-q", "--bare", str(sibling), str(store_dir / key)],
        env=env,
        check=True,
    )
    r = hydrate_mounts(host, manifest)
    assert r.outcomes[0]["status"] == "hydrated"
    assert r.outcomes[0]["objectSource"] == "store"
    assert locate_mount(host, manifest, "acme-product-context")["pin"] == pin


@contextmanager
def _source_rewrite(sibling: Path):
    """Route git's network protocols at the declared source URL to a local repo, so
    the "networked" reachability probe runs hermetically (env flows into run_git)."""
    keys = ("GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0")
    prev = {k: os.environ.get(k) for k in keys}
    os.environ["GIT_CONFIG_COUNT"] = "1"
    os.environ["GIT_CONFIG_KEY_0"] = f"url.{sibling}.insteadOf"
    os.environ["GIT_CONFIG_VALUE_0"] = "https://github.com/acme/product-context"
    try:
        yield
    finally:
        for k in keys:
            if prev[k] is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = prev[k]


def test_pin_reachability_reachable_unreachable_off_history_unknown_offline(tmp_path) -> None:
    host, sibling, pin = mounted_pair(tmp_path)
    mount = MountDecl(
        name="acme-product-context",
        source="https://github.com/acme/product-context",
        pin=pin,
        tracking_ref="refs/heads/main",
    )
    # Offline (no rewrite): the fake source is unreachable -> unknown, never a guess.
    offline = check_pin_reachability(host, mount)
    assert offline.state == "unknown"
    # With the source reachable: the pin is the witness tip -> reachable.
    with _source_rewrite(sibling):
        on = check_pin_reachability(host, mount)
    assert on.state == "reachable"
    assert on.witness_ref == "refs/heads/main"
    # A commit on an unadvertised side branch is not reachable from the witness.
    git(sibling, "checkout", "-q", "-b", "side")
    (sibling / "side.md").write_text("# side\n", encoding="utf-8")
    git(sibling, "add", "-A")
    git(
        sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "side"
    )
    side_pin = git(sibling, "rev-parse", "HEAD")
    git(sibling, "checkout", "-q", "main")
    side_mount = MountDecl(
        name=mount.name, source=mount.source, pin=side_pin, tracking_ref=mount.tracking_ref
    )
    with _source_rewrite(sibling):
        off = check_pin_reachability(host, side_mount)
    assert off.state == "unreachable"
    # Absent tracking_ref, the witness resolves from the source's advertised HEAD.
    with _source_rewrite(sibling):
        head = check_pin_reachability(
            host, MountDecl(name=mount.name, source=mount.source, pin=pin)
        )
    assert head.state == "reachable"
    assert head.witness_ref == "refs/heads/main"


def test_fetch_retains_the_pin_by_a_resolver_owned_ref_and_writes_no_fetch_head(
    tmp_path,
) -> None:
    host, sibling, pin = mounted_pair(tmp_path)
    git(sibling, "config", "uploadpack.allowAnySHA1InWant", "true")
    manifest = load_manifest(host).manifest
    assert manifest is not None
    # main moves past the pin, so neither fetch may leave the version of record to
    # FETCH_HEAD: only a ref of our own retains it.
    (sibling / "b.md").write_text("# b\n", encoding="utf-8")
    git(sibling, "add", "-A")
    git(sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "b")
    with _source_rewrite(sibling):
        hydrate_mounts(host, manifest, fetch=True)
    identity = normalize_source("https://github.com/acme/product-context")
    assert identity is not None
    store = Path(host) / ".leji" / "mounts" / "store" / sha256_hex(identity)
    assert git(store, "rev-parse", pin_ref_for(identity, pin)) == pin
    # Both fetches pass --no-write-fetch-head, so the managed store carries no
    # per-run record of where the objects came from.
    assert not (store / "FETCH_HEAD").exists(), "no FETCH_HEAD in the managed store"
    # And a second --fetch, which refreshes the witness over an existing store, does
    # not create one either.
    (sibling / "c.md").write_text("# c\n", encoding="utf-8")
    git(sibling, "add", "-A")
    git(sibling, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c")
    with _source_rewrite(sibling):
        hydrate_mounts(host, manifest, fetch=True)
    assert not (store / "FETCH_HEAD").exists(), "still none after a witness refresh"


def _witness_transaction_hook(store: Path, witness_ref: str, mode: str, oid: str = "") -> None:
    """A ``reference-transaction`` hook in the managed store, firing only on the
    canonical witness ref. ``abort`` fails the swap the way a lock, a permission
    error or a full disk does. ``publish`` writes ``oid`` into the ref and then
    fails, which is the state a run finds when another writer published between its
    read of <oldvalue> and its own swap; the interleaving itself is not reachable in
    a single process, so the fixture reproduces what it leaves behind."""
    hooks = store / "hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    publish = (
        f'mkdir -p "$(dirname "{store}/{witness_ref}")"\n'
        f"printf '%s\\n' '{oid}' > \"{store}/{witness_ref}\"\n"
        if mode == "publish"
        else ""
    )
    hook = hooks / "reference-transaction"
    # Each stdin line is "<old> <new> <ref>"; every other ref (the fetched temporary,
    # the pin ref) passes through untouched.
    hook.write_text(
        f'#!/bin/sh\n[ "$1" = prepared ] || exit 0\n'
        f'grep -q " {witness_ref}$" || exit 0\n{publish}exit 1\n',
        encoding="utf-8",
    )
    hook.chmod(0o755)


def test_a_lost_compare_and_swap_is_a_mismatch_and_an_operational_failure_is_not(
    tmp_path, capsys
) -> None:
    """Mirrors the TS reference's reference-transaction test. It is also the only
    reachable path to the witness act's SECOND frozen failure class: a tracking ref
    that arrived and a canonical ref that would not take it, whose reason travels
    into ``reasons`` and from there into the finding's ``detail``."""
    from leji.cli import main

    host, sibling, pin = mounted_pair(tmp_path)
    git(sibling, "config", "uploadpack.allowAnySHA1InWant", "true")
    manifest = load_manifest(host).manifest
    assert manifest is not None
    identity = normalize_source("https://github.com/acme/product-context")
    assert identity is not None
    store = Path(host) / ".leji" / "mounts" / "store" / sha256_hex(identity)
    witness_ref = witness_ref_for(identity, "refs/heads/main")
    # The witness ref does not exist yet, so this run swaps against "must not exist",
    # and finds another writer's commit there instead. That is a race it lost, not
    # a failure: the published witness stands and nothing is reported.
    store.mkdir(parents=True, exist_ok=True)
    git(Path(host), "init", "--bare", "-q", str(store))
    _witness_transaction_hook(store, witness_ref, "publish", pin)
    with _source_rewrite(sibling):
        r = hydrate_mounts(host, manifest, fetch=True)
    assert "witnessRefreshFailed" not in r.outcomes[0], "another writer publishing is valid"
    assert git(store, "rev-parse", witness_ref) == pin, "the other writer's witness stands"
    assert "acme-product-context" not in r.reasons, "a valid outcome names no failed act"
    # The same failed swap, with the ref holding exactly what this run expected: no
    # one published, so this is the disk, the permissions or a lock, and it may not
    # pass as a refresh that happened.
    _witness_transaction_hook(store, witness_ref, "abort")
    with _source_rewrite(sibling):
        r = hydrate_mounts(host, manifest, fetch=True)
    assert r.outcomes[0]["storeFetched"] is True, "the store was established, the swap failed"
    assert r.outcomes[0]["witnessRefreshFailed"] is True
    assert git(store, "rev-parse", witness_ref) == pin, "the previous witness stays in place"
    # The witness act's second failure class, which is not the first one: a ref that
    # arrived and would not publish, never a ref that never arrived.
    assert r.reasons["acme-product-context"] == "the witness ref could not be published"
    # And the same reason as the bytes `mounts hydrate --json` emits.
    capsys.readouterr()
    with _source_rewrite(sibling):
        code = main(["mounts", "hydrate", "--fetch", "--json", "--root", host])
    payload = json.loads(capsys.readouterr().out)
    assert code == 0, "best-effort: a witness that would not publish is a warning"
    assert [(f["rule"], f["severity"]) for f in payload["findings"]] == [
        ("mount-witness-refresh-failed", "warning")
    ]
    assert payload["findings"][0]["detail"] == "witness: the witness ref could not be published"
    assert list(payload["findings"][0]) == ["rule", "severity", "path", "message", "detail"]
    # And the same act reaches a person, on the finding's own line.
    with _source_rewrite(sibling):
        assert main(["mounts", "hydrate", "--fetch", "--root", host]) == 0
    human = capsys.readouterr().out
    assert (
        "warning mount-witness-refresh-failed acme-product-context: the managed witness ref "
        "could not be refreshed by the requested fetch "
        "(detail: witness: the witness ref could not be published)\n"
    ) in human
    assert " (detail: witness: the witness ref could not be published)" in human


def test_conformance_pin_reachable_is_unknown_offline_and_never_awards_federated(
    tmp_path,
) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    hydrate_mounts(host, manifest)
    report = conformance_report(host)
    item = next(i for i in report.items if i.id == "pin-reachable")
    assert item.status == "unknown"
    assert report.verified_level != "federated"


def test_federation_enforcement_fails_unhydrated_or_unverifiable_passes_verified(
    tmp_path,
) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    # available: unhydrated -> error.
    findings = federation_enforcement(host, manifest, "available", None)
    assert len(findings) == 1
    assert "not hydrated" in findings[0].message
    # Hydrated + verifiable via the hint -> clean.
    hydrate_mounts(host, manifest)
    findings = federation_enforcement(host, manifest, "available", None)
    assert findings == []
    # required: only task-routed mounts are enforced.
    findings = federation_enforcement(host, manifest, "required", set())
    assert findings == []
    # With the hint gone the cache is unverifiable, which enforcement rejects.
    (Path(host) / ".leji" / "mounts.local.json").unlink()
    findings = federation_enforcement(host, manifest, "required", {"acme-product-context"})
    assert len(findings) == 1
    assert "cannot be verified" in findings[0].message


def test_witness_ref_scheme_and_tracking_ref_validation() -> None:
    """The tracking-ref table and the ref-name builders are the port's regex- and
    hash-sensitive surface: a divergence here picks a different witness ref or
    accepts a manifest the reference rejects, which no parity scenario would see."""
    for ref in ("refs/heads/main", "refs/tags/v1.2.3", "refs/heads/release/1.x"):
        assert valid_tracking_ref(ref), ref
    bad = [
        "main",
        "refs/remotes/origin/main",
        "refs/heads/*",
        "refs/heads/a b",
        "refs/heads/x^{}",
        "refs/heads/a..b",
        "refs/heads/a@{0}",
        "refs/heads//b",
        "refs/heads/b/",
        "refs/heads/b.",
        "refs/heads/.hidden",
        "refs/heads/a/.hidden",
        "refs/heads/b.lock",
        "refs/heads/a.lock/b",
        "refs/heads/a\\b",
        "refs/heads/a\tb",
        "refs/heads/a\x00b",
        "refs/heads/",
    ]
    for ref in bad:
        assert not valid_tracking_ref(ref), repr(ref)
    identity = "https://github.com/acme/product-context"
    ref = witness_ref_for(identity, "refs/heads/main")
    assert ref == (f"refs/leji-witness/v1/{sha256_hex(identity)}/{sha256_hex('refs/heads/main')}")
    # Both components are fixed-length hex: no per-component filesystem limit to
    # outgrow, and no case fold that collides two declarations.
    assert len(witness_ref_for(identity, "refs/heads/" + "x" * 2000)) == len(ref)
    assert ref != witness_ref_for(identity, "refs/heads/Main")
    oid = "a" * 40
    assert pin_ref_for(identity, oid) == f"refs/leji-pin/v1/{sha256_hex(identity)}/{oid}"


# --- the publication protocol ------------------------------------------------
#
# There is no lock: every producer for a key stages byte-identical content, and
# ``rename`` alone decides which one publishes.

ACME_SOURCE = "https://github.com/acme/product-context"


def test_concurrent_publishers_publish_exactly_once_and_leave_no_staging(tmp_path) -> None:
    host, _sibling, pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: hydrate_mounts(host, manifest), range(4)))
    statuses = sorted(str(r.outcomes[0]["status"]) for r in results)
    assert statuses == ["cached", "cached", "cached", "hydrated"], "exactly one rename wins"
    identity = normalize_source(ACME_SOURCE)
    assert identity is not None
    entry = Path(host) / ".leji" / "mounts" / "cache" / cache_key_for(identity, pin)
    assert (entry / "projection" / "complete").is_file(), "the winner published its marker"
    assert sorted(p.name for p in entry.iterdir()) == ["projection"], "no staging survives"


def test_publishing_onto_a_marked_entry_is_cached_and_touches_nothing(tmp_path) -> None:
    host, _sibling, pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    assert hydrate_mounts(host, manifest).outcomes[0]["status"] == "hydrated"
    identity = normalize_source(ACME_SOURCE)
    assert identity is not None
    entry = Path(host) / ".leji" / "mounts" / "cache" / cache_key_for(identity, pin)
    projection = entry / "projection"
    # The sidecar carries this run's hydratedAt, so identical bytes prove the
    # published entry was left exactly as the first producer wrote it.
    before = (projection / "metadata.json").read_bytes()
    again = hydrate_mounts(host, manifest)
    assert again.outcomes[0]["status"] == "cached"
    assert "objectSource" not in again.outcomes[0], "a cache hit projects nothing"
    assert (projection / "metadata.json").read_bytes() == before
    assert sorted(p.name for p in entry.iterdir()) == ["projection"]


def test_a_projection_without_its_marker_is_poison_and_is_never_repaired(tmp_path) -> None:
    host, _sibling, pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    identity = normalize_source(ACME_SOURCE)
    assert identity is not None
    entry = Path(host) / ".leji" / "mounts" / "cache" / cache_key_for(identity, pin)
    projection = entry / "projection"
    projection.mkdir(parents=True)
    (projection / "leji.json").write_text("half a projection\n", encoding="utf-8")
    first = hydrate_mounts(host, manifest)
    assert [(o["status"], o["detail"]) for o in first.outcomes] == [
        ("error", "the cache entry is incomplete and is not repaired automatically")
    ]
    # Nothing under the key counts as hydrated, because the marker is what counts.
    assert locate_mount(host, manifest, "acme-product-context")["present"] is False
    assert any(f.rule == "mount-unavailable" for f in validate_layer(host).findings)
    # A second run says the same thing rather than deciding, from outside, that no
    # other producer is mid-publish.
    assert hydrate_mounts(host, manifest).outcomes == first.outcomes
    assert (projection / "leji.json").read_text(encoding="utf-8") == "half a projection\n"
    assert not (projection / "complete").exists()
    assert sorted(p.name for p in entry.iterdir()) == ["projection"]


def test_an_empty_root_path_tree_still_publishes_a_non_empty_projection(tmp_path) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    # A sibling that declares a rootPath holding nothing at the pin: the projection
    # is the manifest and the resolver's own two files, and nothing else.
    empty = tmp_path / "empty-sibling"
    empty.mkdir(parents=True)
    (empty / "leji.json").write_text(
        json.dumps(
            {
                "leji": "1.0",
                "name": "acme-product-context",
                "rootPath": "docs/",
                "bootProfilePath": "boot.md",
                "owners": {"primary": {"name": "Sibling Owner"}},
                # Schema-required, and outside the rootPath tree too, so "empty"
                # stays this fixture's point.
                "categories": {"domain": {"indexes": ["index/domain.md"]}},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    # The boot profile sits outside the (empty) rootPath tree: the closure carries
    # it anyway, which is the relocated-entrypoint case the closure rule exists for.
    (empty / "boot.md").write_text("# Boot\n", encoding="utf-8")
    (empty / "index").mkdir()
    (empty / "index" / "domain.md").write_text("# Domain index\n", encoding="utf-8")
    git(empty, "init", "-q", "-b", "main")
    git(empty, "add", "-A")
    git(empty, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed")
    empty_pin = git(empty, "rev-parse", "HEAD")
    mp = Path(host) / "leji.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["federation"]["mounts"][0]["pin"] = empty_pin
    mp.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
    (Path(host) / ".leji" / "mounts.local.json").write_text(
        json.dumps({"mounts": {"acme-product-context": {"repo": "../empty-sibling"}}}) + "\n",
        encoding="utf-8",
    )
    manifest = load_manifest(host).manifest
    assert manifest is not None
    assert hydrate_mounts(host, manifest).outcomes[0]["status"] == "hydrated"
    identity = normalize_source(ACME_SOURCE)
    assert identity is not None
    projection = (
        Path(host)
        / ".leji"
        / "mounts"
        / "cache"
        / cache_key_for(identity, empty_pin)
        / "projection"
    )
    assert sorted(p.name for p in projection.iterdir()) == [
        "boot.md",
        "complete",
        "index",
        "leji.json",
        "metadata.json",
    ]
    # Publishing the marker inside the staged tree is what makes the rename
    # exclusive: POSIX replaces an empty destination directory, and a published
    # entry is never empty.
    decoy = Path(host) / ".leji" / "mounts" / "decoy"
    decoy.mkdir(parents=True)
    with pytest.raises(OSError):
        os.rename(decoy, projection)
    assert hydrate_mounts(host, manifest).outcomes[0]["status"] == "cached"


def test_enforcement_rejects_a_projection_directory_without_its_marker(tmp_path) -> None:
    """A projection directory with no `complete` marker was never published: it is
    poison, not evidence, and enforcement must count the mount as NOT hydrated. The
    directory existing proves nothing; only the marker inside it does."""
    host, _sibling, pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    hydrate_mounts(host, manifest)
    assert federation_enforcement(host, manifest, "available", None) == []
    identity = normalize_source(ACME_SOURCE)
    assert identity is not None
    projection = (
        Path(host) / ".leji" / "mounts" / "cache" / cache_key_for(identity, pin) / "projection"
    )
    # Every projected byte is still on disk; only the completion evidence is gone.
    (projection / "complete").unlink()
    assert (projection / "leji.json").is_file()
    findings = federation_enforcement(host, manifest, "available", None)
    assert len(findings) == 1
    assert "not hydrated" in findings[0].message
    assert findings[0].path == "acme-product-context"


def test_two_matching_submodules_are_ambiguous_even_with_a_resolving_candidate(
    tmp_path,
) -> None:
    """Ambiguity is about the submodules alone: a candidate that resolves the pin
    does not make two matching submodules unambiguous, because those repositories
    were never consulted either way. With no candidate resolving the witness ref,
    `mounts status` must report `mount-source-ambiguous` (what Node reports), not the
    `mount-witness-unavailable` a candidates-first test reaches."""
    host, sibling, pin = mounted_pair(tmp_path)
    # The hint repository still holds the pin, but no longer resolves the declared
    # trackingRef: the pin is available, the witness is not.
    git(sibling, "branch", "-m", "main", "other")
    modules = ""
    for name in ("one", "two"):
        repo = Path(host) / "vendor" / name
        repo.mkdir(parents=True)
        git(Path(host), "init", "-q", "-b", "main", str(repo))
        modules += f'[submodule "{name}"]\n\tpath = vendor/{name}\n\turl = {ACME_SOURCE}\n'
    (Path(host) / ".gitmodules").write_text(modules, encoding="utf-8")
    manifest = load_manifest(host).manifest
    assert manifest is not None
    identity = normalize_source(ACME_SOURCE)
    assert identity is not None
    mount = MountDecl(
        name="acme-product-context", source=ACME_SOURCE, pin=pin, tracking_ref="refs/heads/main"
    )
    candidates, ambiguous = object_source_candidates(host, mount, identity)
    assert candidates, "the hint still resolves the pin"
    assert ambiguous is True
    report = mount_status(host, manifest)[0]["pinReport"]
    assert report["state"] == "unknown"  # type: ignore[index]
    assert report["reason"] == "mount-source-ambiguous"  # type: ignore[index]
    # Hydration is unaffected: it takes the first candidate and never reads the flag
    # unless there is none, exactly as the reference does.
    assert find_object_source(host, mount, identity).kind == "hint"


# --- verification is read-only: it may not stage inside the tree it verifies ---


def deny_writes(directory: Path):
    """Strip write permission from every directory in the tree; returns the undo. On
    POSIX this is a real denial for a non-root user. The Windows equivalent is a DENY
    ACE rather than a mode, which is a named verify-at-build obligation for the
    cross-platform runner, not something these mode bits stand in for."""
    saved = [(p, p.stat().st_mode) for p in [directory, *directory.rglob("*")] if p.is_dir()]
    for p, _mode in saved:
        p.chmod(0o555)

    def restore() -> None:
        for p, mode in saved:
            p.chmod(statmod.S_IMODE(mode))

    return restore


def write_denied(directory: Path) -> bool:
    """Denial is asserted, never assumed: a mode that a root-owned or ACL-governed run
    ignores would make every "did not write" assertion below vacuous."""
    probe = directory / ".write-probe"
    try:
        probe.write_text("x", encoding="utf-8")
    except OSError:
        return True
    probe.unlink()
    return False


def tree_snapshot(directory: Path, prefix: str = "") -> list[str]:
    """Paths, types, modes, symlink targets, content and directory mtimes: the whole of
    what "the tree is byte-for-byte what it was" has to mean here. Content alone would
    miss a staging directory created and removed between the two reads — its parent's
    mtime is the only trace that survives."""
    out: list[str] = []
    for name in sorted(os.listdir(directory)):
        abs_path = directory / name
        rel = name if prefix == "" else f"{prefix}/{name}"
        st = abs_path.lstat()
        mode = oct(statmod.S_IMODE(st.st_mode))
        if statmod.S_ISLNK(st.st_mode):
            out.append(f"L {rel} {mode} {os.readlink(os.fsencode(abs_path))!r}")
        elif statmod.S_ISDIR(st.st_mode):
            out.append(f"D {rel} {mode} {st.st_mtime_ns}")
            out.extend(tree_snapshot(abs_path, rel))
        else:
            digest = hashlib.sha256(abs_path.read_bytes()).hexdigest()
            out.append(f"F {rel} {mode} {st.st_size} {digest}")
    return out


def verify_residue() -> set[str]:
    """Staging directories left behind in the OS temp dir. Compared as a delta, since
    the suite's other tests run against the same temp dir."""
    return {n for n in os.listdir(tempfile.gettempdir()) if n.startswith("leji-verify-")}


def test_check_integrity_verifies_a_write_denied_host_tree_twice_without_touching_it(
    tmp_path,
) -> None:
    # `mounts status --check-integrity` staged its comparison tree inside the host's
    # own .leji/mounts/, so the read-only diagnostic wrote into the tree it was
    # diagnosing — and could not run at all where that tree is not writable.
    host, _sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    hydrate_mounts(host, manifest)
    restore = deny_writes(Path(host))
    try:
        assert write_denied(Path(host) / ".leji" / "mounts"), "the mounts dir is write-denied"
        assert write_denied(Path(host)), "the host root is write-denied"
        before = tree_snapshot(Path(host))
        residue_before = verify_residue()
        # Twice: once proves it runs, twice proves the second run is not consuming
        # residue the first left behind.
        assert mount_status(host, manifest, check_integrity=True)[0]["verified"] is True
        assert mount_status(host, manifest, check_integrity=True)[0]["verified"] is True
        # The other two callers of the same verification, on the same denied tree.
        loc = locate_mount(host, manifest, "acme-product-context")
        assert loc["present"] is True
        assert loc["verified"] is True
        assert federation_enforcement(host, manifest, "available", None) == []
        assert tree_snapshot(Path(host)) == before, "verification wrote into the host tree"
        assert verify_residue() - residue_before == set(), "staging outlived its verification"
    finally:
        restore()


def test_two_verifications_at_once_in_one_process_do_not_collide(tmp_path) -> None:
    """Two threads running rounds of verification of the host's only mount, every round
    entered through a two-thread rendezvous, with the lagging thread then held back to
    about half of its last round.

    Both halves earn their place. Without the rendezvous the threads drift into taking
    turns and never overlap; with the rendezvous alone they run identical work in
    lockstep, and two threads staging the same content into one shared directory at the
    same instant still agree — the interleaving that a shared staging directory cannot
    survive is one thread starting while the other is mid-verification. Threads, so "the
    same process" is literal: a staging name derived from the pid is one name for both
    of them."""
    host, _sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    hydrate_mounts(host, manifest)
    m = manifest["federation"]["mounts"][0]
    mount = MountDecl(
        name=m["name"], source=m["source"], pin=m["pin"], tracking_ref=m.get("trackingRef")
    )
    residue_before = verify_residue()
    rounds = 8
    gate = threading.Barrier(2)

    def verify_rounds(lag: bool) -> list[object]:
        results: list[object] = []
        last = 0.040
        for _ in range(rounds):
            gate.wait()
            if lag:
                time.sleep(max(0.005, last / 2))
            started_at = time.monotonic()
            try:
                results.append(verify_projection(host, mount))
            except OSError as exc:  # a collision surfaces as ENOENT/ENOTEMPTY
                results.append(f"raised {exc.errno}")
            last = time.monotonic() - started_at
        return results

    with ThreadPoolExecutor(max_workers=2) as pool:
        both = list(pool.map(verify_rounds, [False, True]))
    # Every one of them verified: a shared staging path has one thread deleting or
    # half-writing the tree the other is comparing, which surfaces as ENOENT,
    # ENOTEMPTY, or a false verdict on content nobody tampered with.
    assert both == [[True] * rounds, [True] * rounds]
    assert verify_residue() - residue_before == set()


@contextmanager
def _mkdtemp_denied():
    """The allocator seam. An unwritable TMPDIR is not the lever here: ``tempfile``
    falls back to other candidate directories when TMPDIR is unusable and caches the
    one it picked, so the test would allocate successfully and never reach the branch
    it exists to cover. Restored on the way out."""
    original = tempfile.mkdtemp

    def deny(*_args: object, **_kwargs: object) -> str:
        raise PermissionError(errno.EACCES, "Permission denied")

    tempfile.mkdtemp = deny  # type: ignore[assignment]
    try:
        yield
    finally:
        tempfile.mkdtemp = original


def test_an_unusable_temp_directory_makes_verification_unverifiable_never_in_tree(
    tmp_path,
) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    hydrate_mounts(host, manifest)
    before = tree_snapshot(Path(host))
    residue_before = verify_residue()
    with _mkdtemp_denied():
        # Unknown: no staging area is a missing prerequisite, exactly like no reachable
        # object store. It is never a pass, never a failure, and never a reason to fall
        # back into the host tree.
        row = mount_status(host, manifest, check_integrity=True)[0]
        assert row["present"] is True
        assert row["verified"] is None
        loc = locate_mount(host, manifest, "acme-product-context")
        assert loc["present"] is True
        assert loc["verified"] is False
        assert "present but not verified" in str(loc["detail"])
        assert "verification prerequisites are unavailable" in str(loc["detail"])
        # The diagnostic names the prerequisite that was actually missing rather than
        # blaming the object store, which is reachable here: a reader told to check
        # their hint would be reading the wrong end of the failure.
        findings = federation_enforcement(host, manifest, "available", None)
        assert len(findings) == 1
        assert "cannot be verified" in findings[0].message
        assert "verification prerequisites unavailable" in findings[0].message
        assert "no writable temp dir" in findings[0].message
    assert tree_snapshot(Path(host)) == before, "verification fell back into the host tree"
    assert verify_residue() - residue_before == set(), "nothing was staged"


def test_a_reachable_store_without_the_pin_is_unverifiable_and_names_the_prerequisite(
    tmp_path,
) -> None:
    host, _sibling, _pin = mounted_pair(tmp_path)
    manifest = load_manifest(host).manifest
    assert manifest is not None
    hydrate_mounts(host, manifest)
    # A real repository, reachable, that simply does not contain this pin. The
    # published projection stays published — its cache key comes from the
    # declaration, not from whichever store happens to be reachable — so the only
    # missing prerequisite is the commit the comparison would be made against.
    other = Path(host).parent / "other"
    other.mkdir()
    git(other, "init", "-q", "-b", "main")
    (other / "unrelated.md").write_text("# unrelated\n", encoding="utf-8")
    git(other, "add", "-A")
    git(
        other,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "unrelated",
    )
    (Path(host) / ".leji" / "mounts.local.json").write_text(
        json.dumps({"mounts": {"acme-product-context": {"repo": "../other"}}}) + "\n",
        encoding="utf-8",
    )
    m = manifest["federation"]["mounts"][0]
    mount = MountDecl(
        name=m["name"], source=m["source"], pin=m["pin"], tracking_ref=m.get("trackingRef")
    )
    assert verify_projection(host, mount) is None
    row = mount_status(host, manifest, check_integrity=True)[0]
    assert row["present"] is True
    assert row["verified"] is None
    loc = locate_mount(host, manifest, "acme-product-context")
    assert loc["present"] is True
    assert loc["verified"] is False
    # The parenthetical is the whole of what makes a projection unverifiable. An
    # exhaustive-looking list that omits this branch tells the reader their object
    # store is unreachable when it is reachable and their pin is what is missing.
    findings = federation_enforcement(host, manifest, "available", None)
    assert len(findings) == 1
    assert findings[0].message == (
        'mount "acme-product-context" projection cannot be verified (verification '
        "prerequisites unavailable: no reachable object store, unresolvable pin, or "
        "no writable temp dir); an unverified cache is not evidence"
    )
