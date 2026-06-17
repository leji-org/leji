"""leji: reference SDK for the Leji specification (https://leji.org).

Behaviorally identical to the `leji` npm package; both implementations are
tested against one shared fixture suite.
"""

from .conformance import ConformanceResult, conformance_report
from .docs_cmd import DocsResult, build_sidebar, generate_docs, resolve_docs_port, serve_docs
from .findings import Finding, Severity, sort_findings, summarize
from .freshness import FreshnessReport, freshness_report
from .indexgen import check_index, generate_index, write_index
from .init_cmd import InitResult, init_layer
from .manifest import Manifest, claimed_level, load_manifest
from .schemas import SDK_VERSION, SUPPORTED_LINES
from .validate import check_changelog_append_only, validate_layer

__version__ = SDK_VERSION

__all__ = [
    "ConformanceResult",
    "DocsResult",
    "Finding",
    "FreshnessReport",
    "InitResult",
    "Manifest",
    "SDK_VERSION",
    "SUPPORTED_LINES",
    "Severity",
    "build_sidebar",
    "check_changelog_append_only",
    "check_index",
    "claimed_level",
    "conformance_report",
    "freshness_report",
    "generate_docs",
    "generate_index",
    "init_layer",
    "load_manifest",
    "resolve_docs_port",
    "serve_docs",
    "sort_findings",
    "summarize",
    "validate_layer",
    "write_index",
]
