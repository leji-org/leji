"""Shared-fixture conformance: the Python SDK must report exactly what the
fixture contract (and therefore the Node SDK) expects."""

import json
from pathlib import Path

import pytest

from leji import check_index, conformance_report, load_manifest, validate_layer

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"

FIXTURE_NAMES = sorted(p.name for p in FIXTURES.iterdir() if (p / "expected.json").is_file())


def _expected(name: str) -> dict:
    return json.loads((FIXTURES / name / "expected.json").read_text())


def _triple(finding) -> str:
    if isinstance(finding, dict):
        return f"{finding.get('path', '')}|{finding['rule']}|{finding['severity']}"
    return f"{finding.path or ''}|{finding.rule}|{finding.severity}"


@pytest.mark.parametrize("name", FIXTURE_NAMES)
def test_fixture_validate(name: str) -> None:
    expected = _expected(name)["validate"]
    result = validate_layer(str(FIXTURES / name))
    got = sorted(_triple(f) for f in result.findings)
    want = sorted(_triple(f) for f in expected["findings"])
    assert got == want, f"findings mismatch for {name}"
    exit_code = 1 if any(f.severity == "error" for f in result.findings) else 0
    assert exit_code == expected["exit"], f"exit code mismatch for {name}"
    # When an expected finding pins a `message`, the actual finding sharing its
    # (path, rule, severity) triple must carry exactly that message.
    actual_by_triple = {_triple(f): f.message for f in result.findings}
    for ef in expected["findings"]:
        if isinstance(ef, dict) and "message" in ef:
            triple = _triple(ef)
            assert actual_by_triple.get(triple) == ef["message"], (
                f"message mismatch for {name} ({triple})"
            )


@pytest.mark.parametrize("name", [n for n in FIXTURE_NAMES if "conformance" in _expected(n)])
def test_fixture_conformance(name: str) -> None:
    expected = _expected(name)["conformance"]
    result = conformance_report(str(FIXTURES / name))
    assert (result.claimed_level or "none") == expected["claimedLevel"]
    assert (result.verified_level or "none") == expected["verifiedLevel"]
    exit_code = 1 if any(f.severity == "error" for f in result.findings) else 0
    assert exit_code == expected["exit"]


@pytest.mark.parametrize("name", [n for n in FIXTURE_NAMES if "indexCheck" in _expected(n)])
def test_fixture_index_check(name: str) -> None:
    expected = _expected(name)["indexCheck"]
    manifest = load_manifest(str(FIXTURES / name)).manifest
    assert manifest is not None, "manifest must load for indexCheck fixtures"
    result = check_index(str(FIXTURES / name), manifest)
    assert (result.stale if result.stale is not None else True) == expected["stale"]
    exit_code = 1 if any(f.severity == "error" for f in result.findings) else 0
    assert exit_code == expected["exit"]
