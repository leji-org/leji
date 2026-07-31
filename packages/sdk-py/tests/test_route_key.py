"""Contract tests ported from the reference implementation.

The server matches routes against a forward-slashed prefix. Deriving the key
through a platform-dependent normalization answers differently per platform for a
request carrying backslashes, so the prefix test misses and the request falls
through to the chrome mount. Directory-entry order is likewise unspecified, so the
docs-root choice must be a function of the name set and not of its order.
"""

from leji.init_cmd import pick_docs_root
from leji.viewer_cmd import _url_path_to_rel


def test_url_path_to_rel_is_separator_agnostic() -> None:
    cases = {
        "/content/boot-profile.md": "content/boot-profile.md",
        "/content/agents/core.md": "content/agents/core.md",
        "/content/_sidebar.md": "content/_sidebar.md",
        "/": "",
        "/assets/app.js": "assets/app.js",
        "/content": "content",
        "/content/../../etc/passwd": "etc/passwd",
        "/content/..\\..\\etc\\passwd": "etc/passwd",
        "/content\\agents\\core.md": "content/agents/core.md",
        "": "",
        ".": "",
        "/content/": "content",
        "//content//core.md": "content/core.md",
        "../../x": "x",
    }
    for given, want in cases.items():
        assert _url_path_to_rel(given) == want, given
        assert "\\" not in _url_path_to_rel(given)


def test_pick_docs_root_is_order_independent() -> None:
    assert pick_docs_root(["Docs", "DOCS"]) == "DOCS/"
    assert pick_docs_root(["DOCS", "Docs"]) == "DOCS/"
    assert pick_docs_root(["Docs", "docs", "DOCS"]) == "docs/"
    assert pick_docs_root(["docs", "Docs"]) == "docs/"
    assert pick_docs_root(["documentation", "doc", "docs"]) == "docs/"
    assert pick_docs_root(["documentation", "DOC"]) == "DOC/"
    assert pick_docs_root([]) is None
    assert pick_docs_root(["src", "lib"]) is None
    # Unicode folding would match this onto "docs"; plain lowercasing must not.
    assert pick_docs_root(["docſ"]) is None
