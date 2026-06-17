"""YAML frontmatter extraction with YAML 1.2 core scalar semantics.

PyYAML implements YAML 1.1, which silently coerces unquoted dates to
``datetime.date`` and ``yes``/``no``/``on``/``off`` to booleans; the Node SDK's
``yaml`` package follows YAML 1.2, where none of that happens. The custom
loader strips those resolvers so both SDKs read identical frontmatter.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

import yaml


class _LejiLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        # Parity with the Node SDK's `yaml` package: duplicate mapping keys
        # are an error, not a silent last-wins.
        seen = set()
        for key_node, _value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in seen:
                raise yaml.constructor.ConstructorError(
                    None, None, f"duplicate key: {key!r}", key_node.start_mark
                )
            seen.add(key)
        return super().construct_mapping(node, deep=deep)


_LejiLoader.yaml_implicit_resolvers = {
    key: [
        (tag, regexp)
        for tag, regexp in resolvers
        if tag not in ("tag:yaml.org,2002:timestamp", "tag:yaml.org,2002:bool")
    ]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
# YAML 1.2 core booleans only: true/false (any common casing), never yes/no/on/off.
_LejiLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
    list("tTfF"),
)


@dataclass
class Frontmatter:
    data: Optional[dict[str, Any]]
    body: str
    error: Optional[str] = None


_FENCE = re.compile(r"\r?\n---[ \t]*\r?\n")


def parse_frontmatter(text: str) -> Frontmatter:
    if not (text.startswith("---\n") or text.startswith("---\r\n")):
        return Frontmatter(data=None, body=text)
    fence = _FENCE.search(text[3:])
    if not fence:
        return Frontmatter(data=None, body=text, error="unterminated frontmatter block")
    raw = text[3 : 3 + fence.start() + 1]
    body = text[3 + fence.end() :]
    try:
        data = yaml.load(raw, Loader=_LejiLoader)
    except yaml.YAMLError as e:
        first_line = str(e).split("\n")[0]
        return Frontmatter(data=None, body=body, error=f"invalid YAML: {first_line}")
    if data is None or not isinstance(data, dict):
        return Frontmatter(data=None, body=body, error="frontmatter is not a YAML mapping")
    return Frontmatter(data=data, body=body)
