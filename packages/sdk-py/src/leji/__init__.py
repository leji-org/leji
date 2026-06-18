"""leji: reference SDK for the Leji specification (https://leji.org).

Behaviorally identical to the `leji` npm package; both implementations are
tested against one shared fixture suite.
"""

from .changelog import CompactResult, compact_changelog, serialize_changelog
from .conformance import ConformanceResult, conformance_report, render_explain
from .detect import (
    HOST_SPECS,
    DetectedHost,
    DetectResult,
    HostSpec,
    adapter_content,
    detect_hosts,
    detect_layer,
    render_detect,
    resolve_host_id,
)
from .docs_cmd import DocsResult, build_sidebar, generate_docs, resolve_docs_port, serve_docs
from .findings import Finding, Severity, sort_findings, summarize
from .freshness import FreshnessReport, freshness_report
from .indexgen import check_index, generate_index, write_index
from .init_cmd import AdoptResult, InitResult, adopt_layer, init_layer
from .manifest import Manifest, claimed_level, load_manifest
from .schemas import SDK_VERSION, SUPPORTED_LINES
from .validate import check_changelog_append_only, content_findings, validate_layer
from .writeplan import PlanEntry, PlannedWrite, build_write_plan, render_write_plan

__version__ = SDK_VERSION

__all__ = [
    "AdoptResult",
    "CompactResult",
    "ConformanceResult",
    "DetectResult",
    "DetectedHost",
    "DocsResult",
    "Finding",
    "FreshnessReport",
    "HOST_SPECS",
    "HostSpec",
    "InitResult",
    "Manifest",
    "PlanEntry",
    "PlannedWrite",
    "SDK_VERSION",
    "SUPPORTED_LINES",
    "Severity",
    "adapter_content",
    "adopt_layer",
    "build_sidebar",
    "build_write_plan",
    "check_changelog_append_only",
    "check_index",
    "claimed_level",
    "compact_changelog",
    "conformance_report",
    "content_findings",
    "detect_hosts",
    "detect_layer",
    "freshness_report",
    "generate_docs",
    "render_detect",
    "render_explain",
    "resolve_host_id",
    "generate_index",
    "init_layer",
    "load_manifest",
    "render_write_plan",
    "resolve_docs_port",
    "serialize_changelog",
    "serve_docs",
    "sort_findings",
    "summarize",
    "validate_layer",
    "write_index",
]
