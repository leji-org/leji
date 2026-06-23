"""leji: reference SDK for the Leji specification (https://leji.org).

Behaviorally identical to the `@leji-org/leji` npm package and the Go SDK; all three
implementations are tested against one shared fixture suite.
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
from .viewer_cmd import (
    BuildResult,
    ViewerResult,
    build_sidebar,
    build_viewer,
    generate_viewer,
    open_browser,
    resolve_viewer_port,
    serve_viewer,
)
from .findings import Finding, Severity, sort_findings, summarize
from .freshness import FreshnessReport, freshness_report
from .indexgen import check_index, generate_index, write_index
from .init_cmd import (
    AdoptResult,
    AgentResult,
    InitResult,
    StartOptions,
    add_agent,
    adopt_layer,
    ensure_ci_workflow,
    enter_layer,
    entering_via_boot,
    handoff_offer,
    init_layer,
)
from .manifest import Manifest, claimed_level, load_manifest
from .schemas import SDK_VERSION, SUPPORTED_LINES
from .validate import check_changelog_append_only, content_findings, validate_layer
from .writeplan import PlanEntry, PlannedWrite, build_write_plan, render_write_plan

__version__ = SDK_VERSION

__all__ = [
    "AdoptResult",
    "AgentResult",
    "BuildResult",
    "CompactResult",
    "ConformanceResult",
    "DetectResult",
    "DetectedHost",
    "ViewerResult",
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
    "StartOptions",
    "adapter_content",
    "add_agent",
    "adopt_layer",
    "build_sidebar",
    "build_viewer",
    "build_write_plan",
    "check_changelog_append_only",
    "check_index",
    "claimed_level",
    "compact_changelog",
    "conformance_report",
    "content_findings",
    "detect_hosts",
    "detect_layer",
    "ensure_ci_workflow",
    "enter_layer",
    "entering_via_boot",
    "freshness_report",
    "generate_viewer",
    "handoff_offer",
    "render_detect",
    "render_explain",
    "resolve_host_id",
    "generate_index",
    "init_layer",
    "load_manifest",
    "open_browser",
    "render_write_plan",
    "resolve_viewer_port",
    "serialize_changelog",
    "serve_viewer",
    "sort_findings",
    "summarize",
    "validate_layer",
    "write_index",
]
