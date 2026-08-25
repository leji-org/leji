"""``leji mounts update-pin``: move ONE declared mount's pin forward to a commit the
resolver has already witnessed, showing the comparison before anything is rewritten.

Mirrors packages/sdk/src/commands/mounts-update-pin.ts byte-for-byte in behavior and
output.

Offline by default: the target is the last successfully observed witness, never a
claim of freshness. ``--fetch`` observes the declared source — and nothing else — in
three acts: retain the current pin, refresh the witness once, and (after the gate
passes) retain the target. Any of them failing REFUSES the move; a pin move is not
best-effort, which is ``hydrate``'s model rather than this one. The reason names the
act.

The manifest is rewritten by replacing the addressed pin's own byte span
(:func:`~leji.manifest.replace_mount_pin_in_manifest_text`), never by reserializing,
so the three SDKs produce byte-identical output over any accepted layout.
"""

from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .findings import Finding
from .fsx import guard_root, verified_target_read, write_file_atomic_guarded
from .leji_ignore import LejiIgnoreContext
from .manifest import (
    MANIFEST_FILENAME,
    Manifest,
    replace_mount_pin_in_manifest_text,
)
from .mounts import (
    MountDecl,
    compare_pins,
    normalize_source,
    refresh_witness,
    resolve_default_ref,
    retain_pin_in_store,
    run_git,
    select_comparison,
    valid_tracking_ref,
)

# Prose for this command's stable reason codes: ``--json`` emits the code, a person
# reads the sentence. The codes above ``mount-unknown`` are shared with
# ``mounts status``, whose prose lives beside the status reasons.
MOUNT_UPDATE_PIN_REASONS: dict[str, str] = {
    "mount-unknown": "no mount with this name is declared",
    "mount-source-unnormalizable": "source is not a normalizable locator",
    "mount-no-tracking-ref": (
        "no trackingRef declared; the source's advertised default branch needs --fetch"
    ),
    "mount-tracking-ref-invalid": "trackingRef is not a fully qualified branch or tag",
    "mount-default-ref-unavailable": (
        "the source advertises no default branch this run could resolve"
    ),
    "mount-pin-unavailable": (
        "no reachable object store holds the pin (declare a hint, or pass --fetch)"
    ),
    "mount-witness-unavailable": (
        "no object store holding the pin resolves the witness ref; "
        "run `leji mounts hydrate --fetch`"
    ),
    "mount-source-ambiguous": (
        "more than one submodule matches the source; "
        "declare an explicit hint in .leji/mounts.local.json"
    ),
    "mount-ancestry-incomplete": (
        "incomplete ancestry; the comparison repository cannot answer the range"
    ),
    "mount-store-fetch-failed": (
        "the requested fetch could not retain the commit in the managed store"
    ),
    # The current-pin act is the one an operator can route past: an upstream that
    # rewrote its history no longer serves the commit this manifest pins, and the
    # move is still available against a repository that does hold both operands.
    "mount-store-fetch-failed: current pin": (
        "the requested fetch could not retain the commit in the managed store; "
        "if a local hint holds the current pin and the target with complete ancestry, "
        "run without `--fetch`; to move past a rewritten upstream, pass "
        "`--to <oid> --allow-non-fast-forward` against such a hint"
    ),
    "mount-witness-refresh-failed": (
        "the requested fetch could not refresh the managed witness ref"
    ),
    "mount-target-unavailable": (
        "the requested target commit is not held by the comparison repository"
    ),
    "mount-pin-not-fast-forward": (
        "the target is not a descendant of the current pin "
        "(pass --to <oid> --allow-non-fast-forward to move anyway)"
    ),
    "mount-declaration-changed": "leji.json changed while the comparison ran; nothing was written",
    "mount-pin-non-fast-forward-override": (
        "the pin was moved to a commit that is not a descendant of it"
    ),
}


def _update_pin_reason_prose(reason: str, detail: str | None = None) -> str:
    """The sentence a refusal shows. A code whose acts have different routes forward
    carries one entry per act, keyed ``<code>: <act>`` exactly as the finding's
    ``detail`` spells it, so the table stays the single source of every string this
    command prints; every other code answers for all of its acts at once."""
    if detail is not None:
        act = detail[: max(detail.find(": "), 0)]
        qualified = MOUNT_UPDATE_PIN_REASONS.get(f"{reason}: {act}")
        if qualified is not None:
            return qualified
    return MOUNT_UPDATE_PIN_REASONS.get(reason, reason)


@dataclass
class UpdatePinResult:
    """What the run did. ``refused`` is a stated outcome, never a crash."""

    #: ``{name, sourceIdentity, trackingRef, from, to}`` in the order --json emits.
    mount: dict[str, object]
    pin_report: Optional[dict[str, object]]
    #: 'updated' | 'unchanged' | 'dry-run' | 'refused'
    action: str
    override: bool
    findings: list[Finding] = field(default_factory=list)
    #: Stable code, present only when the run refused.
    reason: Optional[str] = None
    #: An internal refusal with no document to report: the manifest parsed and
    #: validated, but the pin's own span could not be located or did not hold what
    #: the comparison was computed against. Exit 2.
    write_error: Optional[str] = None


def short_oid(oid: str) -> str:
    """A pin at the length every human-facing line uses."""
    return oid[:12]


@dataclass(frozen=True)
class _Declaration:
    """The manifest's OWN values for the addressed mount, snapshotted at load for the
    freshness check the rewrite makes against the verified bytes.

    ``tracking_ref_present`` is carried BESIDE the value because absent and ``null``
    are two different declarations that a bare lookup collapses into the same
    ``None``: without it, a mount whose ``trackingRef`` appeared as ``null`` while the
    comparison ran would read as unchanged, and the pin would be spliced into a
    declaration the schema no longer accepts. Node distinguishes the two for free
    (``undefined`` vs ``null``); here it is explicit."""

    name: str
    source: str
    pin: str
    tracking_ref_present: bool
    tracking_ref: object


def _declared_entry(manifest: Manifest, name: str) -> dict | None:
    """The addressed mount's raw declaration, so its caller can read both the values
    and which keys the manifest actually spelled."""
    for m in (manifest.get("federation") or {}).get("mounts") or []:
        if m.get("name") == name:
            return m
    return None


def _now_iso(now: dt.datetime | None) -> str:
    moment = dt.datetime.now(dt.timezone.utc) if now is None else now.astimezone(dt.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def update_pin_run(  # noqa: C901
    root: str,
    manifest: Manifest,
    name: str,
    to: str | None = None,
    allow_non_fast_forward: bool = False,
    fetch: bool = False,
    dry_run: bool = False,
    now: dt.datetime | None = None,
    ignore_context: LejiIgnoreContext | None = None,
) -> UpdatePinResult:
    """Move one mount's pin. Every refusal is a stated ``reason`` code plus an error
    finding, so the exit status, the human line and the JSON document always agree.

    ``ignore_context`` is the invocation's notice state for the self-managed
    ``.leji/.gitignore``. One ``--fetch`` run retains TWICE (the current pin, then the
    target), and both establish the managed store, so the context is threaded rather
    than left to each call: one invocation notices at most once."""
    # One observation time for the whole run, as ``status`` takes one for its whole
    # execution.
    observed_at = _now_iso(now)
    entry = _declared_entry(manifest, name)
    mount = (
        None
        if entry is None
        else MountDecl(
            name=entry["name"],
            source=entry["source"],
            pin=entry["pin"],
            tracking_ref=entry.get("trackingRef"),
        )
    )

    def refuse(
        reason: str,
        partial: dict[str, object] | None = None,
        pin_report: dict[str, object] | None = None,
        detail: str | None = None,
    ) -> UpdatePinResult:
        block: dict[str, object] = {
            "name": name,
            "sourceIdentity": normalize_source(mount.source) if mount else None,
            "trackingRef": mount.tracking_ref if mount else None,
            "from": mount.pin if mount else None,
            "to": None,
        }
        block.update(partial or {})
        return UpdatePinResult(
            mount=block,
            pin_report=pin_report,
            action="refused",
            override=False,
            reason=reason,
            findings=[
                Finding(
                    reason,
                    "error",
                    _update_pin_reason_prose(reason, detail),
                    name,
                    detail=detail,
                )
            ],
        )

    if mount is None or entry is None:
        return refuse("mount-unknown")

    # (a) The declaration snapshot: the manifest's OWN values, kept for the
    # freshness check the rewrite makes against the verified bytes. ``trackingRef``
    # is snapshotted as declared, presence included — absent must stay absent —
    # while the ref the comparison actually uses is tracked separately.
    declaration = _Declaration(
        name=mount.name,
        source=mount.source,
        pin=mount.pin,
        tracking_ref_present="trackingRef" in entry,
        tracking_ref=entry.get("trackingRef"),
    )
    identity = normalize_source(mount.source)

    def degraded(reason: str, compared_ref: str | None) -> dict[str, object]:
        return {
            "state": "unknown",
            "comparedRef": compared_ref,
            "comparisonRepository": None,
            "witnessProvenance": None,
            "ancestryComplete": False,
            "reason": reason,
            "observedAt": observed_at,
        }

    if identity is None:
        return refuse(
            "mount-source-unnormalizable",
            None,
            degraded("mount-source-unnormalizable", mount.tracking_ref),
        )

    if mount.tracking_ref is not None:
        if not valid_tracking_ref(mount.tracking_ref):
            return refuse(
                "mount-tracking-ref-invalid",
                None,
                degraded("mount-tracking-ref-invalid", mount.tracking_ref),
            )
        effective_ref = mount.tracking_ref
    elif not fetch:
        # Offline, the schema's "absent means the source's default branch" cannot be
        # honoured: resolving it needs the network this run was not given.
        return refuse("mount-no-tracking-ref", None, degraded("mount-no-tracking-ref", None))
    else:
        resolved = resolve_default_ref(mount.source)
        if resolved.ref is None or not valid_tracking_ref(resolved.ref):
            return refuse(
                "mount-default-ref-unavailable",
                None,
                degraded("mount-default-ref-unavailable", None),
            )
        effective_ref = resolved.ref

    # (b i, ii) ``--fetch``, declared source only, in order: retain the CURRENT pin so
    # the managed store holds both operands, then refresh the witness exactly once.
    # A failure here refuses the move — best-effort belongs to ``hydrate``.
    if fetch:
        retained = retain_pin_in_store(root, mount, identity, mount.pin, ignore_context)
        if retained.repo is None:
            return refuse(
                "mount-store-fetch-failed",
                None,
                degraded("mount-store-fetch-failed", effective_ref),
                f"current pin: {retained.error}",
            )
        witness_mount = MountDecl(
            name=mount.name, source=mount.source, pin=mount.pin, tracking_ref=effective_ref
        )
        refreshed = refresh_witness(retained.repo, witness_mount, identity)
        if not refreshed.ok:
            return refuse(
                "mount-witness-refresh-failed",
                None,
                degraded("mount-witness-refresh-failed", effective_ref),
                f"witness: {refreshed.error}",
            )

    # (c) The comparison repository and the ONE witness snapshot this run uses for
    # the default target, the report, and the gate alike.
    selection = select_comparison(root, mount, effective_ref)
    if selection.reason is not None:
        return refuse(selection.reason, None, degraded(selection.reason, effective_ref))
    repo = str(selection.repo)
    tip_oid = str(selection.tip_oid)

    # (d) The target: an explicit ``--to`` must be held by the repository the
    # comparison ran in; otherwise the witness tip itself.
    target = tip_oid if to is None else to
    if to is not None and not run_git(["-C", repo, "cat-file", "-e", f"{to}^{{commit}}"]).ok:
        report = degraded("mount-target-unavailable", effective_ref)
        report["comparisonRepository"] = selection.comparison_repository
        report["witnessProvenance"] = selection.witness_provenance
        return refuse("mount-target-unavailable", {"to": to}, report)

    # (e) The report, computed from the same snapshot ``status`` would report from.
    comparison = compare_pins(repo, mount.pin, tip_oid)
    mount_block: dict[str, object] = {
        "name": mount.name,
        "sourceIdentity": identity,
        "trackingRef": mount.tracking_ref,
        "from": mount.pin,
        "to": target,
    }
    if comparison.reason is not None:
        report = degraded(comparison.reason, effective_ref)
        report["comparisonRepository"] = selection.comparison_repository
        report["witnessProvenance"] = selection.witness_provenance
        return refuse(comparison.reason, {"to": target}, report)
    pin_report: dict[str, object] = {
        "state": comparison.state,
        "behind": comparison.behind,
        "ahead": comparison.ahead,
        "comparedRef": effective_ref,
        "comparisonRepository": selection.comparison_repository,
        "witnessProvenance": selection.witness_provenance,
        "ancestryComplete": comparison.ancestry_complete,
        "observedAt": observed_at,
    }

    def settled(action: str, override: bool, findings: list[Finding]) -> UpdatePinResult:
        return UpdatePinResult(
            mount=mount_block,
            pin_report=pin_report,
            action=action,
            override=override,
            findings=findings,
        )

    # A refusal after the comparison settled reports the comparison it refused on,
    # and carries whatever the run had already decided: an override exercised at the
    # gate is still reported by a run that then refused for another reason.
    def refuse_settled(
        reason: str,
        override: bool = False,
        warnings: list[Finding] | None = None,
        detail: str | None = None,
    ) -> UpdatePinResult:
        result = settled(
            "refused",
            override,
            [
                Finding(
                    reason,
                    "error",
                    _update_pin_reason_prose(reason, detail),
                    mount.name,
                    detail=detail,
                ),
                *(warnings or []),
            ],
        )
        result.reason = reason
        return result

    # (f) The gate. Nothing to move is its own success, checked before ancestry:
    # asking whether a commit is an ancestor of itself is not the question.
    if target == mount.pin:
        return settled("unchanged", False, [])
    override = False
    ancestor = run_git(["-C", repo, "merge-base", "--is-ancestor", mount.pin, target])
    if not ancestor.ok:
        # Exit 1 is the answer "no"; anything else is the repository unable to answer.
        # A "no" from truncated history is not an answer either, so an incomplete
        # repository never yields the not-fast-forward refusal — nor does the
        # override bypass it.
        if ancestor.code != 1 or not comparison.ancestry_complete:
            return refuse_settled("mount-ancestry-incomplete")
        if to is None or not allow_non_fast_forward:
            return refuse_settled("mount-pin-not-fast-forward")
        override = True
    warnings = (
        [
            Finding(
                "mount-pin-non-fast-forward-override",
                "warning",
                MOUNT_UPDATE_PIN_REASONS["mount-pin-non-fast-forward-override"],
                mount.name,
            )
        ]
        if override
        else []
    )

    # (b iii) The target is retained only once the gate has passed, so a refused run
    # never establishes a pin ref for a commit it declined to move to.
    if fetch:
        retained_target = retain_pin_in_store(root, mount, identity, target, ignore_context)
        if retained_target.repo is None:
            return refuse_settled(
                "mount-store-fetch-failed",
                override,
                warnings,
                f"target: {retained_target.error}",
            )

    # (g) ``--dry-run`` stops here. The store and network acts ``--fetch`` was asked
    # for have already happened; only the manifest rewrite is suppressed.
    if dry_run:
        return settled("dry-run", override, warnings)

    # (h) The rewrite, through the verified read the trust boundary requires.
    root_real = guard_root(root)
    manifest_abs = str(Path(root) / MANIFEST_FILENAME)
    read = verified_target_read(root_real, manifest_abs, None)
    if read.status != "regular":
        result = settled("refused", override, warnings)
        result.write_error = (
            f'refusing to write through a symlink that escapes the target: "{MANIFEST_FILENAME}"'
        )
        return result
    original = read.text()
    # The bytes that were verified decide whether the declaration this comparison
    # was computed against is still the declaration on disk. Containment says WHICH
    # file was read; only this says it still says the same thing.
    if not _declaration_unchanged(original, declaration):
        return refuse_settled("mount-declaration-changed", override, warnings)
    try:
        rewritten, changed = replace_mount_pin_in_manifest_text(
            original, mount.name, mount.pin, target
        )
    except RuntimeError as e:
        result = settled("refused", override, warnings)
        result.write_error = str(e)
        return result
    if changed:
        verdict = write_file_atomic_guarded(root_real, manifest_abs, None, rewritten)
        if not verdict.ok:
            result = settled("refused", override, warnings)
            result.write_error = f'refusing to write outside the repository: "{MANIFEST_FILENAME}"'
            return result
    return settled("updated", override, warnings)


def _declaration_unchanged(text: str, declaration: _Declaration) -> bool:
    """Does the verified manifest text still declare the mount this run compared?
    Only the four fields that decided the selected repository, the target and the
    splice are compared; ownership and routing metadata decide none of them.

    ``trackingRef`` is compared on PRESENCE as well as value: present-and-equal, or
    absent-and-still-absent, and nothing in between. A mount that gained a
    ``trackingRef`` of ``null`` (or any other spelling) since the comparison is a
    changed declaration, not an unchanged one."""
    # These are the only manifest bytes this command reads without the schema having
    # cleared them first — the file may have been replaced with anything since the
    # comparison — so every shape but the one being looked for is simply "changed".
    try:
        parsed = json.loads(text)
    except ValueError:
        return False
    federation = parsed.get("federation") if isinstance(parsed, dict) else None
    mounts = federation.get("mounts") if isinstance(federation, dict) else None
    if not isinstance(mounts, list):
        return False
    current = next(
        (m for m in mounts if isinstance(m, dict) and m.get("name") == declaration.name), None
    )
    if current is None:
        return False
    return (
        current.get("source") == declaration.source
        and current.get("pin") == declaration.pin
        # Absent must stay absent: under ``--fetch`` the ref actually used may be the
        # source's advertised default, which the manifest never spelled.
        and ("trackingRef" in current) == declaration.tracking_ref_present
        and current.get("trackingRef") == declaration.tracking_ref
    )
