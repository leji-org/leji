// Package updatepin implements `leji mounts update-pin`: move ONE declared mount's
// pin forward to a commit the resolver has already witnessed, showing the
// comparison before anything is rewritten. Mirrors commands/mounts-update-pin.ts.
//
// Offline by default: the target is the last successfully observed witness, never a
// claim of freshness. `--fetch` observes the declared source — and nothing else —
// in three acts: retain the current pin, refresh the witness once, and (after the
// gate passes) retain the target. Any of them failing REFUSES the move; a pin move
// is not best-effort, which is `hydrate`'s model rather than this one. The reason
// names the act.
//
// The manifest is rewritten by replacing the addressed pin's own byte span
// (manifest.ReplaceMountPinInManifestText), never by reserializing, so the three
// SDKs produce byte-identical output over any accepted layout.
package updatepin

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/lejiignore"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
)

// Actions: what the run did. "refused" is a stated outcome, never a crash.
const (
	ActionUpdated   = "updated"
	ActionUnchanged = "unchanged"
	ActionDryRun    = "dry-run"
	ActionRefused   = "refused"
)

// MountBlock is the `mount` object of the emitted document; nil pointers are JSON
// null.
type MountBlock struct {
	Name           string
	SourceIdentity *string
	// TrackingRef is the DECLARED tracking ref, never the default resolved under
	// `--fetch` — that one is reported as PinReport.ComparedRef.
	TrackingRef *string
	From        *string
	To          *string
}

// Result is one `mounts update-pin` run.
type Result struct {
	Mount     MountBlock
	PinReport *mounts.PinReport
	Action    string
	Override  bool
	// Reason is a stable code, present only when the run refused.
	Reason   string
	Findings []findings.Finding
	// WriteError is an internal refusal with no document to report: the manifest
	// parsed and validated, but the pin's own span could not be located or did not
	// hold what the comparison was computed against. Exit 2.
	WriteError string
}

// Options mirror updatePinRun's opts. HasTo distinguishes an absent `--to` from an
// empty one, as the TS `undefined` does.
type Options struct {
	Name                string
	To                  string
	HasTo               bool
	AllowNonFastForward bool
	Fetch               bool
	DryRun              bool
	// Now is the injectable observation clock, so tests and fixtures are stable;
	// zero means the wall clock, read once per run.
	Now time.Time
	// IgnoreContext is the invocation's notice state for the self-managed
	// `.leji/.gitignore`. One `--fetch` run retains TWICE (the current pin, then the
	// target), and both establish the managed store, so the context is threaded
	// rather than left to each call: one invocation notices at most once.
	IgnoreContext *lejiignore.Context
}

// ShortOid is a pin at the length every human-facing line uses.
func ShortOid(oid string) string {
	if len(oid) <= 12 {
		return oid
	}
	return oid[:12]
}

func strPtr(s string) *string { return &s }

// declaredMount finds the addressed mount's declaration, or ok false.
func declaredMount(m *manifest.Manifest, name string) (mounts.MountDecl, bool) {
	if m.Federation == nil {
		return mounts.MountDecl{}, false
	}
	for _, mt := range m.Federation.Mounts {
		if mt.Name == name {
			return mounts.MountDecl{Name: mt.Name, Source: mt.Source, Pin: mt.Pin, TrackingRef: mt.TrackingRef}, true
		}
	}
	return mounts.MountDecl{}, false
}

// Run moves one mount's pin. Every refusal is a stated Reason code plus an error
// finding, so the exit status, the human line and the JSON document always agree.
// The error return carries filesystem failures (TS exceptions).
func Run(root string, m *manifest.Manifest, opts Options) (Result, error) {
	// One observation time for the whole run, as `status` takes one for its whole
	// execution.
	observedAt := mounts.NowISO()
	if !opts.Now.IsZero() {
		observedAt = opts.Now.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	mount, declared := declaredMount(m, opts.Name)

	// `detail` is an optional trailing argument, as the TS reference's is: the act
	// this refusal failed at, when the rule names more than one.
	refuse := func(reason string, to *string, pinReport *mounts.PinReport, detail ...string) Result {
		act := optional(detail)
		block := MountBlock{Name: opts.Name, To: to}
		if declared {
			if identity, ok := mounts.NormalizeSource(mount.Source); ok {
				block.SourceIdentity = strPtr(identity)
			}
			if mount.TrackingRef != "" {
				block.TrackingRef = strPtr(mount.TrackingRef)
			}
			block.From = strPtr(mount.Pin)
		}
		return Result{
			Mount:     block,
			PinReport: pinReport,
			Action:    ActionRefused,
			Reason:    reason,
			Findings: []findings.Finding{
				findings.NewWithDetail(reason, findings.Error, reasonProse(reason, act), opts.Name, act),
			},
		}
	}

	if !declared {
		return refuse("mount-unknown", nil, nil), nil
	}

	// (a) The declaration snapshot: the manifest's OWN values, kept for the
	// freshness check the rewrite makes against the verified bytes. TrackingRef is
	// snapshotted as declared — absent must stay absent — while the ref the
	// comparison actually uses is tracked separately. Presence is carried beside the
	// value because a Go string cannot hold it: the schema's ref pattern rejects an
	// empty string, so a loaded declaration whose TrackingRef is "" is one the
	// manifest did not spell.
	declaration := declarationSnapshot{
		name:               mount.Name,
		source:             mount.Source,
		pin:                mount.Pin,
		trackingRef:        mount.TrackingRef,
		trackingRefPresent: mount.TrackingRef != "",
	}
	identity, idOK := mounts.NormalizeSource(mount.Source)
	degraded := func(reason, comparedRef string) *mounts.PinReport {
		rep := &mounts.PinReport{
			State:            "unknown",
			AncestryComplete: false,
			Reason:           reason,
			ObservedAt:       observedAt,
		}
		if comparedRef != "" {
			rep.ComparedRef = strPtr(comparedRef)
		}
		return rep
	}
	if !idOK {
		return refuse("mount-source-unnormalizable", nil,
			degraded("mount-source-unnormalizable", mount.TrackingRef)), nil
	}

	var effectiveRef string
	switch {
	case mount.TrackingRef != "":
		if !mounts.ValidTrackingRef(mount.TrackingRef) {
			return refuse("mount-tracking-ref-invalid", nil,
				degraded("mount-tracking-ref-invalid", mount.TrackingRef)), nil
		}
		effectiveRef = mount.TrackingRef
	case !opts.Fetch:
		// Offline, the schema's "absent means the source's default branch" cannot be
		// honoured: resolving it needs the network this run was not given.
		return refuse("mount-no-tracking-ref", nil, degraded("mount-no-tracking-ref", "")), nil
	default:
		resolved, errKind := mounts.ResolveDefaultRef(mount.Source)
		if errKind != "" || !mounts.ValidTrackingRef(resolved) {
			return refuse("mount-default-ref-unavailable", nil,
				degraded("mount-default-ref-unavailable", "")), nil
		}
		effectiveRef = resolved
	}

	// (b i, ii) `--fetch`, declared source only, in order: retain the CURRENT pin so
	// the managed store holds both operands, then refresh the witness exactly once.
	// A failure here refuses the move — best-effort belongs to `hydrate`.
	if opts.Fetch {
		store, retainErr, err := mounts.RetainPinInStore(root, mount, identity, mount.Pin, opts.IgnoreContext)
		if err != nil {
			return Result{}, err
		}
		if store == "" {
			return refuse("mount-store-fetch-failed", nil,
				degraded("mount-store-fetch-failed", effectiveRef), "current pin: "+retainErr), nil
		}
		witnessMount := mount
		witnessMount.TrackingRef = effectiveRef
		if ok, refreshErr := mounts.RefreshWitness(store, witnessMount, identity); !ok {
			return refuse("mount-witness-refresh-failed", nil,
				degraded("mount-witness-refresh-failed", effectiveRef), "witness: "+refreshErr), nil
		}
	}

	// (c) The comparison repository and the ONE witness snapshot this run uses for
	// the default target, the report, and the gate alike.
	selection := mounts.SelectComparison(root, mount, effectiveRef)
	if selection.Reason != "" {
		return refuse(selection.Reason, nil, degraded(selection.Reason, effectiveRef)), nil
	}

	// (d) The target: an explicit `--to` must be held by the repository the
	// comparison ran in; otherwise the witness tip itself.
	target := selection.TipOid
	if opts.HasTo {
		target = opts.To
		if !mounts.RunGit([]string{"-C", selection.Repo, "cat-file", "-e", opts.To + "^{commit}"}, "").OK {
			rep := degraded("mount-target-unavailable", effectiveRef)
			rep.ComparisonRepository = strPtr(selection.ComparisonRepository)
			rep.WitnessProvenance = strPtr(selection.WitnessProvenance)
			return refuse("mount-target-unavailable", strPtr(opts.To), rep), nil
		}
	}

	// (e) The report, computed from the same snapshot `status` would report from.
	comparison := mounts.ComparePins(selection.Repo, mount.Pin, selection.TipOid)
	mountBlock := MountBlock{
		Name:           mount.Name,
		SourceIdentity: strPtr(identity),
		From:           strPtr(mount.Pin),
		To:             strPtr(target),
	}
	if mount.TrackingRef != "" {
		mountBlock.TrackingRef = strPtr(mount.TrackingRef)
	}
	if comparison.Reason != "" {
		rep := degraded(comparison.Reason, effectiveRef)
		rep.ComparisonRepository = strPtr(selection.ComparisonRepository)
		rep.WitnessProvenance = strPtr(selection.WitnessProvenance)
		return refuse(comparison.Reason, strPtr(target), rep), nil
	}
	behind, ahead := comparison.Behind, comparison.Ahead
	pinReport := &mounts.PinReport{
		State:                comparison.State,
		Behind:               &behind,
		Ahead:                &ahead,
		ComparedRef:          strPtr(effectiveRef),
		ComparisonRepository: strPtr(selection.ComparisonRepository),
		WitnessProvenance:    strPtr(selection.WitnessProvenance),
		AncestryComplete:     comparison.AncestryComplete,
		ObservedAt:           observedAt,
	}
	settled := func(action string, override bool, fs []findings.Finding) Result {
		return Result{Mount: mountBlock, PinReport: pinReport, Action: action, Override: override, Findings: fs}
	}
	// A refusal after the comparison settled reports the comparison it refused on,
	// and carries whatever the run had already decided: an override exercised at the
	// gate is still reported by a run that then refused for another reason.
	refuseSettled := func(reason string, override bool, warnings []findings.Finding, detail ...string) Result {
		act := optional(detail)
		r := settled(ActionRefused, override, append(
			[]findings.Finding{
				findings.NewWithDetail(reason, findings.Error, reasonProse(reason, act), mount.Name, act),
			},
			warnings...,
		))
		r.Reason = reason
		return r
	}

	// (f) The gate. Nothing to move is its own success, checked before ancestry:
	// asking whether a commit is an ancestor of itself is not the question.
	if target == mount.Pin {
		return settled(ActionUnchanged, false, nil), nil
	}
	override := false
	ancestor := mounts.RunGit([]string{"-C", selection.Repo, "merge-base", "--is-ancestor", mount.Pin, target}, "")
	if !ancestor.OK {
		// Exit 1 is the answer "no"; anything else is the repository unable to answer.
		// A "no" from truncated history is not an answer either, so an incomplete
		// repository never yields the not-fast-forward refusal — nor does the
		// override bypass it.
		if ancestor.Code != 1 || !comparison.AncestryComplete {
			return refuseSettled("mount-ancestry-incomplete", false, nil), nil
		}
		if !opts.HasTo || !opts.AllowNonFastForward {
			return refuseSettled("mount-pin-not-fast-forward", false, nil), nil
		}
		override = true
	}
	var warnings []findings.Finding
	if override {
		warnings = []findings.Finding{findings.New(
			"mount-pin-non-fast-forward-override",
			findings.Warning,
			reasonProse("mount-pin-non-fast-forward-override"),
			mount.Name,
		)}
	}

	// (b iii) The target is retained only once the gate has passed, so a refused run
	// never establishes a pin ref for a commit it declined to move to.
	if opts.Fetch {
		store, retainErr, err := mounts.RetainPinInStore(root, mount, identity, target, opts.IgnoreContext)
		if err != nil {
			return Result{}, err
		}
		if store == "" {
			return refuseSettled("mount-store-fetch-failed", override, warnings, "target: "+retainErr), nil
		}
	}

	// (g) `--dry-run` stops here. The store and network acts `--fetch` was asked for
	// have already happened; only the manifest rewrite is suppressed.
	if opts.DryRun {
		return settled(ActionDryRun, override, warnings), nil
	}

	// (h) The rewrite, through the verified read the trust boundary requires.
	rootReal := fsx.GuardRoot(root)
	manifestAbs := filepath.Join(root, manifest.Filename)
	read, err := fsx.VerifiedTargetRead(rootReal, manifestAbs, "")
	if err != nil {
		return Result{}, err
	}
	if read.Status != fsx.ReadRegular {
		r := settled(ActionRefused, override, warnings)
		r.WriteError = fmt.Sprintf("refusing to write through a symlink that escapes the target: %q", manifest.Filename)
		return r, nil
	}
	original := string(read.Bytes)
	// The bytes that were verified decide whether the declaration this comparison
	// was computed against is still the declaration on disk. Containment says WHICH
	// file was read; only this says it still says the same thing.
	if !declarationUnchanged(original, declaration) {
		return refuseSettled("mount-declaration-changed", override, warnings), nil
	}
	rewritten, changed, rerr := manifest.ReplaceMountPinInManifestText(original, mount.Name, mount.Pin, target)
	if rerr != nil {
		r := settled(ActionRefused, override, warnings)
		r.WriteError = rerr.Error()
		return r, nil
	}
	if changed {
		verdict, werr := fsx.WriteFileAtomicGuarded(rootReal, manifestAbs, "", []byte(rewritten))
		if werr != nil {
			return Result{}, werr
		}
		if !verdict.OK {
			r := settled(ActionRefused, override, warnings)
			r.WriteError = fmt.Sprintf("refusing to write outside the repository: %q", manifest.Filename)
			return r, nil
		}
	}
	return settled(ActionUpdated, override, warnings), nil
}

// declarationSnapshot is the manifest's own values for the addressed mount at the
// moment the comparison was computed. `trackingRef` carries its PRESENCE beside its
// value: a Go string collapses an absent member and an empty one, and the two are
// different declarations.
type declarationSnapshot struct {
	name               string
	source             string
	pin                string
	trackingRef        string
	trackingRefPresent bool
}

// memberString reads one member of a mount object as a JSON string: whether the key
// is there at all, and — only when it is a string — its value. A member spelled
// `null`, or holding any non-string, is present with no string value, which is
// never equal to a declared one.
func memberString(members map[string]json.RawMessage, key string) (value string, present, isString bool) {
	raw, present := members[key]
	if !present {
		return "", false, false
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", true, false
	}
	return value, true, true
}

// declarationUnchanged asks whether the verified manifest text still declares the
// mount this run compared. Only the four fields that decided the selected
// repository, the target and the splice are compared; ownership and routing
// metadata decide none of them.
//
// The members are read raw rather than through the manifest structs, so a member
// that was ABSENT and came back as `null` or `""` reads as the change it is instead
// of collapsing into the same empty string.
func declarationUnchanged(text string, declaration declarationSnapshot) bool {
	var parsed struct {
		Federation *struct {
			Mounts []map[string]json.RawMessage `json:"mounts"`
		} `json:"federation"`
	}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil || parsed.Federation == nil {
		return false
	}
	for _, members := range parsed.Federation.Mounts {
		name, _, isString := memberString(members, "name")
		if !isString || name != declaration.name {
			continue
		}
		source, _, sourceIsString := memberString(members, "source")
		pin, _, pinIsString := memberString(members, "pin")
		if !sourceIsString || source != declaration.source || !pinIsString || pin != declaration.pin {
			return false
		}
		// Absent must stay absent: under `--fetch` the ref actually used may be the
		// source's advertised default, which the manifest never spelled. So presence
		// is compared before the value, and a member that reappeared as `null` or `""`
		// is a changed declaration, not an unchanged one.
		trackingRef, trackingRefPresent, trackingRefIsString := memberString(members, "trackingRef")
		if trackingRefPresent != declaration.trackingRefPresent {
			return false
		}
		return !trackingRefPresent || (trackingRefIsString && trackingRef == declaration.trackingRef)
	}
	return false
}

// optional reads an optional trailing argument, absent being the empty string.
func optional(values []string) string {
	if len(values) > 0 {
		return values[0]
	}
	return ""
}

// reasonProse renders a stable reason code as the sentence a person reads; the code
// itself is what `--json` emits. A code whose acts have different routes forward
// carries one entry per act, keyed `<code>: <act>` exactly as the finding's detail
// spells it, so the table stays the single source of every string this command
// prints; every other code answers for all of its acts at once.
func reasonProse(reason string, detail ...string) string {
	if d := optional(detail); d != "" {
		act := ""
		if i := strings.Index(d, ": "); i > 0 {
			act = d[:i]
		}
		if qualified, ok := Reasons[reason+": "+act]; ok {
			return qualified
		}
	}
	if prose, ok := Reasons[reason]; ok {
		return prose
	}
	return reason
}

// Reasons is prose for this command's stable reason codes: `--json` emits the code,
// a person reads the sentence. The codes above `mount-unknown` are shared with
// `mounts status`, whose prose lives beside the status reasons.
var Reasons = map[string]string{
	"mount-unknown":                 "no mount with this name is declared",
	"mount-source-unnormalizable":   "source is not a normalizable locator",
	"mount-no-tracking-ref":         "no trackingRef declared; the source's advertised default branch needs --fetch",
	"mount-tracking-ref-invalid":    "trackingRef is not a fully qualified branch or tag",
	"mount-default-ref-unavailable": "the source advertises no default branch this run could resolve",
	"mount-pin-unavailable":         "no reachable object store holds the pin (declare a hint, or pass --fetch)",
	"mount-witness-unavailable":     "no object store holding the pin resolves the witness ref; run `leji mounts hydrate --fetch`",
	"mount-source-ambiguous":        "more than one submodule matches the source; declare an explicit hint in .leji/mounts.local.json",
	"mount-ancestry-incomplete":     "incomplete ancestry; the comparison repository cannot answer the range",
	"mount-store-fetch-failed":      "the requested fetch could not retain the commit in the managed store",
	// The current-pin act is the one an operator can route past: an upstream that
	// rewrote its history no longer serves the commit this manifest pins, and the
	// move is still available against a repository that does hold both operands.
	"mount-store-fetch-failed: current pin": "the requested fetch could not retain the commit in the managed store; " +
		"if a local hint holds the current pin and the target with complete ancestry, run without `--fetch`; " +
		"to move past a rewritten upstream, pass `--to <oid> --allow-non-fast-forward` against such a hint",
	"mount-witness-refresh-failed":        "the requested fetch could not refresh the managed witness ref",
	"mount-target-unavailable":            "the requested target commit is not held by the comparison repository",
	"mount-pin-not-fast-forward":          "the target is not a descendant of the current pin (pass --to <oid> --allow-non-fast-forward to move anyway)",
	"mount-declaration-changed":           "leji.json changed while the comparison ran; nothing was written",
	"mount-pin-non-fast-forward-override": "the pin was moved to a commit that is not a descendant of it",
}
