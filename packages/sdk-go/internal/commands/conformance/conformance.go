// Package conformance scores the layer against the core, indexed, governed, and
// federated checklists, mirroring the Node SDK.
package conformance

import (
	"fmt"
	"path/filepath"
	"slices"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/freshness"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/git"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

type ItemStatus = string

const (
	Pass   ItemStatus = "pass"
	Fail   ItemStatus = "fail"
	Manual ItemStatus = "manual"
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
	Items         []ChecklistItem
	Findings      []findings.Finding
}

// Report scores the layer. ClaimedLevel/VerifiedLevel are "" for none.
func Report(root string) Result {
	var items []ChecklistItem
	var fs []findings.Finding
	m := manifest.LoadManifest(root).Manifest

	validation := validate.ValidateLayer(root)
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

	// Git is a hard core MUST (context-layer.md). Reported as `manual` (not `fail`)
	// when git can't be resolved, so the scorer stays usable on copies/detached
	// checkouts; enforcement lives in validate's git-required finding.
	gitStatus, gitDetail := Pass, ""
	if _, inGit := git.Toplevel(root); !inGit {
		gitStatus = Manual
		gitDetail = "not resolvable to a git repository here; verify in the canonical repository"
	}
	add("git", "core", "the context layer lives in a git repository, versioned with the work it describes",
		gitStatus, gitDetail)

	if m == nil {
		for _, f := range validation.Findings {
			if f.Severity == findings.Error {
				fs = append(fs, f)
			}
		}
		return Result{ClaimedLevel: "", VerifiedLevel: "", Items: items, Findings: findings.Sort(fs)}
	}

	var bootErrors []findings.Finding
	for _, f := range errorsBy("missing-declared-file") {
		if f.Path == m.BootProfilePath {
			bootErrors = append(bootErrors, f)
		}
	}
	add("boot-profile", "core", "a boot profile at the declared path covering identity, loading, and posture",
		statusPassFail(bootErrors), firstMsg(bootErrors))

	categoryErrors := errorsBy("categories-minimum", "category-path-missing", "category-empty", "decisions-empty")
	add("categories", "core", "at least domain or system mapped and populated, plus decisions with a real record",
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

	indexResult := indexgen.CheckIndex(root, m)
	indexStatus := Fail
	if indexResult.Stale != nil && !*indexResult.Stale {
		indexStatus = Pass
	}
	add("index-current", "indexed", "a generated context index, current with the tree",
		indexStatus, firstMsg(indexResult.Findings))

	var changelogRel string
	if m.Machine != nil {
		changelogRel = m.Machine.ChangelogPath
	}
	if changelogRel != "" && fsx.IsFile(filepath.Join(root, changelogRel)) {
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
			add("changelog", "indexed", "a machine-readable changelog; layer changes append entries", Manual,
				"append-only discipline unverifiable without a git baseline")
		default:
			add("changelog", "indexed", "a machine-readable changelog; layer changes append entries", Pass, "")
		}
	} else {
		detail := "no machine.changelogPath declared"
		if changelogRel != "" {
			detail = "declared changelog " + changelogRel + " does not exist"
		}
		add("changelog", "indexed", "a machine-readable changelog; layer changes append entries", Fail, detail)
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

	add("consumed-externally", "federated", "the context layer is consumed by at least one other repository as a pinned docs-only mount", Manual, "")
	add("stale-pin-reporting", "federated", "stale-pin reporting is in place", Manual, "")
	var mounts []manifest.Mount
	if m.Federation != nil {
		mounts = m.Federation.Mounts
	}
	if len(mounts) > 0 {
		var missing []manifest.Mount
		for _, mt := range mounts {
			if !fsx.Exists(filepath.Join(root, mt.Path)) {
				missing = append(missing, mt)
			}
		}
		status := Pass
		detail := ""
		if len(missing) > 0 {
			status = Fail
			detail = "mount path " + missing[0].Path + " does not exist"
		}
		add("sibling-mounts", "federated", "sibling layers are mounted with ownership intact", status, detail)
	} else {
		add("sibling-mounts", "federated", "sibling layers are mounted with ownership intact", Manual, "no federation.mounts declared")
	}

	// Scoring: highest level whose machine-checkable items all pass.
	verified := ""
	for _, level := range manifest.ConformanceLevels {
		failed := false
		for _, it := range items {
			if it.Level == level && it.Status != Manual && it.Status == Fail {
				failed = true
				break
			}
		}
		if failed {
			break
		}
		verified = level
	}

	claimed := manifest.ClaimedLevel(m)
	if verified != "" && slices.Index(manifest.ConformanceLevels, verified) > slices.Index(manifest.ConformanceLevels, claimed) {
		verified = claimed
	}
	if verified == "" || slices.Index(manifest.ConformanceLevels, claimed) > slices.Index(manifest.ConformanceLevels, verified) {
		v := verified
		if v == "" {
			v = "none"
		}
		fs = append(fs, findings.New("conformance-claim", findings.Error,
			fmt.Sprintf("claimed level %q exceeds the verified level %q", claimed, v), "leji.json"))
	}

	return Result{ClaimedLevel: claimed, VerifiedLevel: verified, Items: items, Findings: findings.Sort(fs)}
}
