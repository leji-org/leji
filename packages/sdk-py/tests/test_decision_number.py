"""The decision-number rule's cross-SDK edge cases.

The shared fixture cannot carry these: a file name holding a control character is not
portably committable, so the rule's helpers are exercised directly.
"""

from leji.findings import Finding
from leji.layer import ScannedProfile
from leji.validate import _check_decision_numbers, _decision_number_key


def _record(rel_path: str) -> ScannedProfile:
    """A decision record reduced to what the number rule reads."""
    return ScannedProfile(rel_path=rel_path, frontmatter=None, body="", findings=[])


def test_decision_number_key_carriage_return_and_newline() -> None:
    # A file name may legally carry a CR, and the three SDKs must agree on whether it
    # carries a decision number: ECMAScript's `.` rejects CR (and U+2028/U+2029) where
    # Python's and Go's accept it, so the pattern spells the class out instead.
    assert _decision_number_key("docs/decisions/2-a\rb.md") == "2"
    assert _decision_number_key("docs/decisions/2-a\nb.md") is None


def test_check_decision_numbers_names_the_byte_order_first_record() -> None:
    # U+E000 sorts before U+10000 by bytes and after it by UTF-16 code units. Byte order
    # is the contract: this SDK's own string order is by code point, which equals it, and
    # the Node SDK sorts its scan bytewise to reach the same sequence. All three name the
    # U+10000 record as the later one.
    pua = "docs/decisions/2-\ue000.md"
    astral = "docs/decisions/2-\U00010000.md"
    assert sorted([pua, astral]) == [pua, astral]

    findings: list[Finding] = []
    _check_decision_numbers([_record(p) for p in sorted([pua, astral])], findings)

    assert len(findings) == 1
    assert findings[0].rule == "decision-number-duplicate"
    assert findings[0].severity == "error"
    assert findings[0].path == astral
    assert findings[0].message == f'decision number "2" already used by {pua}'
