"""`leji export` and `leji viewer build`: one operation, two permanently supported
names. What this file pins is the part of that operation the other suites cannot
see: that the pipeline carries no network dependency, that the two names really are
one code path, that no destination flag exists, that `--strict` is scoped to the lint
class, and that a failed run leaves an existing export byte-untouched.

Mirrors packages/sdk/test/export.test.ts, minus the two legs whose mechanism is
Node's alone (the subprocess spy and the route-equivalence crawl, which the
reference suite owns for all three: the ports do not re-implement the crawler, and
the byte-identical export tree carries its result transitively).
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import shutil
from pathlib import Path

from leji import generate_viewer, load_manifest, render_overview
from leji.cli import main
from leji.export_cmd import STRICT_LINT_RULES
from leji.schemas import load_cli_spec
from leji.viewer_cmd import build_layer_map

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = REPO_ROOT / "examples" / "monorepo"
FIXTURES = REPO_ROOT / "fixtures"
SRC = Path(__file__).resolve().parents[1] / "src" / "leji"


def _copy(src: Path, dest: Path) -> Path:
    shutil.copytree(src, dest)
    return dest


def _snapshot(directory: Path) -> list[tuple[str, str]]:
    """Every path under `directory` as `rel -> content digest` (directories as `rel/`
    -> ''), so a comparison covers appearance and disappearance as well as content."""
    if not directory.exists():
        return []
    acc: list[tuple[str, str]] = []
    for p in sorted(directory.rglob("*")):
        rel = str(p.relative_to(directory)).replace("\\", "/")
        if p.is_symlink():
            acc.append((rel, "non-regular"))
        elif p.is_dir():
            acc.append((rel + "/", ""))
        elif p.is_file():
            acc.append((rel, hashlib.sha256(p.read_bytes()).hexdigest()))
        else:
            acc.append((rel, "non-regular"))
    return sorted(acc)


# --- module topology ----------------------------------------------------------
# The structural prong of the no-network guarantee: the export module's transitive
# STATIC import set is CLOSED — every module it reaches outside the package is named
# below, and nothing else may appear. Stated as a denylist the proof would only be as
# complete as the list of network modules someone thought to write down (`imaplib`,
# `telnetlib`, `urllib3`, `websockets`, next year's client library — all invisible);
# stated as a subset, a new dependency of any kind reddens this test until someone
# classifies it deliberately. It catches the static introduction of a dependency and
# nothing else; dynamic side doors are covered by the offline CI leg, and the
# subprocess claim (git and nothing else) by the reference suite's spy.
#
# Every entry below has been checked: none of them opens a socket. Adding one is that
# same decision, made again.
EXPORT_IMPORTS = {
    "__future__",
    "dataclasses",
    "datetime",
    "errno",
    "functools",
    "hashlib",
    "importlib.metadata",
    "importlib.resources",
    "json",
    "os",
    "pathlib",
    "posixpath",
    "re",
    "secrets",
    "shutil",
    "stat",
    "subprocess",
    "sys",
    "tempfile",
    "typing",
    "unicodedata",
    # The package's two declared dependencies: schema validation and the frontmatter
    # parser. Neither is a network client.
    "jsonschema.exceptions",
    "jsonschema.validators",
    "yaml",
}


def _imports_of(path: Path) -> list[str]:
    """Every module `path` imports statically, anywhere in the file — module level
    and inside a function alike, since a deferred import pulls a module in exactly as
    a top-level one does. A package-relative import comes back as `.<module>`."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                # `from .fsx import x` and `from . import fsx` alike name a sibling.
                if node.module:
                    out.append(f".{node.module}")
                else:
                    out.extend(f".{alias.name}" for alias in node.names)
            elif node.module:
                out.append(node.module)
    return out


def _module_graph(entry: str) -> tuple[set[str], set[str]]:
    """The transitive closure of `entry` over sibling modules of the `leji` package,
    as module names, plus every external module reached along the way. Third-party
    packages are recorded, never walked — exactly as the reference's graph records a
    bare specifier without walking node_modules."""
    modules: set[str] = set()
    external: set[str] = set()
    stack = [entry]
    while stack:
        name = stack.pop()
        if name in modules:
            continue
        modules.add(name)
        source = SRC / f"{name}.py"
        assert source.is_file(), f"{name} resolves to a source file"
        for spec in _imports_of(source):
            if spec.startswith("."):
                stack.append(spec[1:])
            else:
                external.add(spec)
    return modules, external


def test_module_graph_of_the_export_imports_only_classified_modules() -> None:
    modules, external = _module_graph("export_cmd")
    # The graph is real: the export pulls in the chrome generation and the rendering
    # lint, so an empty or truncated walk cannot pass this test by accident.
    assert "viewer_cmd" in modules, f"the graph reaches the generator: {sorted(modules)}"
    assert "renderlint" in modules, "the graph reaches the rendering lint"
    assert "mounts" in modules, "the graph reaches the mount status the manifest page renders"
    assert len(modules) >= 8, f"the graph is not truncated: {sorted(modules)}"
    assert "serve_cmd" not in modules, "the export never reaches the serve module"

    unclassified = sorted(external - EXPORT_IMPORTS)
    assert not unclassified, (
        f"the export module graph imports {unclassified}, which this test has not "
        "classified: check that it opens no socket, then name it in EXPORT_IMPORTS"
    )

    # Positive control: the serve module DOES import http.server, so the assertions
    # above are testing a real property rather than a walker that sees nothing.
    _, serve_external = _module_graph("serve_cmd")
    assert "http.server" in serve_external, "the serve module graph imports http.server"


# --- name equivalence ---------------------------------------------------------


def test_export_and_viewer_build_write_byte_identical_trees(tmp_path: Path, capsys) -> None:
    a = _copy(EXAMPLE, tmp_path / "a")
    b = _copy(EXAMPLE, tmp_path / "b")
    assert main(["export", "--root", str(a), "--json"]) == 0
    first = capsys.readouterr().out
    assert main(["viewer", "build", "--root", str(b), "--json"]) == 0
    second = capsys.readouterr().out
    # The same JSON document under both names, `command` included: the second name is
    # the same operation, not a second command that resembles it.
    doc = json.loads(first)
    assert doc["command"] == "export"
    assert first == second, "byte-identical under both names"
    assert doc["out"] == ".leji/dist"
    assert _snapshot(b) == _snapshot(a), "identical working trees"


# --- canonical JSON on every path ---------------------------------------------


def test_export_emits_its_canonical_document_on_every_path(tmp_path: Path, capsys) -> None:
    (tmp_path / "leji.json").write_text("{ this is not a manifest\n", encoding="utf-8")

    assert main(["export", "--root", str(tmp_path), "--json"]) == 1
    first = capsys.readouterr().out
    assert main(["viewer", "build", "--root", str(tmp_path), "--json"]) == 1
    second = capsys.readouterr().out
    # One document shape for every outcome of this command: the pre-pipeline failure is
    # NOT reported in the generic {command, ok, findings, summary} envelope.
    doc = json.loads(first)
    assert list(doc) == ["command", "ok", "out", "findings", "warning"]
    assert doc["command"] == "export"
    assert doc["ok"] is False
    assert doc["out"] == ".leji/dist"
    assert any(f["severity"] == "error" for f in doc["findings"]), (
        f"the unreadable manifest is reported: {doc['findings']}"
    )
    assert doc["warning"].startswith("This is your context layer")
    assert first == second, "byte-identical under both names"

    # A caller `--out` is reported as the caller wrote it, on the same shape.
    assert main(["export", "--root", str(tmp_path), "--out", "site", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["out"] == "site"


# --- arg rejection ------------------------------------------------------------


def test_export_takes_no_destination_flag_and_its_help_names_no_network(
    tmp_path: Path, capsys
) -> None:
    layer = _copy(EXAMPLE, tmp_path / "layer")
    for argv in (
        ["export", "--endpoint", "x"],
        ["export", "--url", "https://example.invalid"],
        ["export", "--host", "example.invalid"],
        ["export", "--token", "secret"],
        ["export", "--port", "8080"],
        ["viewer", "build", "--endpoint", "x"],
    ):
        assert main([*argv, "--root", str(layer)]) == 2, f"{' '.join(argv)} is a usage error"
        capsys.readouterr()
    # The accept side of the same guarantee, under BOTH names: the allow-list the
    # rejection above consults is exactly the globals plus --out and --strict. Read from
    # cli.json, which is what the CLI itself rejects against — so a destination flag
    # cannot reach the surface without failing here.
    spec = load_cli_spec()
    for name in ("export", "viewer build"):
        cmd = next((c for c in spec["commands"] if c["name"] == name), None)
        assert cmd is not None, f"{name} is a documented command"
        allowed = sorted(
            part.strip().split()[0]
            for option in [*spec["globalOptions"], *cmd["options"]]
            for part in option["flags"].split(",")
        )
        assert allowed == [
            "--help",
            "--json",
            "--out",
            "--root",
            "--strict",
            "--version",
            "-h",
            "-v",
        ], name
        # And the help bytes a person reads describe no network operation: this command
        # writes files from files. The whole banned class against the real bytes, not a
        # selected few of them.
        assert main(["--help", *name.split(" ")]) == 0
        help_text = capsys.readouterr().out
        # The flag surface itself is the cli.json assertion above, which holds whatever
        # the help layout does; help only has to document it.
        for option in cmd["options"]:
            assert f"   {option['flags']}" in help_text, f"{name} help documents {option['flags']}"
        assert "\nGlobal options: see leji --help.\n" in help_text, name
        for word in (
            "endpoint",
            "token",
            "upload",
            "api key",
            "s3://",
            "host",
            "url",
            "server",
            "network",
            "browser",
            "publish",
            "remote",
        ):
            assert word not in help_text.lower(), f'the {name} help text carries no "{word}"'


# --- strict scope and the byte-untouched target --------------------------------


def test_strict_is_scoped_to_the_lint_class_and_leaves_the_target_untouched(
    tmp_path: Path, capsys
) -> None:
    # A layer that reports a finding without failing generation: a viewer.homepage that
    # resolves to nothing is a warning, exported anyway.
    directory = _copy(FIXTURES / "valid-unified-leji-fresh", tmp_path / "layer")
    manifest_path = directory / "leji.json"
    declared = json.loads(manifest_path.read_text(encoding="utf-8"))
    declared["viewer"] = {"homepage": "no-such-page.md"}
    manifest_path.write_text(json.dumps(declared, indent=2) + "\n", encoding="utf-8")

    assert main(["export", "--root", str(directory), "--json"]) == 0
    plain = capsys.readouterr().out
    plain_doc = json.loads(plain)
    assert plain_doc["ok"] is True
    assert any(f["rule"] == "viewer-path-missing" for f in plain_doc["findings"]), (
        f"the layer reports a finding: {plain_doc['findings']}"
    )

    # `--strict` is scoped to the lint class, not to any finding: an ordinary viewer
    # warning stays a warning, and the export is still written.
    assert main(["export", "--root", str(directory), "--strict", "--json"]) == 0, (
        "an ordinary warning is not promoted by --strict"
    )
    assert capsys.readouterr().out == plain, "the same findings, and still written"
    # The class the gate does promote is the rendering lint's, so F4's findings fail a
    # strict run. What that promotion DOES is pinned behaviorally by the test below;
    # this only names the class the gate is scoped to.
    assert "render-unsupported" in STRICT_LINT_RULES, "the lint class is what --strict promotes"

    dist_dir = directory / ".leji" / "dist"
    before = _snapshot(dist_dir)
    assert before, "an export exists to be protected"

    # An error finding fails the run through the same pre-clean gate: overview.md,
    # seeded by the runs above, redirected into a private role. Generation reaches it
    # after the chrome is written, so this run proves both halves of the pipeline
    # promise at once — the internal chrome IS regenerated, the target is not touched.
    (directory / ".leji" / "mounts").mkdir(parents=True, exist_ok=True)
    (directory / ".leji" / "mounts" / "stolen.md").write_text("private\n", encoding="utf-8")
    overview = directory / "docs" / "overview.md"
    assert overview.exists(), "the seeded overview page is there to redirect"
    overview.unlink()
    overview.symlink_to(directory / ".leji" / "mounts" / "stolen.md")
    viewer_dir = directory / ".leji" / "viewer"
    shutil.rmtree(viewer_dir)

    assert main(["export", "--root", str(directory), "--json"]) == 1, (
        "an error finding fails the run"
    )
    failed_doc = json.loads(capsys.readouterr().out)
    assert failed_doc["ok"] is False
    assert any(f["severity"] == "error" for f in failed_doc["findings"]), (
        f"the run reports an error finding: {failed_doc['findings']}"
    )
    assert _snapshot(dist_dir) == before, "the existing export is byte-untouched"
    assert (viewer_dir / "index.html").exists(), "the internal chrome was regenerated regardless"
    assert (viewer_dir / "assets").exists(), "the internal chrome carries its assets"

    # The same holds under the other name, and for a target that does not exist yet.
    shutil.rmtree(dist_dir)
    assert main(["viewer", "build", "--root", str(directory), "--strict"]) == 1
    capsys.readouterr()
    assert not dist_dir.exists(), "nothing was written at all"


# --- the strict gate, driven by a real lint finding ----------------------------


def test_strict_gate_is_driven_by_a_real_lint_finding(tmp_path: Path, capsys) -> None:
    directory = _copy(FIXTURES / "valid-unified-leji-fresh", tmp_path / "layer")
    # A real unsupported construct in one of the layer's own documents: the rendering
    # lint reads the source the export carries, so the exit codes below are the gate's
    # answer to a finding the shipped pipeline produced and not to a planted one.
    doc_path = directory / "docs" / "domain" / "overview.md"
    with doc_path.open("a", encoding="utf-8") as fh:
        fh.write("\nA raw <span>element</span> in the prose.\n")

    # Default run: the lint finding is reported and the export is written anyway — the
    # layer's build never breaks on prose.
    assert main(["export", "--root", str(directory), "--json"]) == 0, (
        "an ordinary run exports despite the lint finding"
    )
    plain_doc = json.loads(capsys.readouterr().out)
    assert plain_doc["ok"] is True
    assert any(
        f["rule"] == "render-unsupported"
        and f["severity"] == "warning"
        and f["path"] == "docs/domain/overview.md"
        and f["line"] == 5
        and f["construct"] == "raw-html"
        for f in plain_doc["findings"]
    ), f"the lint finding reached the pipeline: {plain_doc['findings']}"
    dist_dir = directory / ".leji" / "dist"
    before = _snapshot(dist_dir)
    assert before, "an export exists to be protected"

    # Same layer, same finding, `--strict`: the run fails and the export it would have
    # replaced is left exactly as it was. The chrome is removed first, so the assertion
    # that it was regenerated can actually fail: after the default run above it exists
    # already, and a strict gate moved ahead of regeneration would pass unnoticed.
    viewer_dir = directory / ".leji" / "viewer"
    shutil.rmtree(viewer_dir)
    assert main(["export", "--root", str(directory), "--strict", "--json"]) == 1, (
        "the lint class fails a strict run"
    )
    strict_doc = json.loads(capsys.readouterr().out)
    assert strict_doc["ok"] is False
    assert any(f["rule"] == "render-unsupported" for f in strict_doc["findings"])
    assert _snapshot(dist_dir) == before, "the existing export is byte-untouched"
    # The internal chrome is regenerated regardless: the no-write promise is the
    # target's, per the pipeline order.
    assert (viewer_dir / "index.html").exists(), "the chrome was regenerated"
    assert (viewer_dir / "assets").exists(), "the internal chrome carries its assets"

    # One operation, two names: the gate answers the same under `viewer build`.
    assert main(["viewer", "build", "--root", str(directory), "--strict", "--json"]) == 1, (
        "the gate holds under the other name"
    )
    capsys.readouterr()
    assert _snapshot(dist_dir) == before, "and still byte-untouched"


# --- the export flavor's subpath proxy gate ------------------------------------


def test_export_flavor_carries_no_root_absolute_url(tmp_path: Path, capsys) -> None:
    directory = _copy(EXAMPLE, tmp_path / "layer")
    assert main(["export", "--root", str(directory), "--json"]) == 0
    capsys.readouterr()
    served = (directory / ".leji" / "viewer" / "index.html").read_text(encoding="utf-8")
    exported = (directory / ".leji" / "dist" / "index.html").read_text(encoding="utf-8")
    # One code path, two flavors: the servable area holds the app-root base, the export
    # holds the relative one. index.html is the only file that differs.
    assert '"basePath":"/content/"' in served
    assert 'href="/assets/leji-logo.svg"' in served
    assert '"basePath":"content/"' in exported
    assert '"basePath":"/content/"' not in exported
    # The machine-checkable proxy gate for subpath hosting: nothing in the exported
    # shell — attributes or config — addresses the server root.
    body = exported.split("-->", 1)[1]
    assert re.findall(r'(?:href|src)="/[^"]*"', body) == []
    assert re.findall(r'\\"/(?:content|assets)/[^\\"]*\\"', body) == []
    # The servable area never holds export-flavored bytes, and the two trees agree on
    # everything else the chrome ships.
    for rel in ("assets/viewer-boot.js", "assets/docsify.min.js"):
        exported_asset = (directory / ".leji" / "dist").joinpath(*rel.split("/")).read_bytes()
        served_asset = (directory / ".leji" / "viewer").joinpath(*rel.split("/")).read_bytes()
        assert exported_asset == served_asset, f"{rel} must be flavor-neutral"


# --- the exported overview carries the map; the lint reads the source ----------


def test_exported_overview_carries_the_rendered_map_and_the_lint_judges_the_source(
    tmp_path: Path, capsys
) -> None:
    directory = _copy(FIXTURES / "valid-unified-leji-fresh", tmp_path / "layer")
    # An author's page: prose around the markers, and inside them a stale hand-edit
    # carrying an out-of-subset construct. The construct's line number is what proves
    # which bytes the lint read, since the substitution below changes every line after
    # the markers.
    overview = directory / "docs" / "overview.md"
    source = (
        "# The layer\n\nIntro prose.\n\n<!-- leji:generated-map:start -->\n"
        "A raw <span>element</span> left inside the markers.\n"
        "<!-- leji:generated-map:end -->\n\nClosing prose.\n"
    )
    overview.write_text(source, encoding="utf-8")

    assert main(["export", "--root", str(directory), "--json"]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert any(
        f["rule"] == "render-unsupported" and f["path"] == "docs/overview.md" and f["line"] == 6
        for f in doc["findings"]
    ), f"the lint reported the construct at its line in the SOURCE: {doc['findings']}"

    # The source is the author's file: untouched by an export that renders from it.
    assert overview.read_text(encoding="utf-8") == source
    exported = (directory / ".leji" / "dist" / "content" / "overview.md").read_text(
        encoding="utf-8"
    )
    manifest = load_manifest(str(directory)).manifest
    entries = generate_viewer(str(directory), manifest).index_entries
    assert exported == render_overview(source, manifest, entries).text, (
        "the exported copy is the source with the marked span substituted"
    )
    assert ("```mermaid\n" + build_layer_map(manifest, entries) + "\n```") in exported
    assert "# The layer" in exported, "the prose around the markers rides along"
    assert "Closing prose." in exported, "including what follows them"
    assert "<span>" not in exported, "and the stale hand-edit between them is gone"


def test_exported_overview_without_markers_is_the_source_byte_for_byte(
    tmp_path: Path, capsys
) -> None:
    directory = _copy(FIXTURES / "valid-unified-leji-fresh", tmp_path / "layer")
    overview = directory / "docs" / "overview.md"
    source = "# Fully custom\n\nNo markers here at all.\n"
    overview.write_text(source, encoding="utf-8")
    assert main(["export", "--root", str(directory), "--json"]) == 0
    capsys.readouterr()
    assert overview.read_text(encoding="utf-8") == source, "the source is untouched"
    assert (directory / ".leji" / "dist" / "content" / "overview.md").read_text(
        encoding="utf-8"
    ) == source, "with nowhere to render the map, the exported copy is the source"


def test_exported_overview_decodes_invalid_utf8_like_the_reference(tmp_path: Path, capsys) -> None:
    # An authored page carrying invalid UTF-8 OUTSIDE the marker span. The exported copy
    # is rendered, so it is decoded first, and it must be decoded the way Node decodes.
    directory = _copy(FIXTURES / "valid-unified-leji-fresh", tmp_path / "layer")
    overview = directory / "docs" / "overview.md"
    source = (
        b"# T\xfftle\n\nIntro.\n\n<!-- leji:generated-map:start -->\nstale\n"
        b"<!-- leji:generated-map:end -->\n\nTa\xc0\x80il\n"
    )
    overview.write_bytes(source)
    assert main(["export", "--root", str(directory), "--json"]) == 0
    capsys.readouterr()
    assert overview.read_bytes() == source, "the source is untouched, invalid bytes included"
    exported = (directory / ".leji" / "dist" / "content" / "overview.md").read_bytes()
    manifest = load_manifest(str(directory)).manifest
    entries = generate_viewer(str(directory), manifest).index_entries
    want = render_overview(source.decode("utf-8", errors="replace"), manifest, entries)
    assert want.markers_found
    assert exported == want.text.encode("utf-8"), "the exported copy is the reference rendering"
    text = exported.decode("utf-8")
    assert "# T�tle" in text and "Ta��il" in text
    assert b"\xff" not in exported, "no raw invalid byte reaches the export of a rendered page"


def test_exported_markerless_overview_keeps_its_raw_bytes(tmp_path: Path, capsys) -> None:
    # The other half of the same rule: with no markers there is nothing to render, so the
    # export copies the snapshot it linted, invalid byte and all.
    directory = _copy(FIXTURES / "valid-unified-leji-fresh", tmp_path / "layer")
    overview = directory / "docs" / "overview.md"
    source = b"# Fully custom\n\nNo markers, and a raw \xff byte.\n"
    overview.write_bytes(source)
    assert main(["export", "--root", str(directory), "--json"]) == 0
    capsys.readouterr()
    assert (directory / ".leji" / "dist" / "content" / "overview.md").read_bytes() == source, (
        "a markerless page exports as its raw bytes"
    )
