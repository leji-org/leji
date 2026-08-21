// Package badge implements `leji badge`: the local, self-attested conformance
// badge. The command scores the layer with conformance.Report (federation never
// verified, so the run is offline by construction), renders the canonical SVG for
// the level THIS run verified, and returns the markdown that embeds it. There is
// no endpoint, no registry, and no hosted service anywhere in this package or the
// ones it imports: the bytes are constants, and the only thing that varies is
// which level's constants are used.
//
// The four files under `fixtures/badge/` are the byte oracle for everything here,
// and `fixtures/README.md` -> "The `badge` block" is the normative contract the
// three SDKs implement. Mirrors packages/sdk/src/commands/badge.ts.
package badge

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/layout"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

// DefaultOut is the badge target when `--out` is not given: a repository-root
// file, one copy-paste from a root README.
const DefaultOut = "leji-badge.svg"

// agentReadyURL is the page the markdown wrapper links. One constant, never
// configurable.
const agentReadyURL = "https://leji.org/agent-ready/"

// OutRule is the `--out` acceptance rule, quoted verbatim by the usage error that
// rejects a path (`fixtures/README.md` -> "The `--out` acceptance rule").
const OutRule = "--out takes a repository-relative POSIX path over [A-Za-z0-9._/-], with no leading /, no backslash, " +
	`no ".." segment, no empty segment, and ending .svg`

// markPath is the mark: the single `<path>` of `packages/site/src/assets/leji-icon.svg`
// (viewBox `0 0 370 391`), inlined as a constant rather than read at runtime. The
// badge is a frozen byte contract, so it can never depend on a file a caller could
// replace or a package could ship differently.
const markPath = "M185.038 77.918C162.621 77.942 144.384 96.185 144.372 118.607C144.382 136.031 155.422 150.887 170.856 156.67V305.245H199.225V156.671C214.663 150.888 225.707 136.031 225.724 118.608C225.703 96.184 207.46 77.942 185.038 77.918ZM185.043 130.9C178.268 130.896 172.747 125.372 172.747 118.607C172.747 111.833 178.262 106.318 185.037 106.303C191.816 106.318 197.337 111.832 197.337 118.607C197.337 125.372 191.811 130.896 185.043 130.9ZM349.766 22.16C336.469 8.72897 317.174 0.943 295.071 0H74.715C52.613 0.943 33.319 8.72897 20.021 22.16C7.09602 35.134 -0.0149763 52.521 2.36824e-05 71.128C2.36824e-05 87.589 5.66601 103.074 15.951 114.726C26.651 126.955 42.597 134.172 59.95 134.713C63.415 134.798 81.128 134.812 97.081 127.028V311.413C81.642 317.196 70.595 332.056 70.585 349.48C70.597 371.898 88.841 390.139 111.255 390.156C133.679 390.139 151.919 371.898 151.935 349.48C151.923 332.055 140.88 317.2 125.443 311.417V58.449H244.589V211.559C229.155 217.342 218.114 232.193 218.105 249.622C218.118 272.053 236.357 290.295 258.779 290.295C281.193 290.295 299.431 272.053 299.453 249.622C299.437 232.193 288.39 217.338 272.957 211.559V127.147C288.846 134.809 306.393 134.797 309.84 134.712C327.192 134.171 343.138 126.953 353.838 114.725C364.123 103.074 369.789 87.588 369.789 71.127C369.801 52.521 362.692 35.134 349.766 22.16ZM111.261 361.782C104.487 361.763 98.965 356.247 98.959 349.491C98.965 342.705 104.486 337.187 111.254 337.187C118.024 337.187 123.543 342.709 123.559 349.476C123.543 356.247 118.016 361.764 111.261 361.782ZM258.786 261.931C252.005 261.917 246.483 256.392 246.483 249.622C246.483 242.843 252.004 237.334 258.778 237.334C265.542 237.334 271.063 242.847 271.079 249.612C271.063 256.386 265.542 261.917 258.786 261.931ZM332.597 95.914C326.347 102.87 318.107 106.295 307.41 106.378C288.412 106.165 281.539 100.531 277.324 95.052C275.131 92.123 273.783 88.628 272.955 85.317V58.45H300.57C303.603 58.45 306.808 59.782 307.015 59.87C308.813 60.684 310.429 61.838 311.277 63.098C311.993 64.174 312.539 65.34 312.574 67.815C312.523 70.481 311.668 72.002 310.269 73.352C308.873 74.643 306.746 75.487 304.64 75.471C301.994 75.386 299.636 74.504 297.46 71.373C294.728 67.264 289.187 66.153 285.077 68.885C282.002 70.933 280.603 74.56 281.247 77.978C287.59 93.654 305.199 93.329 305.415 93.324C311.64 93.133 317.642 90.795 322.325 86.535C327.213 82.137 330.485 75.362 330.436 67.815C330.47 61.991 328.678 56.727 325.883 52.813C323.102 48.875 319.584 46.292 316.354 44.568C310.887 41.694 306.067 40.887 304.242 40.68H66.514C64.69 40.887 59.868 41.694 54.402 44.568C51.173 46.293 47.654 48.875 44.873 52.813C42.079 56.727 40.286 61.991 40.321 67.815C40.272 75.362 43.544 82.136 48.431 86.535C53.116 90.795 59.116 93.133 65.342 93.324C65.557 93.329 83.167 93.654 89.51 77.978C90.153 74.56 88.754 70.933 85.68 68.885C81.57 66.154 76.028 67.264 73.296 71.373C71.119 74.504 68.762 75.386 66.117 75.471C64.011 75.487 61.884 74.643 60.488 73.352C59.09 72.001 58.232 70.481 58.182 67.815C58.216 65.34 58.763 64.174 59.479 63.098C60.327 61.838 61.943 60.685 63.741 59.87C63.949 59.782 67.152 58.45 70.185 58.45H97.08V84.257C96.283 87.871 94.891 91.81 92.463 95.053C88.248 100.532 81.375 106.166 62.375 106.379C51.68 106.296 43.439 102.871 37.19 95.915C31.563 89.595 28.351 80.556 28.371 71.129C28.379 60.046 32.544 49.776 40.101 42.199C49.323 33.015 62.602 28.34 79.568 28.291H290.218C307.183 28.34 320.462 33.016 329.684 42.199C337.242 49.776 341.407 60.046 341.415 71.129C341.435 80.555 338.223 89.594 332.597 95.914Z"

// statusTextLength is the one per-level constant: the wordmark's `textLength` is
// fixed at 41 and every other width derives from the status text's
// (`fixtures/README.md` -> "The canonical badge bytes"). Horizontal padding is 5
// either side, the mark occupies a 14-wide slot with a 3-wide gap, so the identity
// segment is 5+14+3+41+5 = 68 and the status segment is `textLength + 10`.
var statusTextLength = map[string]int{
	"core":      24,
	"indexed":   43,
	"governed":  52,
	"federated": 53,
}

// identityWidth is the identity segment's fixed width, and wordmark the text it
// carries.
const identityWidth = 68
const wordmark = "Leji 1.0"

// Label is the accessible name and the markdown alt text: one string, three places.
// It carries the full self-attestation claim, which the badge FACE does not: the
// visible status segment is the level alone, and the claim stays structural — in the
// `<title>`, the `aria-label`, and the markdown alt — with the linked agent-ready
// page carrying the story.
func Label(level string) string {
	return wordmark + " · " + level + " · self-attested"
}

// Render is the canonical badge for one level, byte for byte: shields-flat shape,
// height 20, rounded by a clipPath, the mark and wordmark on the `#183D3B` identity
// segment and `<level>` alone on the `#009F71` status segment. No XML declaration, no
// BOM, no comment, no timestamp, no version string; UTF-8, LF, one trailing newline.
// Compared against `fixtures/badge/<level>.svg` by unit test.
func Render(level string) string {
	status := statusTextLength[level]
	statusWidth := status + 10
	width := identityWidth + statusWidth
	label := Label(level)
	return fmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" role="img" width="%d" height="20" aria-label="%s">`+"\n"+
			`<title>%s</title>`+"\n"+
			`<clipPath id="r"><rect width="%d" height="20" rx="3"/></clipPath>`+"\n"+
			`<g clip-path="url(#r)">`+"\n"+
			`<rect width="%d" height="20" fill="#183D3B"/>`+"\n"+
			`<rect x="%d" width="%d" height="20" fill="#009F71"/>`+"\n"+
			`<path fill="#FFFFFF" transform="translate(5 3) scale(0.0358)" d="%s"/>`+"\n"+
			`</g>`+"\n"+
			`<g fill="#FFFFFF" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`+"\n"+
			`<text x="22" y="14" textLength="41" lengthAdjust="spacing">%s</text>`+"\n"+
			`<text x="73" y="14" textLength="%d" lengthAdjust="spacing">%s</text>`+"\n"+
			`</g>`+"\n"+
			`</svg>`+"\n",
		width, label, label, width, identityWidth, identityWidth, statusWidth, markPath,
		wordmark, status, level,
	)
}

// Markdown is the one markdown line the command prints: the badge image, wrapped in
// a link to the agent-ready page. out is the canonical POSIX path, relative to the
// repository root, so a root README embeds it as written.
func Markdown(level, out string) string {
	return "[![" + Label(level) + "](" + out + ")](" + agentReadyURL + ")\n"
}

// canonicalBadges is every canonical badge of this contract, which is exactly what
// an existing file is recognized against: its own bytes, and no marker, sidecar, or
// state.
var canonicalBadges = func() []string {
	out := make([]string, 0, len(manifest.ConformanceLevels))
	for _, level := range manifest.ConformanceLevels {
		out = append(out, Render(level))
	}
	return out
}()

func isCanonicalBadge(bytes string) bool {
	for _, b := range canonicalBadges {
		if b == bytes {
			return true
		}
	}
	return false
}

// The actions a run can report: what it did to the target file — wrote it (absent),
// left it unchanged (it already held these exact bytes), or overwrote another
// canonical badge of this contract, which is how a level change regenerates.
const (
	Wrote     = "wrote"
	Unchanged = "unchanged"
	Overwrote = "overwrote"
)

// Result is one `leji badge` run, in the shape the caller renders in either
// channel. A failed run carries Out, Level, Markdown and Action empty (JSON null)
// and says why in Findings; ClaimedLevel and VerifiedLevel are reported whatever
// the outcome, so a refusal is still honest about what the layer claims. Every
// string field is empty for "none", which the JSON channel emits as null; none of
// them has a legitimate empty value.
type Result struct {
	Out           string
	Level         string
	ClaimedLevel  string
	VerifiedLevel string
	Markdown      string
	Action        string
	Findings      []findings.Finding
	// UsageError is set when `--out` was rejected at argument parsing, before
	// conformance ran: the caller prints this in the CLI's usage-error form and exits
	// 2, reporting no level.
	UsageError string
	// Refusal is set when the target exists and is not a badge of this contract: exit
	// 2, the file untouched. Reported after conformance, so the levels above are
	// populated.
	Refusal string
}

// outCharset is the syntax half of the `--out` rule, on the spelling alone.
var outCharset = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

func acceptedOutSyntax(out string) bool {
	if !outCharset.MatchString(out) {
		return false
	}
	if strings.HasPrefix(out, "/") || !strings.HasSuffix(out, ".svg") {
		return false
	}
	for _, seg := range strings.Split(out, "/") {
		if seg == "" || seg == ".." {
			return false
		}
	}
	return true
}

// canonicalOut is the canonical POSIX form of an accepted `--out`: the spelling
// with its `.` segments dropped, which is what stdout, `--json`, and the markdown
// carry.
func canonicalOut(out string) string {
	segs := strings.Split(out, "/")
	kept := segs[:0]
	for _, seg := range segs {
		if seg != "." {
			kept = append(kept, seg)
		}
	}
	return strings.Join(kept, "/")
}

// checkOut is the `--out` check, run at argument parsing and BEFORE conformance:
// the syntax rule above, then containment of the RESOLVED path — inside the
// repository, never under `.leji/` at any depth (that tree is the tool's own domain
// and the badge is user content), and not a directory. Returns the usage-error text
// on a rejection, else the canonical relative path and the resolved absolute one.
func checkOut(rootAbs, out string) (rel, abs, usageError string) {
	// The path is quoted by concatenation, never by %q: the reference interpolates
	// the spelling as given, and a Go-escaped backslash would diverge on exactly the
	// input the rule exists to reject.
	if !acceptedOutSyntax(out) {
		return "", "", OutRule + ` (got "` + out + `")`
	}
	rel = canonicalOut(out)
	abs = filepath.Join(rootAbs, filepath.FromSlash(rel))
	resolved, ok := fsx.ResolvedPath(abs)
	if !ok {
		return "", "", `--out "` + rel + `" cannot be resolved (permission or I/O error)`
	}
	if !fsx.ResolvedWithinRoot(rootAbs, abs) {
		return "", "", `--out "` + rel + `" must resolve inside the repository`
	}
	// No own role: the badge has no legitimate `.leji/` landing at any depth.
	if verdict := layout.WritableTarget(rootAbs, resolved, ""); !verdict.OK {
		return "", "", `--out "` + rel + `" resolves inside .leji/, the tool's own domain; the badge is user content`
	}
	if fsx.IsDir(resolved) {
		return "", "", `--out "` + rel + `" is a directory`
	}
	return rel, abs, ""
}

// Run runs `leji badge` over root, writing the badge for the level this offline run
// verified. The order is fixed and is part of the contract: `--out` is judged first
// (a usage error reports no level at all), then conformance decides whether there
// is anything honest to state, and only then does the existing target decide the
// action. Operational filesystem failures travel out as errors, which the CLI
// renders the way it renders every other one.
func Run(root, out string) (Result, error) {
	rootAbs := fsx.GuardRoot(root)
	rel, abs, usageError := checkOut(rootAbs, out)
	if usageError != "" {
		return Result{UsageError: usageError}, nil
	}

	// Federation is never verified: the badge states what an offline run established,
	// which is why it can sit below the claim and never above it.
	report, err := conformance.Report(root, false)
	if err != nil {
		return Result{}, err
	}
	base := Result{ClaimedLevel: report.ClaimedLevel, VerifiedLevel: report.VerifiedLevel}
	withFinding := func(f findings.Finding) Result {
		r := base
		r.Findings = findings.Sort(append(append([]findings.Finding{}, report.Findings...), f))
		return r
	}
	if findings.HasErrors(report.Findings) {
		r := base
		r.Findings = findings.Sort(report.Findings)
		return r, nil
	}
	if report.VerifiedLevel == "" {
		return withFinding(findings.New("badge-unverified", findings.Error,
			"no level verified in this run; the badge states only what was verified", "leji.json")), nil
	}

	level := report.VerifiedLevel
	svg := Render(level)

	// Check-before-act, badge-side. checkOut judged the target as it was spelled at
	// argument parsing; the read below and the write after it are separate acts, and a
	// component of the path can become a symlink in between. So the boundary is
	// re-established immediately before each act, on the RESOLVED path, by the shared
	// rule itself: VerifiedTargetRead for the read, the guarded write for the write.
	refuseTarget := func() Result {
		r := withFinding(findings.New("badge-target-refused", findings.Error,
			rel+" does not resolve to a regular file inside the repository", rel))
		r.Refusal = rel + " does not resolve to a regular file inside the repository; nothing was written"
		return r
	}

	// The existing target is read through the shared verified read: the standing entry
	// decides its own kind (a directory, a socket, a link to one: refused, never
	// written through), the resolved location is judged by the same rule the write
	// below is judged by, and the bytes come from the descriptor proved to be that
	// file. Absence is decided on the ORIGINAL entry, so a dangling link — standing,
	// resolving nowhere — is a refusal rather than an absent target written through.
	read, err := fsx.VerifiedTargetRead(rootAbs, abs, "")
	if err != nil {
		return Result{}, err
	}
	if read.Status == fsx.ReadRefused {
		return refuseTarget(), nil
	}
	present := read.Status == fsx.ReadRegular
	existing := ""
	if present {
		existing = string(read.Bytes)
	}
	if present && !isCanonicalBadge(existing) {
		r := withFinding(findings.New("badge-target-foreign", findings.Error, rel+" is not a leji badge", rel))
		r.Refusal = rel + " exists and is not a leji badge; remove or rename it"
		return r, nil
	}
	action := Wrote
	if present {
		action = Overwrote
		if existing == svg {
			action = Unchanged
		}
	}
	if action != Unchanged {
		// The guarded-write chokepoint re-resolves the target immediately before the
		// write and answers the whole boundary — inside the repository, outside
		// `.leji/` — so nothing here is inherited from the parse-time verdict. Parent
		// directories are created only inside a write that happens: a run that writes
		// nothing (a refusal, an unchanged target) establishes no directory either.
		verdict, werr := fsx.WriteFileGuarded(rootAbs, abs, "", []byte(svg), fsx.WriteOptions{})
		if werr != nil {
			return Result{}, werr
		}
		if !verdict.OK {
			return refuseTarget(), nil
		}
	}
	return Result{
		Out:           rel,
		Level:         level,
		ClaimedLevel:  report.ClaimedLevel,
		VerifiedLevel: level,
		Markdown:      Markdown(level, rel),
		Action:        action,
		Findings:      findings.Sort(report.Findings),
	}, nil
}
