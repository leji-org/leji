// Package conformance scores the layer against the core, indexed, governed, and
// federated checklists.
package conformance

import (
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/freshness"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/git"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	mountslib "github.com/leji-org/leji/packages/sdk-go/internal/mounts"
)

var pinRe = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)

type ItemStatus = string

// The four non-passing outcomes mean four different things and are deliberately
// not interchangeable. Fail: evidence was gathered and the requirement is not met.
// Manual: process-attested, a team practice no repository inspection can certify.
// Unknown: a machine item whose evidence was unobtainable in this run (pin
// reachability without source access; append-only with no git baseline); it never
// awards a level and never refutes an honest claim. NotApplicable: a conditional
// machine item that does not apply to this layer (the federated mount items with no
// mounts declared); it is not scored, and it is not evidence in either direction.
//
// Conformance evaluates the directory it is given, not a canonical layer that
// directory might represent.
const (
	Pass          ItemStatus = "pass"
	Fail          ItemStatus = "fail"
	Manual        ItemStatus = "manual"
	Unknown       ItemStatus = "unknown"
	NotApplicable ItemStatus = "not-applicable"
)

type ChecklistItem struct {
	ID          string
	Level       string
	Description string
	Status      ItemStatus
	Detail      string
}

type Result struct {
	ClaimedLevel  string
	VerifiedLevel string
	// ProcessAttested counts only the fixed spec-tagged set (review gate, CI,
	// external consumption, stale-pin). Those are the only items ever reported Manual:
	// unobtainable evidence is Unknown, and a requirement that does not apply to this
	// layer is NotApplicable.
	ProcessAttested int
	Items           []ChecklistItem
	Findings        []findings.Finding
}

// processAttestedIDs are the spec-tagged items no tool can confirm from the repo
// alone, so they never block a level.
var processAttestedIDs = map[string]bool{
	"review-gate":         true,
	"ci-validates":        true,
	"consumed-externally": true,
	"stale-pin-reporting": true,
}

// mountDiscovery states what `mount-discovery` verifies and what it leaves to the
// team: the enumeration, identity, and presence are machine-checked; the fidelity
// of the authored free text to the declaration is not, and saying so is the honest
// claim.
const mountDiscovery = "the boot profile carries a mount-surfacing block entry for every declared sibling, and the generated index carries the `mounts` routing array (enforced by index currency); what each sibling carries and when to read it are authored task language, whose fidelity to the declaration is the team's to attest"

func countAttested(items []ChecklistItem) int {
	n := 0
	for _, it := range items {
		if processAttestedIDs[it.ID] {
			n++
		}
	}
	return n
}

// Report scores the layer. ClaimedLevel/VerifiedLevel are "" for none. With
// federation it runs the networked pin-reachability probe; the error return
// carries its filesystem failures (TS exceptions).
func Report(root string, federation bool) (Result, error) {
	var items []ChecklistItem
	var fs []findings.Finding
	m := manifest.LoadManifest(root).Manifest

	validation, verr := validate.ValidateLayer(root, false)
	if verr != nil {
		return Result{}, verr
	}
	errorsBy := func(rules ...string) []findings.Finding {
		var out []findings.Finding
		for _, f := range validation.Findings {
			if f.Severity == findings.Error && slices.Contains(rules, f.Rule) {
				out = append(out, f)
			}
		}
		return out
	}
	add := func(id, level, description string, status ItemStatus, detail string) {
		items = append(items, ChecklistItem{ID: id, Level: level, Description: description, Status: status, Detail: detail})
	}
	statusPassFail := func(failing []findings.Finding) ItemStatus {
		if len(failing) == 0 {
			return Pass
		}
		return Fail
	}
	firstMsg := func(fl []findings.Finding) string {
		if len(fl) > 0 {
			return fl[0].Message
		}
		return ""
	}

	manifestErrors := errorsBy("manifest-missing", "manifest-parse", "manifest-schema", "manifest-line")
	add("manifest-valid", "core", "leji.json at the repository root, valid against the manifest schema",
		statusPassFail(manifestErrors), firstMsg(manifestErrors))

	// Git is a hard core MUST (context-layer.md). Conformance evaluates the directory
	// it was given, so "not in a repository" is gathered evidence, not missing
	// evidence: a fail. validate says the same in its git-required finding; the two
	// no longer contradict each other.
	gitStatus, gitDetail := Pass, ""
	if _, inGit := git.Toplevel(root); !inGit {
		gitStatus = Fail
		gitDetail = "not a git repository here; a degraded copy cannot verify conformance"
	}
	add("git", "core", "the context layer lives in a git repository, versioned with the work it describes",
		gitStatus, gitDetail)

	if m == nil {
		for _, f := range validation.Findings {
			if f.Severity == findings.Error {
				fs = append(fs, f)
			}
		}
		return Result{ClaimedLevel: "", VerifiedLevel: "", ProcessAttested: countAttested(items), Items: items, Findings: findings.Sort(fs)}, nil
	}

	var bootErrors []findings.Finding
	for _, f := range errorsBy("missing-declared-file", "path-escapes-root") {
		if f.Path == m.BootProfilePath {
			bootErrors = append(bootErrors, f)
		}
	}
	add("boot-profile", "core", "a boot profile at the declared path covering identity, loading, and posture",
		statusPassFail(bootErrors), firstMsg(bootErrors))

	categoryErrors := errorsBy("categories-minimum", "categories-intent-minimum", "category-index-missing",
		"index-file-missing", "index-file-parse", "category-conflict", "kind-invalid", "freshness-on-record",
		"index-entry-missing", "index-entry-not-markdown", "category-empty", "decisions-empty")
	add("categories", "core", "at least domain or system mapped and populated with at least one intent document, plus decisions with a real record",
		statusPassFail(categoryErrors), firstMsg(categoryErrors))

	ownerStatus := Fail
	if m.Owners.Primary.Name != "" {
		ownerStatus = Pass
	}
	add("owner", "core", "a named primary owner", ownerStatus, "")

	vendorErrors := errorsBy("vendor-adapter-redirect")
	for _, f := range errorsBy("missing-declared-file") {
		if slices.Contains(m.VendorAdapters, f.Path) {
			vendorErrors = append(vendorErrors, f)
		}
	}
	add("vendor-redirects", "core", "vendor entrypoint files, if present, redirect to the boot profile",
		statusPassFail(vendorErrors), firstMsg(vendorErrors))

	indexResult, cerr := indexgen.CheckIndex(root, m)
	if cerr != nil {
		return Result{}, cerr
	}
	indexStatus := Fail
	if indexResult.Stale != nil && !*indexResult.Stale {
		indexStatus = Pass
	}
	add("index-current", "indexed", "a generated context index, current with the tree",
		indexStatus, firstMsg(indexResult.Findings))

	changelogRel := manifest.EffectiveChangelogPath(m)
	if fsx.IsFile(filepath.Join(root, changelogRel)) {
		changelog := validate.CheckChangelogAppendOnly(root, changelogRel, false)
		var changelogErrors []findings.Finding
		for _, f := range changelog.Findings {
			if f.Severity == findings.Error {
				changelogErrors = append(changelogErrors, f)
			}
		}
		switch {
		case len(changelogErrors) > 0:
			add("changelog", "indexed", "a machine-readable changelog; layer changes append entries", Fail, changelogErrors[0].Message)
		case !changelog.Verified:
			add("changelog", "indexed", "a machine-readable changelog; layer changes append entries", Unknown,
				"append-only discipline unverifiable without a git baseline")
		default:
			add("changelog", "indexed", "a machine-readable changelog; layer changes append entries", Pass, "")
		}
	} else {
		add("changelog", "indexed", "a machine-readable changelog; layer changes append entries", Fail,
			"changelog "+changelogRel+" does not exist")
	}

	add("review-gate", "governed", "layer changes ride the repository's review gate; people approve", Manual, "")

	var validProfiles int
	for _, p := range layer.ScanAgentProfiles(root, m) {
		if len(p.Findings) == 0 {
			validProfiles++
		}
	}
	profileStatus := Fail
	profileDetail := "no valid agent profile found"
	if validProfiles > 0 {
		profileStatus = Pass
		profileDetail = ""
	}
	add("agent-profiles", "governed", "agent profiles (at least a core profile) valid against the profile schema",
		profileStatus, profileDetail)

	add("ci-validates", "governed", "CI validates the surface: manifest, index currency, changelog discipline, profiles", Manual, "")

	fresh := freshness.FreshnessReport(root, m, false)
	freshStatus := Fail
	freshDetail := "no freshness.reviewAfter declared anywhere"
	if fresh.Declared > 0 {
		freshStatus = Pass
		freshDetail = fmt.Sprintf("%d horizon(s) declared, %d expired", fresh.Declared, len(fresh.Expired))
	}
	add("freshness-declared", "governed", "freshness horizons are declared and checked (report-only is acceptable)",
		freshStatus, freshDetail)

	add("consumed-externally", "federated", "the context layer is consumed by at least one other repository as a pinned mount", Manual, "")
	add("stale-pin-reporting", "federated", "stale-pin reporting is in place", Manual, "")
	var mounts []manifest.Mount
	if m.Federation != nil {
		mounts = m.Federation.Mounts
	}
	if len(mounts) > 0 {
		// A mount's declaration is complete when it carries a normalized source and a
		// full commit pin (schema-required; re-verified here so conformance stands
		// alone). Materialization is deliberately NOT a conformance input: an
		// unhydrated mount is honest degraded availability, never a failed claim.
		// Pin reachability from the source's advertised witness ref is the networked
		// check (`mounts status`); it reports `unknown` without source access and
		// unknown never awards the level.
		// "Normalized source" is checked with the resolver's own predicate, not with an
		// emptiness test standing in for it: a source that is merely nonempty is not
		// the thing the checklist line and distribution.md name, and an item that
		// passes on one claims evidence it never gathered.
		mountProblem := ""
		for _, mt := range mounts {
			if _, ok := mountslib.NormalizeSource(mt.Source); !ok {
				mountProblem = "mount \"" + mt.Name + "\" declares a source that is not a normalizable locator"
				break
			}
			if !pinRe.MatchString(mt.Pin) {
				mountProblem = "mount \"" + mt.Name + "\" lacks a full commit pin"
				break
			}
		}
		status := Pass
		detail := ""
		if mountProblem != "" {
			status = Fail
			detail = mountProblem
		}
		add("sibling-mounts", "federated", "sibling layers are declared as pinned mounts: a normalized source and a full commit pin, ownership intact", status, detail)
		// Pin reachability needs source access (the networked `--federation` probe);
		// without it the result is unknown, and unknown never awards the level.
		if federation {
			type badMount struct{ name, state, detail string }
			var bad *badMount
			for _, mt := range mounts {
				r, rerr := mountslib.CheckPinReachability(root, mountslib.MountDecl{Name: mt.Name, Source: mt.Source, Pin: mt.Pin, TrackingRef: mt.TrackingRef})
				if rerr != nil {
					return Result{}, rerr
				}
				if r.State != "reachable" {
					bad = &badMount{name: mt.Name, state: r.State, detail: r.Detail}
					break
				}
			}
			pStatus := Pass
			pDetail := ""
			if bad != nil {
				pStatus = Unknown
				if bad.state == "unreachable" {
					pStatus = Fail
				}
				d := bad.detail
				if d == "" {
					d = bad.state
				}
				pDetail = "mount \"" + bad.name + "\": " + d
			}
			add("pin-reachable", "federated", "each mount's pin is reachable from an advertised ref of its source", pStatus, pDetail)
		} else {
			add("pin-reachable", "federated", "each mount's pin is reachable from an advertised ref of its source",
				Unknown, "needs source access; run `leji conformance --federation=verify`")
		}
		var unrouted []manifest.Mount
		for _, mt := range mounts {
			hasTopicsOrRequired := len(mt.Topics) > 0 || len(mt.RequiredWhen) > 0
			if len(mt.Categories) == 0 || !hasTopicsOrRequired {
				unrouted = append(unrouted, mt)
			}
		}
		rStatus := Pass
		rDetail := ""
		if len(unrouted) > 0 {
			rStatus = Fail
			rDetail = "mount \"" + unrouted[0].Name + "\" lacks categories and/or topics or requiredWhen"
		}
		add("mount-routing", "federated", "each mount carries routing metadata: categories, plus topics or requiredWhen", rStatus, rDetail)
		// Surfacing is read from the block scan, not from a substring test: a mount
		// name mentioned in unrelated prose or in an example used to count as
		// surfaced. The findings arrive in the check's own deterministic order, so
		// the detail below is the same first finding in every SDK.
		surfacing := validate.MountSurfacingFindings(root, m)
		dStatus := Pass
		dDetail := ""
		if len(surfacing) > 0 {
			dStatus = Fail
			dDetail = surfacing[0].Message
		}
		add("mount-discovery", "federated", mountDiscovery, dStatus, dDetail)
	} else {
		// All four conditional mount items, in the same order as the branch above:
		// reporting two of them and dropping the other two made the checklist read as
		// though `pin-reachable` and `mount-routing` had simply not been considered.
		// `not-applicable` is not scored either way, so this changes the report, not
		// the level.
		add("sibling-mounts", "federated", "sibling layers are mounted with ownership intact", NotApplicable, "no federation.mounts declared")
		add("pin-reachable", "federated", "each mount's pin is reachable from an advertised ref of its source", NotApplicable, "no federation.mounts declared")
		add("mount-routing", "federated", "each mount carries routing metadata: categories, plus topics or requiredWhen", NotApplicable, "no federation.mounts declared")
		add("mount-discovery", "federated", mountDiscovery, NotApplicable, "no federation.mounts declared")
	}

	// Scoring: highest level whose machine-checkable items all pass. A level is
	// machine-verified only on real machine evidence: every machine item passes AND
	// there is at least one. A level whose items are all process-attested (federated
	// with no mounts) cannot be machine-verified, so it never lifts the level, and
	// Unknown never awards a level (evidence absent is not evidence).
	verified := ""
	for _, level := range manifest.ConformanceLevels {
		machineCount := 0
		failed := false
		for _, it := range items {
			if it.Level == level && it.Status != Manual && it.Status != NotApplicable {
				machineCount++
				if it.Status == Fail || it.Status == Unknown {
					failed = true
				}
			}
		}
		if machineCount == 0 || failed {
			break
		}
		verified = level
	}

	claimed := manifest.ClaimedLevel(m)
	if verified != "" && slices.Index(manifest.ConformanceLevels, verified) > slices.Index(manifest.ConformanceLevels, claimed) {
		verified = claimed
	}
	// The claim gate matches the self-attestation posture: a claim is dishonest
	// when a machine item at or below it FAILS, or when a claimed level carries no
	// machine-evaluated evidence at all (the vacuity trap: e.g. federated with zero
	// mounts). Manual never blocks a claim, and neither does Unknown: absent
	// evidence caps the verified level, but an offline run does not refute a claim
	// the networked probe could confirm.
	claimedIdx := slices.Index(manifest.ConformanceLevels, claimed)
	claimProblem := false
	for _, level := range manifest.ConformanceLevels[:claimedIdx+1] {
		evaluated := 0
		anyFail := false
		for _, it := range items {
			if it.Level == level && it.Status != Manual && it.Status != NotApplicable {
				evaluated++
				if it.Status == Fail {
					anyFail = true
				}
			}
		}
		if evaluated == 0 || anyFail {
			claimProblem = true
			break
		}
	}
	// %q is safe on both operands: claimed is the manifest's claimedLevel, a schema
	// enum of four ASCII literals that Report only ever sees on a schema-valid
	// manifest, and v is one of ConformanceLevels or the literal "none".
	if claimProblem {
		v := verified
		if v == "" {
			v = "none"
		}
		fs = append(fs, findings.New("conformance-claim", findings.Error,
			fmt.Sprintf("claimed level %q exceeds the verified level %q", claimed, v), "leji.json"))
	}

	return Result{ClaimedLevel: claimed, VerifiedLevel: verified, ProcessAttested: countAttested(items), Items: items, Findings: findings.Sort(fs)}, nil
}

// RenderExplain produces `conformance --explain` guidance: what it takes to reach
// the next level above the verified one.
func RenderExplain(result Result) string {
	levels := manifest.ConformanceLevels
	verifiedIdx := -1
	if result.VerifiedLevel != "" {
		verifiedIdx = slices.Index(levels, result.VerifiedLevel)
	}
	verified := result.VerifiedLevel
	if verified == "" {
		verified = "none"
	}
	claimed := result.ClaimedLevel
	if claimed == "" {
		claimed = "none"
	}
	lines := []string{fmt.Sprintf("Verified level: %s (claimed: %s).", verified, claimed)}
	nextIdx := verifiedIdx + 1
	if nextIdx >= len(levels) {
		lines = append(lines, "This layer is at the top conformance level (federated). Nothing further to reach.")
		return strings.Join(lines, "\n")
	}
	next := levels[nextIdx]
	var blockers []ChecklistItem
	for _, it := range result.Items {
		// NotApplicable is not a blocker: there is nothing to do about a requirement
		// that does not apply to this layer.
		if it.Level == next && it.Status != Pass && it.Status != NotApplicable {
			blockers = append(blockers, it)
		}
	}
	// %q is safe on next: it indexes the ConformanceLevels literal, never input.
	lines = append(lines, "", fmt.Sprintf("To reach %q:", next))
	if len(blockers) == 0 {
		lines = append(lines, fmt.Sprintf("   - all %q checks already pass; set conformance.claimedLevel to %q in leji.json", next, next))
	} else {
		for _, b := range blockers {
			how := ""
			if b.Status == Manual {
				how = " (process step; tooling cannot verify)"
			} else if b.Status == Unknown {
				how = " (evidence unobtainable in this run; unknown never awards the level)"
			}
			detail := ""
			if b.Detail != "" {
				detail = ": " + b.Detail
			}
			lines = append(lines, fmt.Sprintf("   - %s%s%s", b.Description, detail, how))
		}
	}
	lines = append(lines,
		"",
		"Content quality (not a conformance gate): run `leji validate --content` for placeholder and thin-content warnings.")
	return strings.Join(lines, "\n")
}
