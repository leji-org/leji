"""The trust-domain boundary, driven from the shared fixtures: nothing under
`.leji/` except `viewer/` is servable, and no export carries a byte of it. The
fixtures own the request corpus (`trustCanary`) and the layout claims
(`export.layout`), so all three SDKs answer identical requests against identical
bytes. Mirrors packages/sdk/test/canary.test.ts.

Scope: the four F8 layout fixtures — their layout roles, their golden export bytes,
and their canary corpus. The general `export`-block harness (findings, `--strict`
variants) takes every other fixture.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import posixpath
import shutil
import threading
from pathlib import Path
from typing import Callable

import pytest

from leji import build_viewer, generate_viewer, load_manifest
from leji import export_cmd, fsx
from leji.serve_cmd import serve_viewer

LAYOUT_FIXTURES = [
    "valid-unified-leji-fresh",
    "valid-unified-leji-stale-tree",
    "valid-trust-canary-nested-root",
    "valid-trust-canary-dot-root",
]

# The planted byte string. Spelled in each harness and deliberately in no
# `expected.json`: under `rootPath: "."` a fixture's own metadata is exported like
# any other file, so a token literal there would count as a leak.
TOKEN = "LEJI-TRUST-CANARY"

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"


def _fixture_rel(value: str, what: str) -> str:
    """A fixture-declared path, as the README fixes it: repository-root-relative
    POSIX, normalized, no `..` segment, never absolute. A violation is a harness
    error — the fixture is the contract, so a malformed one fails loudly rather than
    being repaired here."""
    assert not posixpath.isabs(value), f"{what} must be relative: {value}"
    normalized = posixpath.normpath(value).rstrip("/")
    assert normalized == value.rstrip("/"), f"{what} must be normalized: {value}"
    assert ".." not in normalized.split("/"), f"{what} must not escape the fixture: {value}"
    return normalized


def _fixture_abs(directory: Path, rel: str) -> Path:
    """Join a fixture-declared POSIX path onto a working copy."""
    return directory.joinpath(*rel.split("/"))


def _copy_seed(src: Path, dest: Path) -> None:
    """Copy a committed seed's CONTENTS into `dest`, which the harness creates.
    Regular files and directories only: a symlink anywhere inside a seed is a harness
    error, and no seed file is ever executed, so modes stay the platform's default."""
    dest.mkdir(parents=True, exist_ok=True)
    for entry in sorted(src.iterdir(), key=lambda p: p.name):
        assert not entry.is_symlink(), f"seed carries a symlink: {entry}"
        target = dest / entry.name
        if entry.is_dir():
            assert entry.name not in (".leji", "dist"), (
                f'seed path component "{entry.name}" is gitignored at any depth; '
                "spell it under the seed name"
            )
            _copy_seed(entry, target)
        else:
            assert entry.is_file(), f"seed carries a non-regular file: {entry}"
            shutil.copy2(entry, target)


def _materialize(factory: pytest.TempPathFactory, name: str, seeds: list[dict]) -> Path:
    """A pristine working copy of the fixture with every declared seed materialized."""
    directory = factory.mktemp("leji-canary")
    shutil.copytree(FIXTURES / name, directory, dirs_exist_ok=True)
    targets: list[str] = []
    for seed in seeds:
        src = _fixture_rel(seed["from"], "seed.from")
        to = _fixture_rel(seed["to"], "seed.to")
        to_abs = _fixture_abs(directory, to)
        # A pre-existing target means the working copy is not what the harness thinks
        # it is; overlapping targets are a fixture-authoring error, not something to
        # resolve by ordering.
        assert not to_abs.exists(), f"seed target already exists: {to}"
        for other in targets:
            assert to != other and not to.startswith(other + "/"), (
                f"seed targets overlap: {to} and {other}"
            )
        targets.append(to)
        _copy_seed(_fixture_abs(directory, src), to_abs)
    return directory


def _snapshot(directory: Path) -> list[tuple[str, str]]:
    """Every path under `directory` as `rel -> content digest` (directories as
    `rel/` -> ''), so a comparison covers appearance and disappearance as well as
    content."""
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


def _files_under(directory: Path) -> list[str]:
    """Every file under `directory`, as export-root-relative POSIX paths, sorted."""
    return sorted(
        str(p.relative_to(directory)).replace("\\", "/")
        for p in directory.rglob("*")
        if p.is_file()
    )


def _golden_path(fixture_root: Path, declared: str, what: str) -> Path:
    """A golden artifact at its declared name, or at the dot-prefixed name beside it:
    a `rootPath: "."` fixture exports its own root, so a plainly named golden would be
    exported into the next bake of itself. The dot form is skipped by the content
    walk, which is what makes it committable there (fixtures/README.md)."""
    head, _, rest = _fixture_rel(declared, what).partition("/")
    plain = _fixture_abs(fixture_root, head if not rest else f"{head}/{rest}")
    if plain.exists():
        return plain
    return _fixture_abs(fixture_root, "." + head if not rest else f".{head}/{rest}")


def _count_token(directory: Path) -> tuple[int, list[str]]:
    """Recursive occurrences of the token under `directory` (an absent directory
    counts as zero, which is what a run that wrote no tree leaves behind)."""
    if not directory.exists():
        return 0, []
    count = 0
    where: list[str] = []
    needle = TOKEN.encode()
    for dirpath, _dirnames, filenames in os.walk(directory):
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_symlink() or not path.is_file():
                continue
            hits = path.read_bytes().count(needle)
            if hits:
                count += hits
                where.append(str(path.relative_to(directory)))
    return count, where


def _serve(directory: Path, manifest: dict) -> tuple[int, Callable[[], None]]:
    """Start the viewer over `directory`; returns its port and a stop callable."""
    server = serve_viewer(str(directory), 0, manifest["rootPath"])
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def stop() -> None:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    return server.server_address[1], stop


def _request(port: int, url_path: str) -> tuple[int, str]:
    """Issue one request with the corpus's path EXACTLY as written — no URL parsing
    on this side, or the encoded and malformed variants would be canonicalized before
    the server ever saw them."""
    conn = http.client.HTTPConnection("127.0.0.1", port)
    try:
        conn.request("GET", url_path)
        response = conn.getresponse()
        return response.status, response.read().decode("utf-8", "replace")
    finally:
        conn.close()


def _expected(name: str) -> dict:
    return json.loads((FIXTURES / name / "expected.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", LAYOUT_FIXTURES)
def test_layout_fixture_canary_and_idempotency(
    name: str, tmp_path_factory: pytest.TempPathFactory
) -> None:
    expected = _expected(name)
    expected_export = expected.get("export")
    canary = expected.get("trustCanary")
    assert expected_export is not None, f"{name} declares an export block"

    directory = _materialize(tmp_path_factory, name, expected.get("seeds") or [])
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None, "the fixture manifest loads"

    # The planted bytes are really planted: without this the scans below could pass
    # over a fixture that plants nothing.
    planted_before: dict[str, str] = {}
    for rel in (canary or {}).get("plantedPaths", []):
        text = _fixture_abs(directory, _fixture_rel(rel, "plantedPaths entry")).read_text(
            encoding="utf-8"
        )
        assert TOKEN in text, f"{rel} carries the canary token"
        planted_before[rel] = text
    # Every path the fixture says must survive the run, as it stands before it.
    layout = expected_export.get("layout") or {}
    preserved_before: dict[str, str] = {}
    for rel in layout.get("preserved", []):
        abs_path = _fixture_abs(directory, _fixture_rel(rel, "preserved entry"))
        assert abs_path.exists(), f"preserved path exists before the run: {rel}"
        if abs_path.is_file():
            preserved_before[rel] = abs_path.read_text(encoding="utf-8")

    # --- the run ------------------------------------------------------------
    first = build_viewer(str(directory), manifest)
    exit_code = 1 if any(f.severity == "error" for f in first.findings) else 0
    assert exit_code == expected_export["exit"], f"exit code (findings: {first.findings})"
    assert first.out.replace(os.sep, "/") == expected_export["out"], "the declared output directory"

    # --- layout -------------------------------------------------------------
    for role, role_dir in (layout.get("roles") or {}).items():
        abs_path = _fixture_abs(directory, _fixture_rel(role_dir, f"role {role}"))
        assert abs_path.is_dir(), f"role {role} established at {role_dir}"
    for rel in layout.get("present", []):
        assert _fixture_abs(directory, _fixture_rel(rel, "present entry")).exists(), (
            f"present after the run: {rel}"
        )
    for rel in layout.get("absent", []):
        assert not _fixture_abs(directory, _fixture_rel(rel, "absent entry")).exists(), (
            f"never created: {rel}"
        )
    for rel, before in preserved_before.items():
        abs_path = _fixture_abs(directory, rel)
        assert abs_path.exists(), f"still present after the run: {rel}"
        assert abs_path.read_text(encoding="utf-8") == before, f"byte-identical: {rel}"

    # --- the golden tree ------------------------------------------------------
    golden = expected_export["goldenTree"]
    if golden["status"] == "baked":
        out = _fixture_abs(directory, _fixture_rel(expected_export["out"], "export out"))
        fixture_root = FIXTURES / name
        content_dir = _golden_path(fixture_root, golden["contentDir"], "goldenTree.contentDir")
        manifest_file = _golden_path(fixture_root, golden["manifest"], "goldenTree.manifest")
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
        golden_manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        assert golden_manifest["version"] == 1, "the manifest states its version"
        assert sorted(golden_manifest["files"]) == outside, (
            f"{name}: the manifest pins every file outside content/"
        )
        for rel in outside:
            data = out.joinpath(*rel.split("/")).read_bytes()
            pin = golden_manifest["files"][rel]
            assert hashlib.sha256(data).hexdigest() == pin["sha256"], rel
            assert len(data) == pin["size"], f"{rel} size"

    # --- the export-side scan ------------------------------------------------
    if canary:
        scan_root = _fixture_abs(
            directory, _fixture_rel(canary["exportScan"]["root"], "exportScan.root")
        )
        count, found_in = _count_token(scan_root)
        assert count == canary["exportScan"]["occurrences"], (
            f"canary occurrences in {canary['exportScan']['root']}: {', '.join(found_in)}"
        )

    # --- the serve corpus ----------------------------------------------------
    if canary:
        port, stop = _serve(directory, manifest)
        try:
            scan_bodies = (canary["serve"].get("routeScan") or {}).get(
                "assertNoTokenIn200Bodies", True
            )
            for want in canary["serve"]["requests"]:
                status, body = _request(port, want["path"])
                assert status == want["status"], (
                    f"{want['path']}{' — ' + want['note'] if want.get('note') else ''}"
                )
                if status == 200 and scan_bodies is not False:
                    assert TOKEN not in body, f"no canary byte in the 200 body of {want['path']}"
        finally:
            stop()

    # --- idempotency ---------------------------------------------------------
    if (expected_export.get("rerun") or {}).get("byteIdentical"):
        after_first = _snapshot(directory)
        build_viewer(str(directory), manifest)
        assert _snapshot(directory) == after_first, (
            "a second run is a byte-level no-op across the whole working tree"
        )

    # The planted bytes are still exactly as planted: the tool never read them into
    # anything, and never rewrote them either.
    for rel, before in planted_before.items():
        assert _fixture_abs(directory, rel).read_text(encoding="utf-8") == before, (
            f"untouched: {rel}"
        )


def _canary_layer(factory: pytest.TempPathFactory) -> Path:
    """The dot-root canary layer with its seed materialized: the topology where the
    trust domain sits inside the content mount, so a symlink into it resolves inside
    every containment check and only the by-name whitelist refuses it."""
    return _materialize(
        factory, "valid-trust-canary-dot-root", [{"from": ".leji-seed", "to": ".leji"}]
    )


def _load(directory: Path) -> dict:
    manifest = load_manifest(str(directory)).manifest
    assert manifest is not None
    return manifest


def _patch_manifest(directory: Path, key: str, value: object) -> None:
    path = directory / "leji.json"
    declared = json.loads(path.read_text(encoding="utf-8"))
    declared[key] = value
    path.write_text(json.dumps(declared, indent=2) + "\n", encoding="utf-8")


def test_whitelist_refuses_content_symlink_into_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # The one boundary a fixture cannot plant (a seed carries no symlinks) and the one
    # the dot convention cannot hold: under `rootPath: "."` the trust domain really is
    # inside the content mount, so a symlink there resolves INSIDE the mount root and
    # passes every containment check. Only the by-name whitelist refuses it — remove
    # the servable_path calls in the serve path and this test serves the canary.
    directory = _canary_layer(tmp_path_factory)
    manifest = _load(directory)
    (directory / "leak.md").symlink_to(Path(".leji") / "work" / "proposal.md")
    (directory / "leakdir").symlink_to(Path(".leji") / "work")
    # Generate the chrome (and an export) with the symlinks already planted, so the
    # serve legs run against a complete layer and the export legs see the bait.
    build_viewer(str(directory), manifest)
    port, stop = _serve(directory, manifest)
    try:
        for route in ("/content/leak.md", "/content/leakdir/proposal.md"):
            status, body = _request(port, route)
            assert status == 404, f"{route} is denied by name, whatever it resolves to"
            assert TOKEN not in body, f"no canary byte in the response to {route}"
        # The servable role still serves through its own mount: the whitelist denies
        # the other roles, not the chrome.
        assert _request(port, "/index.html")[0] == 200
    finally:
        stop()
    # And the export never followed it either (symlinks are skipped, and the target is
    # outside the enumerated roots).
    assert _count_token(directory / ".leji" / "dist")[0] == 0, "no canary byte in the export"
    assert not (directory / ".leji" / "dist" / "content" / "leak.md").exists()


# The vectors below share the reason the test above lives here rather than in a
# fixture: they need a symlink (a seed carries none by contract — _copy_seed refuses
# one) or a hostile manifest, which is a per-SDK hazard rather than a shared contract
# the fixtures publish. So they are constructed at runtime, over a fixture's own layer
# and its own planted bytes.


def test_whitelist_refuses_bound_profile_in_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    directory = _canary_layer(tmp_path_factory)
    # A profile pair the resolver really composes: an ordinary base under the layer's
    # agents directory, and a derived half planted in the onboarding workspace, bound
    # into the roster by a symlink at the content root. Without the whitelist on the
    # profile sources, the resolved page renders the planted half verbatim — the
    # overlay answers before the content mount ever judges the path.
    (directory / "agents").mkdir(parents=True, exist_ok=True)
    (directory / "agents" / "core.md").write_text(
        "\n".join(
            [
                "---",
                "id: core",
                "name: Core",
                "role: core",
                "requiredRead:",
                "  - boot-profile.md",
                "mustAskWhen:",
                "  - anything is unclear",
                "---",
                "",
                "Base body.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (directory / ".leji" / "work" / "leak-profile.md").write_text(
        "\n".join(
            [
                "---",
                "id: leak",
                "name: Leak",
                "role: leak",
                "inherits: core",
                "---",
                "",
                f"Planted: {TOKEN}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (directory / "leak.md").symlink_to(Path(".leji") / "work" / "leak-profile.md")
    _patch_manifest(directory, "agents", {"leak": "leak.md"})

    manifest = _load(directory)
    build_viewer(str(directory), manifest)
    port, stop = _serve(directory, manifest)
    try:
        status, body = _request(port, "/content/leak.md")
        assert status == 404, "the profile overlay refuses a source it may not read"
        assert TOKEN not in body, "no canary byte in the response"
        # The overlay still resolves the profiles it may read.
        assert _request(port, "/content/agents/core.md")[0] == 200
    finally:
        stop()
    count, where = _count_token(directory / ".leji" / "dist")
    assert count == 0, f"no canary byte in the export: {', '.join(where)}"
    assert not (directory / ".leji" / "dist" / "content" / "leak.md").exists()


def test_sidebar_lifts_no_label_out_of_a_private_profiles_dir(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    directory = _canary_layer(tmp_path_factory)
    # The same scan, reached the other way: a declared `agentProfilesPath` naming a
    # private role needs no symlink at all. The page itself was always refused, but the
    # sidebar built its label from the file's frontmatter — bytes of a private file,
    # served in a 200 body and copied into the export.
    (directory / ".leji" / "work" / "p.md").write_text(
        "\n".join(
            [
                "---",
                "id: planted",
                f"name: {TOKEN}",
                "role: planted",
                "requiredRead:",
                "  - boot-profile.md",
                "mustAskWhen:",
                "  - anything is unclear",
                "---",
                "",
                "Body.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    _patch_manifest(directory, "machine", {"agentProfilesPath": ".leji/work/"})
    manifest = _load(directory)
    build_viewer(str(directory), manifest)
    count, where = _count_token(directory / ".leji" / "dist")
    assert count == 0, f"no canary byte in the export: {', '.join(where)}"
    port, stop = _serve(directory, manifest)
    try:
        status, body = _request(port, "/content/_sidebar.md")
        assert status == 200, "the live sidebar still builds"
        assert TOKEN not in body, "and carries no byte of the planted profile"
    finally:
        stop()


# --- The check-before-act invariant on WRITE/CLEAR targets ----------------------------------
# One structural rule: every location the tool writes into or clears is realpath-
# resolved and validated against its role BEFORE the operation — never after, never
# conditionally. These pin the two write-side vectors two review rounds left open.


def test_check_before_act_generation_refuses_viewer_aliased_into_a_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    directory = _canary_layer(tmp_path_factory)
    # Point the servable role at another private role, bytes of its own already there.
    # Before the check-before-act rule, generation wrote the chrome THROUGH the link
    # into the trust domain and only the export's later identity check noticed — after
    # the mutation. The aliased directory is snapshotted WHOLE, so any pre-refusal
    # write (not just an overwrite of one planted file) is caught.
    aliased = directory / ".leji" / "work" / "chrome"
    (aliased / "assets").mkdir(parents=True)
    (aliased / "assets" / "planted.txt").write_text(f"{TOKEN}\n", encoding="utf-8")
    (directory / ".leji" / "viewer").symlink_to(Path("work") / "chrome")
    manifest = _load(directory)
    before = _snapshot(aliased)

    gen = generate_viewer(str(directory), manifest)
    assert any(f.rule == "viewer-target-refused" and f.severity == "error" for f in gen.findings), (
        "generation refuses with a hard error (non-zero exit)"
    )
    assert gen.written == [], "and writes nothing"
    assert _snapshot(aliased) == before, "the aliased private role is byte-identical"

    # build_viewer regenerates first, so it inherits the refusal and never reaches the
    # destructive clean/copy: no export is produced either.
    built = build_viewer(str(directory), manifest)
    assert any(f.rule == "viewer-target-refused" for f in built.findings), (
        "the export inherits the refusal"
    )
    assert _snapshot(aliased) == before, "still untouched after build_viewer"
    assert not (directory / ".leji" / "dist").exists(), "no export was written"


def test_check_before_act_default_output_refuses_dist_into_a_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    directory = _canary_layer(tmp_path_factory)
    # The surviving default-bypass vector: the reservation used to be conditioned on a
    # caller --out, so a default .leji/dist redirected into the trust domain slipped
    # through. Now the default is validated identically — before any clear or write.
    planted = directory / ".leji" / "mounts" / "store" / "x"
    planted.mkdir(parents=True, exist_ok=True)
    (planted / "planted").write_text(f"{TOKEN}\n", encoding="utf-8")
    (directory / ".leji" / "dist").symlink_to(Path("mounts") / "store" / "x")
    manifest = _load(directory)
    before = _snapshot(directory / ".leji" / "mounts")
    with pytest.raises(RuntimeError, match="reserved for the tool's own roles"):
        build_viewer(str(directory), manifest, None)
    assert _snapshot(directory / ".leji" / "mounts") == before, (
        "nothing was cleared or written in the private role"
    )
    assert (planted / "planted").read_text(encoding="utf-8") == f"{TOKEN}\n"


def test_check_before_act_out_of_repository_viewer_or_dist_alias_is_refused(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # Containment is absolute: every write this tool makes lands inside the repository
    # it was pointed at. A `.leji/viewer` or `.leji/dist` symlinked to a real, empty
    # destination outside the tree — once a supported relocate/publish alias — is a
    # hard refusal now, with nothing written through it. A user who wants the export
    # elsewhere copies the finished folder there.
    chrome_home = tmp_path_factory.mktemp("leji-chrome")
    relocated = _canary_layer(tmp_path_factory)
    (relocated / ".leji" / "viewer").symlink_to(chrome_home)
    built = build_viewer(str(relocated), _load(relocated), None)
    assert any(f.rule == "viewer-target-refused" for f in built.findings), (
        "the relocated viewer role is refused"
    )
    assert not built.wrote, "and the export never runs"
    assert list(chrome_home.iterdir()) == [], "nothing was written into the out-of-tree viewer home"

    publish = tmp_path_factory.mktemp("leji-publish")
    published = _canary_layer(tmp_path_factory)
    (published / ".leji" / "dist").symlink_to(publish)
    with pytest.raises(RuntimeError, match="resolves outside the repository"):
        build_viewer(str(published), _load(published), None)
    assert list(publish.iterdir()) == [], "nothing was written into the out-of-tree publish root"


def test_check_before_act_boundary_skip_warns_once_and_a_clean_build_is_silent(
    tmp_path_factory: pytest.TempPathFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    # A servable-looking source (an .md at the content root) whose resolved path lands
    # in a private role: withheld from serve and export, and — unlike an ordinary skip
    # — it says why, exactly once, on stderr (never stdout, never --json).
    directory = _canary_layer(tmp_path_factory)
    (directory / "leak.md").symlink_to(Path(".leji") / "work" / "proposal.md")
    manifest = _load(directory)
    build_viewer(str(directory), manifest, None)
    captured = capsys.readouterr()
    warnings = [line for line in captured.err.split("\n") if line.startswith("skipped leak.md:")]
    assert len(warnings) == 1, f"the withheld source is named exactly once: {captured.err!r}"
    assert "resolves into .leji/work (private); not served or exported" in warnings[0]
    assert "skipped leak.md" not in captured.out, "never on stdout"
    assert _count_token(directory / ".leji" / "dist")[0] == 0, "no canary byte reached the export"

    # A clean layer (no cross-role source) says nothing on stderr.
    clean = _canary_layer(tmp_path_factory)
    build_viewer(str(clean), _load(clean), None)
    assert [
        line for line in capsys.readouterr().err.split("\n") if line.startswith("skipped ")
    ] == [], "a clean build emits no boundary-skip warning"


def test_export_refuses_an_out_that_resolves_into_a_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # The nested topology, deliberately: with the content root a subdirectory, an --out
    # at the repository root is a legitimate destination, so the reservation is the only
    # rule standing between a redirected path and the private domain.
    directory = _materialize(
        tmp_path_factory, "valid-trust-canary-nested-root", [{"from": ".leji-seed", "to": ".leji"}]
    )
    manifest = _load(directory)
    # Proof the destination is otherwise open: an ordinary sibling path exports.
    build_viewer(str(directory), manifest, "plain-out")
    assert (directory / "plain-out" / "index.html").is_file(), "an ordinary --out exports"
    # The same path, redirected: the reservation judges where the write would land, so
    # the private role is refused however the destination is spelled.
    (directory / "redirect").symlink_to(Path(".leji") / "mounts")
    with pytest.raises(RuntimeError, match="reserved for the tool's own roles"):
        build_viewer(str(directory), manifest, "redirect/export")
    assert not (directory / ".leji" / "mounts" / "export").exists(), "nothing written into the role"
    # The refusal is not destructive either: the planted bytes are as planted.
    planted = directory / ".leji" / "mounts" / "store" / "x" / "planted"
    assert TOKEN in planted.read_text(encoding="utf-8"), "the private role is intact"


# --- Check-before-act completeness: the overview.md write sites and the resolver's dangling paths.
# These pin the write sites two review rounds after the first left them: overview.md
# (seed AND refresh) is a content write that used to be guarded by containment only,
# and a nested/chained/unresolvable `--out` whose real destination the resolver used to
# rebuild lexically. Each hard-refusal case names, in its comment, the mutation that
# reddens it.


def _folds_case(directory: Path) -> bool:
    """Whether this directory sits on a filesystem that cannot tell `.leji` from
    `.LEJI` — asked of the volume, so a case-variant assertion runs only where the
    fold is real."""
    probe = directory / "leji-case-probe"
    probe.mkdir(parents=True, exist_ok=True)
    try:
        return (directory / "LEJI-CASE-PROBE").exists()
    finally:
        shutil.rmtree(probe, ignore_errors=True)


def test_check_before_act_generation_refuses_an_overview_seed_aliased_into_a_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # rootPath ".", so overview.md is seeded at the repository root. A symlink there
    # into a private role is contained (inside the repo) yet crosses the trust
    # boundary: containment-only was the gap. The target dangles, so the seed WOULD
    # create it inside the role. Mutation that reddens: revert the overview guard to
    # resolved_within_root-only (no writable_target) — the seed writes through and
    # .leji/<role>/new.md appears.
    for role in ("work", "mounts"):
        directory = _canary_layer(tmp_path_factory)
        role_dir = directory / ".leji" / role
        role_dir.mkdir(parents=True, exist_ok=True)
        (directory / "overview.md").symlink_to(Path(".leji") / role / "new.md")
        manifest = _load(directory)
        before = _snapshot(role_dir)

        gen = generate_viewer(str(directory), manifest)
        assert any(
            f.rule == "viewer-target-refused"
            and f.severity == "error"
            and "overview.md" in f.message
            and f".leji/{role} (private)" in f.message
            for f in gen.findings
        ), f"generation refuses the overview.md seed into .leji/{role} with a hard error"
        assert "overview.md" not in gen.written, "overview.md is not reported written"
        assert not (role_dir / "new.md").exists(), "nothing was written through the alias"
        assert _snapshot(role_dir) == before, f"the aliased .leji/{role} is byte-identical"

    # Generation-side case variant: a `.LEJI/` spelling of a role folds to the role on
    # a case-insensitive volume, so the resolved target is judged, not the spelling.
    directory = _canary_layer(tmp_path_factory)
    if _folds_case(directory):
        (directory / ".leji" / "work").mkdir(parents=True, exist_ok=True)
        (directory / "overview.md").symlink_to(Path(".LEJI") / "work" / "case.md")
        manifest = _load(directory)
        gen = generate_viewer(str(directory), manifest)
        assert any(
            f.rule == "viewer-target-refused" and "overview.md" in f.message for f in gen.findings
        ), "a case-variant overview.md alias is refused as the role it folds to"
        assert not (directory / ".leji" / "work" / "case.md").exists(), (
            "nothing written through the case variant"
        )


def test_check_before_act_overview_refresh_refuses_an_alias_into_a_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # overview.md is a symlink to an EXISTING private file carrying the generated-map
    # markers: the refresh branch (is_file true) used to resolved_within_root-check,
    # read it, and rewrite the map block THROUGH the link. The check now runs on the
    # resolved path before the read. Mutation that reddens: revert to
    # resolved_within_root-only — the private file is read and its map block rewritten.
    directory = _canary_layer(tmp_path_factory)
    target = directory / ".leji" / "mounts" / "existing.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    original = (
        f"# private {TOKEN}\n"
        "<!-- leji:generated-map:start -->STALE<!-- leji:generated-map:end -->\n"
    )
    target.write_text(original, encoding="utf-8")
    (directory / "overview.md").symlink_to(Path(".leji") / "mounts" / "existing.md")
    manifest = _load(directory)

    gen = generate_viewer(str(directory), manifest)
    assert any(
        f.rule == "viewer-target-refused"
        and f.severity == "error"
        and "overview.md" in f.message
        and ".leji/mounts (private)" in f.message
        for f in gen.findings
    ), "the refresh refuses the alias with a hard error"
    assert target.read_text(encoding="utf-8") == original, (
        "the private file was neither read-then-rewritten nor touched"
    )


def test_export_refuses_a_nested_dangling_out_redirecting_into_a_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # `redirect/export` where `redirect` is a DANGLING symlink into a private role: a
    # write would follow it, but the resolver used to climb past the dangling component
    # and rebuild `redirect/export` lexically (outside .leji/), so the check passed and
    # a target created afterward raced the write into the role. The resolver now follows
    # the dangling intermediate link. Mutation that reddens: revert resolved_path's
    # intermediate-symlink follow (climb-past) — out_abs reads as outside .leji/ and the
    # build is not refused.
    directory = _materialize(
        tmp_path_factory, "valid-trust-canary-nested-root", [{"from": ".leji-seed", "to": ".leji"}]
    )
    manifest = _load(directory)
    # redirect -> .leji/mounts/ghost, and ghost does NOT exist: a dangling intermediate.
    (directory / "redirect").symlink_to(Path(".leji") / "mounts" / "ghost")
    mounts_before = _snapshot(directory / ".leji" / "mounts")
    with pytest.raises(RuntimeError, match="reserved for the tool's own roles"):
        build_viewer(str(directory), manifest, "redirect/export")
    assert not (directory / ".leji" / "mounts" / "ghost").exists(), (
        "the dangling target was not created by the build"
    )
    assert _snapshot(directory / ".leji" / "mounts") == mounts_before, (
        "nothing was cleared or written in the private role"
    )

    # The created-after-validation race, closed: even once the target exists, the same
    # resolved path is judged, so the build still refuses (never a one-time dangling
    # fluke that a real directory would slip past).
    (directory / ".leji" / "mounts" / "ghost").mkdir(parents=True)
    with pytest.raises(RuntimeError, match="reserved for the tool's own roles"):
        build_viewer(str(directory), manifest, "redirect/export")


def test_export_refuses_a_chained_dangling_out_that_ends_in_a_private_role(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # redirect -> hop -> .leji/work/ghost, every hop dangling: the resolver follows the
    # chain of intermediate dangling links to the real destination. Mutation that
    # reddens: revert resolved_path's intermediate-symlink follow — the chain is rebuilt
    # lexically as outside .leji/ and the build is not refused.
    directory = _materialize(
        tmp_path_factory, "valid-trust-canary-nested-root", [{"from": ".leji-seed", "to": ".leji"}]
    )
    manifest = _load(directory)
    (directory / "redirect").symlink_to("hop")
    (directory / "hop").symlink_to(Path(".leji") / "work" / "ghost")
    work_before = _snapshot(directory / ".leji" / "work")
    with pytest.raises(RuntimeError, match="reserved for the tool's own roles"):
        build_viewer(str(directory), manifest, "redirect/export")
    assert _snapshot(directory / ".leji" / "work") == work_before, (
        "nothing was cleared or written in the private role"
    )


def test_export_treats_an_unresolvable_out_as_a_failure_not_as_absent(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # A non-ENOENT resolution failure (here an unreadable intermediate directory) must
    # FAIL the check, never be rebuilt lexically as a not-yet-created target. Mutation
    # that reddens: make resolved_path return the lexical path on a non-ENOENT error —
    # the build proceeds instead of refusing. Skipped as root, which bypasses the mode.
    if hasattr(os, "getuid") and os.getuid() == 0:
        pytest.skip("running as root bypasses directory permissions; the EACCES cannot be built")
    directory = _materialize(
        tmp_path_factory, "valid-trust-canary-nested-root", [{"from": ".leji-seed", "to": ".leji"}]
    )
    manifest = _load(directory)
    noperm = directory / "noperm"
    (noperm / "sub").mkdir(parents=True)
    noperm.chmod(0o000)
    try:
        with pytest.raises(RuntimeError, match=r"cannot be resolved \(permission or I/O error\)"):
            build_viewer(str(directory), manifest, "noperm/sub/export")
    finally:
        noperm.chmod(0o755)


def test_check_before_act_refuses_a_case_variant_alias_through_a_non_enumerable_directory(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # The composition the separate case-fold and unresolvable cases left open: a
    # `.LEJI/` spelling of the role tree reached through a directory that is
    # traversable and writable but NOT enumerable. The canonical spelling is read back
    # from the directory, so denying enumeration denies case recovery — and falling
    # back to the caller's spelling made the resolved target compare as outside
    # `.leji/`, so the write and the clear were permitted straight into a private role.
    # An enumeration failure now makes the path unresolvable, which refuses both.
    # Mutation that reddens: return the given name from _real_name on an OSError —
    # generation writes the chrome into .leji/work and the export clears and writes
    # into .leji/mounts.
    if hasattr(os, "getuid") and os.getuid() == 0:
        pytest.skip("running as root bypasses directory permissions; the mode cannot be built")

    # Write side: `.leji/viewer` aliased to `../.LEJI/work/chrome`.
    directory = _canary_layer(tmp_path_factory)
    if not _folds_case(directory):
        pytest.skip("this volume tells .leji from .LEJI; the case-alias vector cannot be built")
    aliased = directory / ".leji" / "work" / "chrome"
    (aliased / "assets").mkdir(parents=True)
    (aliased / "assets" / "planted.txt").write_text(f"{TOKEN}\n", encoding="utf-8")
    (directory / ".leji" / "viewer").symlink_to(Path("..") / ".LEJI" / "work" / "chrome")
    manifest = _load(directory)
    before = _snapshot(aliased)
    # Searchable and writable, but unlistable: the repository directory is the one that
    # holds the canonical spelling of `.leji`.
    directory.chmod(0o311)
    try:
        gen = generate_viewer(str(directory), manifest)
        assert any(
            f.rule == "viewer-target-refused" and f.severity == "error" for f in gen.findings
        ), "generation refuses an unresolvable viewer target"
        assert gen.written == [], "and writes nothing"
        assert _snapshot(aliased) == before, "the aliased private role is byte-identical"
    finally:
        directory.chmod(0o755)

    # Clear side: the default output aliased to an EMPTY directory in a private role,
    # so the clearable-export rule cannot be what refuses it.
    other = _canary_layer(tmp_path_factory)
    (other / ".leji" / "mounts" / "store" / "empty").mkdir(parents=True)
    (other / ".leji" / "dist").symlink_to(Path("..") / ".LEJI" / "mounts" / "store" / "empty")
    other_manifest = _load(other)
    mounts_before = _snapshot(other / ".leji" / "mounts")
    other.chmod(0o311)
    try:
        with pytest.raises(RuntimeError, match=r"cannot be resolved \(permission or I/O error\)"):
            build_viewer(str(other), other_manifest, None)
    finally:
        other.chmod(0o755)
    assert _snapshot(other / ".leji" / "mounts") == mounts_before, (
        "nothing was cleared or written in the private role"
    )


# --- Check-before-act: the check/use gap on the READ side -----------------------------------
# These need a mutation landing at one exact moment inside a run, which no fixture can
# plant, so they are constructed here — over the canary layer, with the planted bytes
# in a private role. Each names, in its comment, the mutation that reddens it.


class _ListedScan:
    """A materialized `os.scandir` result: the entries are read eagerly so a swap
    performed the instant the listing returns cannot change what the walk enumerated —
    which is exactly the window these canaries exercise."""

    def __init__(self, entries: list) -> None:
        self._it = iter(entries)

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> bool:
        return False

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._it)

    def close(self) -> None:
        pass


def _swap_into_private_role(directory: Path, name: str) -> None:
    """Replace the content directory `name` with a symlink into `.leji/work/swapped`,
    where the planted bytes already sit."""
    (directory / name).rename(directory / f"{name}-real")
    (directory / name).symlink_to(Path(".leji") / "work" / "swapped")


def _plant_decoy(directory: Path) -> None:
    """The decoy the swapped ancestor would resolve to: a private role holding files
    named exactly as the carried ones, so a follow lands planted bytes in the export."""
    decoy = directory / ".leji" / "work" / "swapped"
    decoy.mkdir(parents=True, exist_ok=True)
    (decoy / "overview.md").write_text(f"# planted {TOKEN}\n", encoding="utf-8")
    (decoy / "asset.txt").write_text(f"{TOKEN}\n", encoding="utf-8")
    (directory / "domain" / "asset.txt").write_text("an ordinary carried asset\n", encoding="utf-8")


def _assert_dropped_not_followed(directory: Path, err: str, why: str) -> None:
    """Every read-side canary ends the same way: the export ran to completion, carried
    no planted byte, dropped the redirected sources rather than following them, and
    said why — once per source, on stderr."""
    dist = directory / ".leji" / "dist"
    assert (dist / "index.html").is_file(), "the export still ran to completion"
    count, where = _count_token(dist)
    assert count == 0, f"no planted byte may reach the export: {', '.join(where)}"
    for rel in ("overview.md", "asset.txt"):
        assert not (dist / "content" / "domain" / rel).exists(), f"{why}: {rel}"
    # A source that now resolves into a private role is a level-2 refusal: dropping it
    # silently would leave an operator with a quietly shorter export and no reason.
    warnings = [line for line in err.split("\n") if line.startswith("skipped domain/")]
    assert warnings, f"the redirected sources must be named on stderr: {err!r}"
    for line in warnings:
        assert "resolves into .leji/work (private); not served or exported" in line


def test_check_before_act_ancestor_swapped_after_enumeration_is_never_followed(
    tmp_path_factory: pytest.TempPathFactory, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # The content walk enumerates a real directory; before the export uses what it
    # enumerated, that directory becomes a symlink into a private role. Every later read
    # or copy BY PATH then goes through the link, with the walk's checks all behind it —
    # and a revalidation that lstats the final component alone follows the swapped
    # ancestor to a perfectly ordinary file. So a carried source is resolved, its
    # RESOLVED path judged, and its bytes taken from the descriptor fstat proved a
    # regular file: the check and the use hold one inode. Mutation that reddens:
    # revalidate with lstat and read/copy by path again — the planted bytes below are
    # linted and land in the export.
    directory = _canary_layer(tmp_path_factory)
    _plant_decoy(directory)
    manifest = _load(directory)

    # The swap, at the one moment that matters: after the walk has read `domain/`'s
    # entries and before it uses any of them. Generation runs first over the same tree,
    # so the hook arms only once the export resolves its own output target — the first
    # thing the pipeline does after generating.
    domain_dir = directory / "domain"
    dist_abs = directory / ".leji" / "dist"
    state = {"armed": False, "swapped": False}
    real_scandir = os.scandir
    real_resolver = export_cmd.resolved_path_under

    def arming_resolver(base: str, abs_path: str):
        if os.path.abspath(abs_path) == str(dist_abs):
            state["armed"] = True
        return real_resolver(base, abs_path)

    def swapping_scandir(path):
        with real_scandir(path) as it:
            entries = list(it)
        if state["armed"] and not state["swapped"] and os.path.abspath(path) == str(domain_dir):
            state["swapped"] = True
            _swap_into_private_role(directory, "domain")
        return _ListedScan(entries)

    monkeypatch.setattr(export_cmd, "resolved_path_under", arming_resolver)
    monkeypatch.setattr(os, "scandir", swapping_scandir)
    build_viewer(str(directory), manifest, None)
    monkeypatch.undo()

    assert state["swapped"], "the ancestor must have been swapped between the walk and the use"
    _assert_dropped_not_followed(
        directory,
        capsys.readouterr().err,
        "the redirected source must be dropped rather than followed",
    )


def test_check_before_act_ancestor_swapped_between_check_and_open_is_caught_by_the_recheck(
    tmp_path_factory: pytest.TempPathFactory, capsys: pytest.CaptureFixture[str], monkeypatch
) -> None:
    # The residual the descriptor pinning left: the swap lands AFTER the resolve that
    # authorized the source and BEFORE the open on it, so the open follows the new link
    # and the descriptor holds planted bytes while every check has already passed on the
    # authorized path. fstat cannot see it — the decoy is a perfectly ordinary regular
    # file. The recheck after the open resolves the source once more and requires the
    # same location AND the same file identity, so the bytes about to be read are proved
    # to be the ones the check judged. Mutation that reddens: drop the recheck in
    # open_verified_source and trust fstat alone — the planted bytes land in the export.
    directory = _canary_layer(tmp_path_factory)
    _plant_decoy(directory)
    manifest = _load(directory)

    domain_dir = directory / "domain"
    dist_abs = directory / ".leji" / "dist"
    state = {"armed": False, "swapped": False}
    real_resolver = fsx.resolved_path_under
    export_resolver = export_cmd.resolved_path_under

    def arming_resolver(base: str, abs_path: str):
        if os.path.abspath(abs_path) == str(dist_abs):
            state["armed"] = True
        return export_resolver(base, abs_path)

    def swapping_resolver(base: str, abs_path: str):
        real = real_resolver(base, abs_path)
        if (
            state["armed"]
            and not state["swapped"]
            and real is not None
            and os.path.dirname(real) == str(domain_dir)
        ):
            state["swapped"] = True
            _swap_into_private_role(directory, "domain")
        return real

    monkeypatch.setattr(export_cmd, "resolved_path_under", arming_resolver)
    monkeypatch.setattr(fsx, "resolved_path_under", swapping_resolver)
    build_viewer(str(directory), manifest, None)
    monkeypatch.undo()

    assert state["swapped"], "the ancestor must have been swapped between the check and the open"
    _assert_dropped_not_followed(
        directory,
        capsys.readouterr().err,
        "the source whose path and descriptor diverged is dropped, never read",
    )


def test_export_refuses_a_dangling_output_entry_and_creates_nothing(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # A dangling symlink is a standing entry under both forms — never written through,
    # never read as absent. The output used to be resolved before anything judged it,
    # so `.leji/dist -> site` with `site` missing BECAME its own destination: the stat
    # reported absence, "clearable" followed, and the export created and filled the
    # link's target. The original entry is judged first now. Mutation that reddens:
    # drop the lstat on the original entry — the build writes through the link.
    directory = _materialize(
        tmp_path_factory, "valid-trust-canary-nested-root", [{"from": ".leji-seed", "to": ".leji"}]
    )
    manifest = _load(directory)
    # Settle the internal chrome first: every build regenerates it, so the comparison
    # below measures the export's destructive half and nothing else.
    generate_viewer(str(directory), manifest)

    (directory / ".leji" / "dist").symlink_to(Path("..") / "site")
    (directory / "published").symlink_to("elsewhere")
    before = _snapshot(directory)

    with pytest.raises(RuntimeError, match="it is a dangling symlink"):
        build_viewer(str(directory), manifest, None)
    with pytest.raises(RuntimeError, match="it is a dangling symlink"):
        build_viewer(str(directory), manifest, "published")

    assert (directory / ".leji" / "dist").is_symlink(), "the default link is left in place"
    assert (directory / "published").is_symlink(), "the --out link is left in place"
    assert not (directory / "site").exists(), "the default link destination was never created"
    assert not (directory / "elsewhere").exists(), "the --out link destination was never created"
    assert _snapshot(directory) == before, "and the tree is byte-identical"
