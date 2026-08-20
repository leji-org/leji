"""leji: reference SDK for the Leji specification (https://leji.org).

Behaviorally identical to the `@leji-org/leji` npm package and the Go SDK; all three
implementations are tested against one shared fixture suite.
"""

from .badge import (
    DEFAULT_BADGE_OUT,
    OUT_RULE,
    BadgeResult,
    badge_label,
    badge_markdown,
    badge_run,
    render_badge,
)
from .changelog import CompactResult, compact_changelog, serialize_changelog
from .conformance import ConformanceResult, conformance_report, render_explain
from .dependency import dependency_add_failed, offer_dependency
from .ecosystem import (
    detect_ecosystem,
    render_ecosystem_block,
    render_ecosystem_line,
    runner_argv,
)
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
from .export_cmd import BuildResult, build_viewer
from .serve_cmd import open_browser, serve_viewer
from .viewer_cmd import (
    ViewerResult,
    build_sidebar,
    generate_viewer,
    resolve_viewer_port,
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
from .route import (
    LIVE_STATUSES,
    RouteInput,
    RouteResult,
    RoutedDecision,
    RoutedDocument,
    RoutedMount,
    route,
)
from .schemas import SDK_VERSION, SUPPORTED_LINES
from .status import DanglingEntry, StatusReport, status_report
from .validate import check_changelog_append_only, content_findings, validate_layer
from .writeplan import PlanEntry, PlannedWrite, build_write_plan, render_write_plan

__version__ = SDK_VERSION

__all__ = [
    "AdoptResult",
    "AgentResult",
    "BadgeResult",
    "BuildResult",
    "CompactResult",
    "ConformanceResult",
    "DEFAULT_BADGE_OUT",
    "DanglingEntry",
    "DetectResult",
    "DetectedHost",
    "StatusReport",
    "ViewerResult",
    "Finding",
    "FreshnessReport",
    "HOST_SPECS",
    "HostSpec",
    "InitResult",
    "LIVE_STATUSES",
    "Manifest",
    "OUT_RULE",
    "PlanEntry",
    "PlannedWrite",
    "RouteInput",
    "RouteResult",
    "RoutedDecision",
    "RoutedDocument",
    "RoutedMount",
    "SDK_VERSION",
    "SUPPORTED_LINES",
    "Severity",
    "StartOptions",
    "adapter_content",
    "add_agent",
    "adopt_layer",
    "badge_label",
    "badge_markdown",
    "badge_run",
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
    "dependency_add_failed",
    "detect_ecosystem",
    "detect_layer",
    "ensure_ci_workflow",
    "enter_layer",
    "entering_via_boot",
    "freshness_report",
    "generate_viewer",
    "handoff_offer",
    "render_badge",
    "offer_dependency",
    "render_detect",
    "render_ecosystem_block",
    "render_ecosystem_line",
    "runner_argv",
    "render_explain",
    "resolve_host_id",
    "route",
    "generate_index",
    "init_layer",
    "load_manifest",
    "open_browser",
    "render_write_plan",
    "resolve_viewer_port",
    "serialize_changelog",
    "serve_viewer",
    "sort_findings",
    "status_report",
    "summarize",
    "validate_layer",
    "write_index",
]
