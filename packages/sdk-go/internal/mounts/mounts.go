// Package mounts is the federation resolver: it materializes a mount's pinned
// layer projection into the gitignored cache under `.leji/mounts/`
// (distribution.md pattern 3). Mirrors lib/mounts.ts.
//
// Contracts (per the resolver-only mounts design):
//   - The pin is resolved from a git object store, never a working tree.
//   - the projection extracts the sibling's leji.json, its rootPath tree, and its
//     agent-profiles path if outside rootPath; nothing else. Gitlinks are recorded
//     in metadata, never materialized; LFS pointers extract as the pointers they are.
//   - Caches are keyed by sha256(source identity \n pin \n cache format version)
//     and published by rename-if-absent under a `complete` marker; no global lock.
//   - The sidecar is evidence, never proof: verification reads the object store.
//   - No network unless the caller passes fetch: true (git fetch into the
//     resolver-managed store); everything else is offline.
//   - The witness namespace is the resolver's own: `hydrate --fetch` writes
//     refs/leji-witness/v1/ in the managed store and nothing else does, so pin
//     ancestry has a ref to compare against without `status` ever fetching.
package mounts

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

const (
	// CacheFormatVersion is the single cache-invalidation epoch: bump it and every
	// key changes.
	// "2": the projection closure (boot profile, machine artifacts, category indexes,
	// bound agent profiles, indexed governed paths) replaced the root-tree-only
	// extraction; entries under "1" hold incomplete projections for the same pin.
	CacheFormatVersion = "2"
	// WitnessRefNamespace is the resolver-owned witness namespace in the managed store.
	WitnessRefNamespace = "refs/leji-witness"
	// PinRefNamespace is the resolver-owned pin namespace: what keeps the version
	// of record from being pruned.
	PinRefNamespace = "refs/leji-pin"
)

// Normative projection limits, identical across SDKs.
const (
	MaxProjectionFiles = 65536
	MaxProjectionBytes = int64(2) * 1024 * 1024 * 1024
	MaxProjectionPath  = 4096
)

// MaxTreeListingBytes is what one whole-tree listing may occupy in transport.
//
// This bounds tree *metadata* — one mode/type/oid/path record per entry in the
// pinned commit — not projected content, which is what MaxProjectionBytes caps.
// The two are deliberately different numbers: the listing enumerates the entire
// repository so that selection can happen in-process, so capping it at the content
// limit would fail a large repository that holds a perfectly small valid
// projection. At the normative 65,536-file limit this leaves about 4 KiB per entry,
// against a path limit of MaxProjectionPath and roughly 60 bytes of fixed record
// overhead.
const MaxTreeListingBytes = int64(256) * 1024 * 1024

// Why a projection failed, tagged where the failure is created and carried outward
// unchanged. KindUnavailable is degraded knowledge of the pinned layer (the
// declaration is sound; the pin's content is missing or malformed), KindSafety is a
// guard the projection refuses to cross. Nothing downstream re-derives the class
// from the detail text: a stable sentence is output, never a classifier.
const (
	KindUnavailable = "unavailable"
	KindSafety      = "safety"
)

// MountDecl is a declared federation mount ("" TrackingRef = undeclared).
type MountDecl struct {
	Name        string
	Source      string
	Pin         string
	TrackingRef string
}

// HydrateOutcome reports one mount's hydrate result; every field is recomputable
// from the manifest and the cache, so last-writer-wins is correct by
// construction. Empty optional fields are omitted from JSON, mirroring the TS
// undefined fields.
type HydrateOutcome struct {
	Name         string
	Status       string // hydrated | cached | unavailable | error
	Detail       string
	CacheKey     string
	ObjectSource string
	// StoreFetched is set when --fetch was requested: did the managed store get
	// established?
	StoreFetched *bool
	// WitnessRefreshFailed is true only when this run attempted the witness
	// refresh and it did not publish. The run reporting on itself, never a
	// remembered observation: nothing about it is recorded, and a later `status`
	// neither reads nor reports it.
	WitnessRefreshFailed bool
	// ProjectionFailed is set when the projection itself decided this outcome,
	// which separates an `unavailable` mount whose pinned layer would not project
	// from one no reachable object store holds.
	ProjectionFailed bool
}

// HydrateResult carries the per-mount outcomes, or a fatal refusal.
type HydrateResult struct {
	Outcomes []HydrateOutcome
	Fatal    string
}

// HydrateOptions mirror hydrateMounts' opts.
type HydrateOptions struct {
	Fetch bool
	Names []string
}

// LocateResult mirrors the TS LocateResult (nil pointers = JSON null).
type LocateResult struct {
	Name           string
	SourceIdentity *string
	Pin            *string
	Present        bool
	Verified       bool
	Path           *string
	Detail         string
}

// PinReport is the ancestry-aware pin report inside a StatusResult. Behind and
// Ahead are omitted (nil), never null, when a count was not computed; Reason is
// a stable code present only when the report is degraded.
type PinReport struct {
	State  string // behind | ahead | diverged | unrelated | up-to-date | unknown
	Behind *int
	Ahead  *int
	// ComparisonRepository names which repository the pin and the witness were
	// both read from; WitnessProvenance says whether the witness is the
	// resolver's own ref (managed) or one the tool does not own (unmanaged).
	ComparedRef          *string
	ComparisonRepository *string
	WitnessProvenance    *string
	// AncestryComplete is commit-ancestry completeness only: unshallow history
	// and both counts computed. Never a claim that the remote was observed.
	AncestryComplete bool
	Reason           string
	ObservedAt       string
}

// StatusResult mirrors the TS StatusResult; Verified is three-valued (nil when
// not checked or unverifiable).
type StatusResult struct {
	Name           string
	SourceIdentity *string
	Pin            string
	TrackingRef    *string
	Present        bool
	Verified       *bool
	PinReport      PinReport
}

// StatusOptions mirror mountStatus' opts. Now is the injectable clock: zero
// means wall clock, read once per execution.
type StatusOptions struct {
	CheckIntegrity bool
	Now            time.Time
}

var scpRe = regexp.MustCompile(`^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$`)
var sourceRe = regexp.MustCompile(`^(https|ssh)://(?:([^@/]+)@)?([A-Za-z0-9.-]+)(?::(\d+))?/(.*)$`)

// NormalizeSource normalizes a repository locator to its canonical identity:
// https://, ssh://, or SCP-style (git@host:path, rewritten to ssh://git@host/path).
// Lowercases scheme and host, strips userinfo except the ssh user, strips one
// trailing "/" and one trailing ".git". ok is false for anything else (local
// paths belong in hints).
func NormalizeSource(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", false
	}
	// SCP-style: user@host:path (no scheme, single colon before the path). The TS
	// regex uses a lookahead ((?!//)); RE2 has none, so match then reject "//".
	if scp := scpRe.FindStringSubmatch(s); scp != nil && !strings.HasPrefix(scp[3], "//") {
		s = "ssh://" + scp[1] + "@" + scp[2] + "/" + scp[3]
	}
	m := sourceRe.FindStringSubmatch(s)
	if m == nil {
		return "", false
	}
	scheme := strings.ToLower(m[1])
	user := m[2]
	host := strings.ToLower(m[3])
	port := ""
	if m[4] != "" {
		port = ":" + m[4]
	}
	p := m[5]
	p = strings.TrimSuffix(p, "/")
	p = strings.TrimSuffix(p, ".git")
	if p == "" || strings.Contains(p, "\\") {
		return "", false
	}
	// Userinfo is stripped except the ssh user; credentials never enter identities.
	userPart := ""
	if scheme == "ssh" && user != "" {
		userPart = strings.SplitN(user, ":", 2)[0] + "@"
	}
	return scheme + "://" + userPart + host + port + "/" + p, true
}

// Sha256Hex hashes a string to lowercase hex.
func Sha256Hex(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

// CacheKeyFor derives the cache key for a source identity at a pin.
func CacheKeyFor(sourceIdentity, pin string) string {
	return Sha256Hex(sourceIdentity + "\n" + pin + "\n" + CacheFormatVersion)
}

// MountsDir is the resolver-owned cache root under the host layer.
func MountsDir(root string) string {
	return filepath.Join(root, ".leji", "mounts")
}

// readTextWithin mirrors Node's readTextWithin: nil (ok=false) unless abs is a
// regular file that resolves inside root.
func readTextWithin(root, abs string) (string, bool) {
	if !fsx.IsFile(abs) || !fsx.ResolvesUnder(root, abs) {
		return "", false
	}
	text, err := fsx.ReadText(abs)
	if err != nil {
		return "", false
	}
	return text, true
}

// ReadHints reads the machine-local resolution hints (never committed):
// .leji/mounts.local.json.
func ReadHints(root string) map[string]string {
	out := map[string]string{}
	raw, ok := readTextWithin(root, filepath.Join(root, ".leji", "mounts.local.json"))
	if !ok {
		return out
	}
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return out
	}
	obj, _ := parsed.(map[string]any)
	entries, _ := obj["mounts"].(map[string]any)
	for name, entry := range entries {
		if eo, ok := entry.(map[string]any); ok {
			if repo, ok := eo["repo"].(string); ok && repo != "" {
				out[name] = repo
			}
		}
	}
	return out
}

// GitResult mirrors the TS runGit contract: ok, raw stdout bytes, git's exit
// status, and an error string (trimmed stderr, or the process error message).
// Callers that read an answer out of the status (merge-base) must separate the
// answer's exit codes from operational failure. Code is -1 when unknown.
type GitResult struct {
	OK     bool
	Stdout []byte
	Code   int
	Error  string
	// Overflowed reports that the output did not fit the caller's byte cap. Tagged
	// here, where the writer that refused the bytes still owns the fact, so no
	// caller has to recognize a transport failure by its message (Node reports the
	// same condition as an ENOBUFS errno).
	Overflowed bool
}

// cappedBuffer accumulates output up to a byte cap and records its own overflow.
// Go's exec has no maxBuffer, so the cap lives in the writer: past the limit the
// bytes are dropped and the fact is kept, which is the provenance the caller reads.
type cappedBuffer struct {
	buf        bytes.Buffer
	limit      int64
	seen       int64
	overflowed bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.limit <= 0 {
		return c.buf.Write(p)
	}
	c.seen += int64(len(p))
	if c.overflowed {
		return len(p), nil
	}
	if c.seen > c.limit {
		c.overflowed = true
		c.buf.Reset()
		return len(p), nil
	}
	return c.buf.Write(p)
}

// DefaultMaxBuffer caps stdout for an ordinary git call, matching the Node and
// Python defaults. Uncapped, a hostile or merely enormous repository could make one
// read grow without bound where the other two SDKs report an operational failure.
const DefaultMaxBuffer int64 = 64 * 1024 * 1024

// RunGit runs git with a fixed, non-interactive environment; argv-array only,
// never a shell. cwd "" runs in the current directory. Callers that legitimately
// read more (the tree listing, a blob) pass their own cap.
func RunGit(args []string, cwd string) GitResult {
	return runGitLimited(args, cwd, DefaultMaxBuffer)
}

// runGitLimited is RunGit with a stdout byte cap (0 = uncapped). Exceeding it is
// an operational failure with Overflowed set, never a truncated success.
func runGitLimited(args []string, cwd string, maxBuffer int64) GitResult {
	cmd := exec.Command("git", append([]string{"--no-replace-objects"}, args...)...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(),
		"LC_ALL=C",
		"GIT_PAGER=cat",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_OPTIONAL_LOCKS=0",
		// A promisor clone used as a hint or submodule would otherwise reach the
		// network from commands documented as offline.
		"GIT_NO_LAZY_FETCH=1",
	)
	stdout := &cappedBuffer{limit: maxBuffer}
	var stderr bytes.Buffer
	cmd.Stdout = stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil && stdout.overflowed {
		return GitResult{OK: false, Stdout: []byte{}, Code: -1, Error: "git output exceeded the byte cap", Overflowed: true}
	}
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if msg == "" {
			msg = "git failed"
		}
		code := -1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		}
		return GitResult{OK: false, Stdout: []byte{}, Code: code, Error: msg, Overflowed: stdout.overflowed}
	}
	return GitResult{OK: true, Stdout: stdout.buf.Bytes(), Code: 0}
}

func isGitRepo(dir string) bool {
	if !fsx.IsDir(dir) {
		return false
	}
	return RunGit([]string{"-C", dir, "rev-parse", "--git-dir"}, "").OK
}

func hasCommit(repo, pin string) bool {
	return RunGit([]string{"-C", repo, "cat-file", "-e", pin + "^{commit}"}, "").OK
}

// revOid resolves a revision to a commit id in repo; "" when it does not resolve.
func revOid(repo, rev string) string {
	r := RunGit([]string{"-C", repo, "rev-parse", "--verify", "--quiet", rev + "^{commit}"}, "")
	if !r.OK {
		return ""
	}
	return strings.TrimSpace(string(r.Stdout))
}

// refOid is the raw object a ref points at, unpeeled; "" when the ref does not exist.
func refOid(repo, ref string) string {
	r := RunGit([]string{"-C", repo, "rev-parse", "--verify", "--quiet", ref}, "")
	if !r.OK {
		return ""
	}
	return strings.TrimSpace(string(r.Stdout))
}

// storeDir is the resolver-managed bare store for a source identity.
func storeDir(root, sourceIdentity string) string {
	return filepath.Join(MountsDir(root), "store", Sha256Hex(sourceIdentity))
}

// Control characters, space, and the glob and revision metacharacters git forbids.
var refMetaRe = regexp.MustCompile(`[\x00-\x20\x7F~^:?*\[\\]`)

// ValidTrackingRef accepts a fully qualified branch or tag that `git
// check-ref-format` would accept: no control characters, whitespace, glob or
// revision metacharacters, no `..`, `@{`, empty or dot-leading component,
// `.lock` suffix, or trailing `/` or `.`.
func ValidTrackingRef(ref string) bool {
	if !strings.HasPrefix(ref, "refs/heads/") && !strings.HasPrefix(ref, "refs/tags/") {
		return false
	}
	if refMetaRe.MatchString(ref) {
		return false
	}
	if strings.Contains(ref, "..") || strings.Contains(ref, "@{") {
		return false
	}
	if strings.HasSuffix(ref, "/") || strings.HasSuffix(ref, ".") {
		return false
	}
	components := strings.Split(ref, "/")
	if len(components) < 3 {
		return false
	}
	for _, c := range components {
		if c == "" || strings.HasPrefix(c, ".") || strings.HasSuffix(c, ".lock") {
			return false
		}
	}
	return true
}

// WitnessRefFor is the managed witness ref for a source and its tracking ref:
// refs/leji-witness/v1/<sha256(identity)>/<sha256(trackingRef)>. Both components
// are fixed-length lowercase hex, so no declaration can outgrow a filesystem's
// per-component limit and no case-insensitive filesystem folds two onto one.
func WitnessRefFor(sourceIdentity, trackingRef string) string {
	return WitnessRefNamespace + "/v1/" + Sha256Hex(sourceIdentity) + "/" + Sha256Hex(trackingRef)
}

// PinRefFor is the ref that retains a pin in the managed store:
// refs/leji-pin/v1/<source-key>/<oid>. A fetch leaves the pin reachable only
// through FETCH_HEAD, which the witness fetch then overwrites — without this ref,
// git maintenance may prune the version of record.
func PinRefFor(sourceIdentity, pinOid string) string {
	return PinRefNamespace + "/v1/" + Sha256Hex(sourceIdentity) + "/" + pinOid
}

var submoduleSectionRe = regexp.MustCompile(`^\s*\[submodule\s+"(.+)"\]\s*$`)
var submodulePathRe = regexp.MustCompile(`^\s*path\s*=\s*(.+?)\s*$`)
var submoduleURLRe = regexp.MustCompile(`^\s*url\s*=\s*(.+?)\s*$`)

// submoduleCandidates discovers host submodules whose .gitmodules URL normalizes
// to the identity.
func submoduleCandidates(root, sourceIdentity string) []string {
	raw, ok := readTextWithin(root, filepath.Join(root, ".gitmodules"))
	if !ok {
		return nil
	}
	var out []string
	currentPath := ""
	hasPath := false
	for _, line := range strings.Split(raw, "\n") {
		if submoduleSectionRe.MatchString(line) {
			currentPath = ""
			hasPath = false
		}
		if pm := submodulePathRe.FindStringSubmatch(line); pm != nil {
			currentPath = pm[1]
			hasPath = true
		}
		if um := submoduleURLRe.FindStringSubmatch(line); um != nil && hasPath {
			if ident, ok := NormalizeSource(um[1]); ok && ident == sourceIdentity {
				out = append(out, filepath.Join(root, currentPath))
			}
		}
	}
	var repos []string
	for _, p := range out {
		if isGitRepo(p) {
			repos = append(repos, p)
		}
	}
	return repos
}

// ObjectSource is the resolved object store for a pin: Repo "" = none found,
// Kind one of hint|store|submodule ("" = none).
type ObjectSource struct {
	Repo      string
	Kind      string
	Ambiguous bool
}

// ObjectSourceCandidates lists every object source holding the pin, in the
// deterministic offline precedence: explicit hint, then the resolver-managed
// store, then a unique matching submodule. Ambiguous submodule matches are
// reported, never ordered around: the flag is about the submodules alone, because
// a caller that walks past the other candidates ends up with repositories it never
// consulted either way. Callers needing a second operand (a witness ref) walk the
// list; callers needing only the pin take the first.
func ObjectSourceCandidates(root string, mount MountDecl, sourceIdentity string) (candidates []ObjectSource, ambiguous bool) {
	hints := ReadHints(root)
	if hint := hints[mount.Name]; hint != "" {
		abs := hint
		if !filepath.IsAbs(hint) {
			abs = filepath.Join(root, hint)
		}
		if isGitRepo(abs) && hasCommit(abs, mount.Pin) {
			candidates = append(candidates, ObjectSource{Repo: abs, Kind: "hint"})
		}
	}
	store := storeDir(root, sourceIdentity)
	if isGitRepo(store) && hasCommit(store, mount.Pin) {
		candidates = append(candidates, ObjectSource{Repo: store, Kind: "store"})
	}
	subs := submoduleCandidates(root, sourceIdentity)
	if len(subs) == 1 && hasCommit(subs[0], mount.Pin) {
		candidates = append(candidates, ObjectSource{Repo: subs[0], Kind: "submodule"})
	}
	return candidates, len(subs) > 1
}

// FindObjectSource is the first object source holding the pin: what hydration
// projects from.
func FindObjectSource(root string, mount MountDecl, sourceIdentity string) ObjectSource {
	candidates, ambiguous := ObjectSourceCandidates(root, mount, sourceIdentity)
	if len(candidates) > 0 {
		return candidates[0]
	}
	return ObjectSource{Ambiguous: ambiguous}
}

// FetchIntoStore fetches the pin and refreshes the managed witness ref in the
// store. This is the only writer of the witness namespace: `status` never
// fetches, so a mount whose pin a hint already resolves still needs its store
// populated here. repo "" means failure, with errMsg saying why (stable,
// Leji-authored text: git stderr never reaches output).
func FetchIntoStore(root string, mount MountDecl, sourceIdentity string) (repo string, witnessRefreshFailed bool, errMsg string, err error) {
	failed := func(msg string) (string, bool, string, error) {
		return "", false, msg, nil
	}
	// The locator becomes argv here: anything option-shaped is refused, never passed.
	if strings.HasPrefix(mount.Source, "-") {
		return failed(`the source locator may not begin with "-"`)
	}
	store := storeDir(root, sourceIdentity)
	if !isGitRepo(store) {
		if err := os.MkdirAll(store, 0o755); err != nil {
			return "", false, "", err
		}
		if !RunGit([]string{"init", "--bare", "-q", store}, "").OK {
			return failed("the managed store could not be initialized")
		}
	}
	// The pin is immutable: a store that already holds it needs no round trip. The
	// declared pin is resolved directly, never read back out of FETCH_HEAD, so the
	// fetch has no reason to write one and races with a concurrent fetch.
	if !hasCommit(store, mount.Pin) {
		fetch := RunGit([]string{
			"-C", store,
			"-c", "fetch.recurseSubmodules=no",
			"fetch", "-q", "--no-write-fetch-head",
			mount.Source, mount.Pin,
		}, "")
		if !fetch.OK {
			return failed("the pin could not be fetched from the source")
		}
	}
	// Retain the pin by a ref of our own: without it, git maintenance may prune the
	// version of record.
	pinOid := revOid(store, mount.Pin)
	if pinOid == "" {
		return failed("fetched, but the pin is not reachable")
	}
	if !RunGit([]string{"-C", store, "update-ref", PinRefFor(sourceIdentity, pinOid), pinOid}, "").OK {
		return failed("the pin could not be retained by a ref in the managed store")
	}
	// The witness refresh is the second half of what `--fetch` was asked to do, so a
	// run that attempts it and does not publish says so on its own terms. Reported
	// only when it was actually attempted: a run that never got this far has already
	// reported the fetch failure that stopped it.
	if mount.TrackingRef != "" && ValidTrackingRef(mount.TrackingRef) {
		if !refreshWitness(store, mount, sourceIdentity) {
			return store, true, "", nil
		}
	}
	return store, false, "", nil
}

// refreshWitness refreshes the managed witness ref: fetch the tracking ref to a
// unique temporary ref, publish it onto the canonical witness with git's own
// compare-and-swap, then drop the temporary. Forced (`+`), so the witness follows
// a non-fast-forward upstream move. No lock: git's ref update is atomic, a lost
// swap means another writer published first (a valid outcome), and a failure
// leaves the previous witness in place.
func refreshWitness(store string, mount MountDecl, sourceIdentity string) bool {
	witnessRef := WitnessRefFor(sourceIdentity, mount.TrackingRef)
	tempRef := fmt.Sprintf("%s/tmp/%d-%s", WitnessRefNamespace, os.Getpid(), randomHex(8))
	spec := "+" + mount.TrackingRef + ":" + tempRef
	fetch := RunGit([]string{"-C", store, "-c", "fetch.recurseSubmodules=no", "fetch", "-q", mount.Source, spec}, "")
	tip := ""
	if fetch.OK {
		tip = refOid(store, tempRef)
	}
	// An empty <oldvalue> is git's "must not exist yet".
	expected := refOid(store, witnessRef)
	published := false
	if tip != "" {
		if RunGit([]string{"-C", store, "update-ref", witnessRef, tip, expected}, "").OK {
			published = true
		} else {
			// A lost compare-and-swap is only a confirmed mismatch on <oldvalue>: another
			// writer published while we fetched, which is a valid outcome. Permission,
			// malformed-ref, lock and disk failures are not lost races, so the ref itself
			// decides — a valid witness present means someone published, anything else is
			// an operational failure that must not read as success.
			published = refOid(store, witnessRef) != "" && refOid(store, witnessRef) != expected
		}
	}
	// Cleanup is not part of the outcome: the canonical ref has already moved, and a
	// surviving temporary is inert (nothing reads the tmp namespace as a witness).
	RunGit([]string{"-C", store, "update-ref", "-d", tempRef}, "")
	return published
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// Uniqueness only scopes a temporary ref; the clock is a sufficient fallback.
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b)
}

type treeEntry struct {
	mode    string
	typ     string
	oid     string
	relPath string
}

// decodeUTF8Replacing decodes bytes as UTF-8, substituting U+FFFD per invalid
// byte, mirroring Node's Buffer#toString('utf8') closely enough for messages.
func decodeUTF8Replacing(b []byte) string {
	var sb strings.Builder
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size == 1 {
			sb.WriteRune(utf8.RuneError)
		} else {
			sb.WriteRune(r)
		}
		b = b[size:]
	}
	return sb.String()
}

// listTree enumerates every entry in the pinned tree once, so selection can
// happen in-process.
//
// Deliberately no pathspec: a declared path is a *name*, and git would read it as
// a glob, so a governed file called `a[b].md` selects `ab.md` and reports itself
// missing. One argv per indexed path also reaches ARG_MAX long before the
// file-count limit does. Both hazards are structural, and both disappear when the
// only thing git is asked for is the tree.
//
// Because the enumeration is the whole repository, nothing here may fail on an
// entry the projection does not select. A path with no UTF-8 form is therefore
// routed by selectsRawPath before it is judged: inside the projection it is the
// safety failure it has always been, outside it is another repository's business.
func listTree(repo, pin string, selectsRawPath func([]byte) bool) ([]treeEntry, string, string) {
	args := []string{"-C", repo, "ls-tree", "-r", "-z", "--full-tree", pin}
	r := runGitLimited(args, "", MaxTreeListingBytes)
	if !r.OK {
		// Transport, not content: the listing did not fit, so nothing can be said
		// about the projection either way.
		if r.Overflowed {
			return nil, "the pinned tree listing exceeds the transport limit", KindSafety
		}
		return nil, "the pinned tree could not be listed", KindSafety
	}
	var entries []treeEntry
	for _, chunk := range bytes.Split(r.Stdout, []byte{0}) {
		if len(chunk) == 0 {
			continue
		}
		tab := bytes.IndexByte(chunk, '\t')
		if tab < 0 {
			continue
		}
		fields := strings.Split(string(chunk[:tab]), " ")
		if len(fields) < 3 {
			continue
		}
		rawPath := chunk[tab+1:]
		if !utf8.Valid(rawPath) {
			// The routing decision needs no decode: the selections compare as bytes.
			if !selectsRawPath(rawPath) {
				continue
			}
			return nil, "non-UTF-8 path in the pinned tree: " + decodeUTF8Replacing(rawPath), KindSafety
		}
		entries = append(entries, treeEntry{mode: fields[0], typ: fields[1], oid: fields[2], relPath: string(rawPath)})
	}
	return entries, "", ""
}

func catBlob(repo, oid string) ([]byte, bool) {
	r := runGitLimited([]string{"-C", repo, "cat-file", "blob", oid}, "", MaxProjectionBytes)
	if !r.OK {
		return nil, false
	}
	return r.Stdout, true
}

func containedRelPath(p string) bool {
	// len is UTF-8 bytes, which is the unit the limit is declared in and the only one
	// the three SDKs can agree on: the Node reference measured UTF-16 code units and
	// Python code points, so one constant was three different thresholds and a path of
	// astral characters crossed them at three different lengths. Never utf8.RuneCount.
	if p == "" || len(p) > MaxProjectionPath {
		return false
	}
	if strings.HasPrefix(p, "/") || strings.Contains(p, "\\") {
		return false
	}
	for _, s := range strings.Split(p, "/") {
		if s == "" || s == "." || s == ".." {
			return false
		}
	}
	return true
}

// declaredFile normalizes a manifest-declared file path ("./docs/x.md") for use as
// a selection; ok is false for an uncontained path.
func declaredFile(p string) (string, bool) {
	s := strings.TrimSpace(p)
	s = strings.TrimPrefix(s, "./")
	if !containedRelPath(s) {
		return "", false
	}
	return s, true
}

// stripTrailingSlashes removes every trailing "/". A resolved symlink target names
// an entry, and an entry's name never ends in a separator; the three runtimes' path
// normalizers disagree about whether one survives.
func stripTrailingSlashes(p string) string {
	for len(p) > 1 && strings.HasSuffix(p, "/") {
		p = p[:len(p)-1]
	}
	return p
}

// joinPosix joins a possibly-empty prefix ("" means repository root) with a name.
func joinPosix(prefix, name string) string {
	if prefix == "" {
		return name
	}
	return prefix + "/" + name
}

// jsonObjectKeyOrder is the authored key order of the object at the given
// top-level key in raw JSON text, or nil when there is no such object.
//
// Go's encoding/json decodes an object into a map, which has no order, and the
// Node reference walks the document's own order. Sorting instead is not a
// deterministic stand-in for it, it is a different traversal, and the difference is
// observable: it decides which declaring artifact a shared missing path is
// attributed to, and, when a sibling carries both a safety-class and an
// availability-class defect, which one is reached first — so the same pinned tree
// exited 1 under Go and 0 under Node and Python. Duplicate keys keep their first
// position, which is where JSON.parse and json.Unmarshal (last value wins) also
// leave them.
func jsonObjectKeyOrder(raw []byte, topLevelKey string) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil
		}
		if key, _ := keyTok.(string); key != topLevelKey {
			if err := skipJSONValue(dec); err != nil {
				return nil
			}
			continue
		}
		if t, err := dec.Token(); err != nil || t != json.Delim('{') {
			return nil
		}
		var keys []string
		seen := map[string]bool{}
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil
			}
			k, _ := kt.(string)
			if !seen[k] {
				seen[k] = true
				keys = append(keys, k)
			}
			if err := skipJSONValue(dec); err != nil {
				return nil
			}
		}
		return keys
	}
	return nil
}

// skipJSONValue consumes exactly one complete JSON value from dec.
func skipJSONValue(dec *json.Decoder) error {
	t, err := dec.Token()
	if err != nil {
		return err
	}
	if t != json.Delim('{') && t != json.Delim('[') {
		return nil
	}
	for depth := 1; depth > 0; {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		switch t {
		case json.Delim('{'), json.Delim('['):
			depth++
		case json.Delim('}'), json.Delim(']'):
			depth--
		}
	}
	return nil
}

// declaredDir normalizes a manifest-declared directory path ("docs/", "./docs")
// to a prefix; ok is false for an uncontained path.
func declaredDir(p string) (string, bool) {
	s := strings.TrimSpace(p)
	s = strings.TrimPrefix(s, "./")
	for strings.HasSuffix(s, "/") {
		s = s[:len(s)-1]
	}
	if s == "" || s == "." {
		return "", true
	}
	if !containedRelPath(s) {
		return "", false
	}
	return s, true
}

// Gitlink is a recorded (never materialized) submodule entry in the pinned tree.
type Gitlink struct {
	Path string
	Oid  string
}

// ProjectionResult mirrors the TS ProjectionResult. Kind is set with Error, never
// without it.
type ProjectionResult struct {
	OK          bool
	Error       string
	Kind        string
	Commit      string
	Tree        string
	Files       int
	Bytes       int64
	Gitlinks    []Gitlink
	SiblingName *string
}

type writeEntry struct {
	relPath string
	oid     string
	mode    os.FileMode
}

type symlinkEntry struct {
	relPath string
	target  string
}

// closureResult is the computed projection closure, or a tagged failure. Kind is
// set with Error, never without it.
type closureResult struct {
	OK          bool
	Error       string
	Kind        string
	Commit      string
	Tree        string
	SiblingName *string
	// Prefixes are the directory prefixes ("." = whole tree): the symlink-containment set.
	Prefixes []string
	// Writes are the blob entries to materialize, deduplicated, path-validated.
	Writes   []writeEntry
	Symlinks []symlinkEntry
	Gitlinks []Gitlink
}

// computeClosure computes the layer-projection closure at a pinned commit: the
// deduplicated union of the root manifest, the rootPath tree, the boot profile,
// the machine artifacts when present, the profiles/decisions trees when present,
// every bound agent profile, every category index, and every governed path in the
// pinned generated index. The sibling's own manifest at the pin defines the
// projection; the host never curates it.
//
// The failure boundary: a referenced or schema-required file absent from the
// pinned tree fails the closure with a code naming the declaring artifact and the
// missing path; an absent directory or an absent defaulted machine artifact
// contributes nothing (git cannot represent an empty directory; a core layer has
// no index). Everything runs against the object store only — no working tree, no
// network.
//
// Every failure is tagged with its class where it is created, so the caller decides
// unavailability from provenance rather than from the sentence it is about to print.
func computeClosure(repo, pin string) closureResult {
	unavailable := func(msg string) closureResult { return closureResult{Error: msg, Kind: KindUnavailable} }
	unsafe := func(msg string) closureResult { return closureResult{Error: msg, Kind: KindSafety} }

	commitR := RunGit([]string{"-C", repo, "rev-parse", pin + "^{commit}"}, "")
	if !commitR.OK {
		return unavailable("pin does not resolve to a commit")
	}
	commit := strings.TrimSpace(string(commitR.Stdout))
	treeR := RunGit([]string{"-C", repo, "rev-parse", pin + "^{tree}"}, "")
	tree := ""
	if treeR.OK {
		tree = strings.TrimSpace(string(treeR.Stdout))
	}

	manifestRaw := RunGit([]string{"-C", repo, "cat-file", "blob", commit + ":leji.json"}, "")
	if !manifestRaw.OK {
		return unavailable("the pinned tree has no leji.json at its root")
	}
	var parsedManifest any
	if err := json.Unmarshal(manifestRaw.Stdout, &parsedManifest); err != nil {
		return unavailable("the pinned leji.json is not valid JSON")
	}
	// A sibling manifest is untrusted input like any other: its strings reach hashing,
	// sorting and path construction, so they clear the same scalar gate as the host's.
	// The gate runs before the shape guard, so a malformed string is reported as the
	// safety failure it is whatever shape carried it.
	if !manifest.AllStringsScalar(manifestRaw.Stdout) {
		return unsafe("the pinned leji.json contains a malformed string")
	}
	sibling, isObject := parsedManifest.(map[string]any)
	if !isObject {
		return unavailable("the pinned leji.json is not an object")
	}
	// A mapping, which is all the guard proves: every field below is still checked
	// for its own type before it is used.
	rootPath, isString := sibling["rootPath"].(string)
	if !isString {
		return unavailable("the pinned leji.json declares no rootPath")
	}
	rootPrefix, contained := declaredDir(rootPath)
	if !contained {
		return unsafe("uncontained rootPath: " + rootPath)
	}

	// Every mapping the closure is about to walk, checked once here rather than at
	// each property access. Absent is normal and contributes nothing; present but
	// not a mapping is an ordinary sibling-shape defect, so it is unavailability.
	var machine map[string]any
	if raw, present := sibling["machine"]; present {
		obj, ok := raw.(map[string]any)
		if !ok {
			return unavailable("the pinned leji.json has no machine object")
		}
		machine = obj
	}
	// One level down, because the declared type is a claim about the host's own
	// manifest and says nothing about pinned bytes. A present non-string here either
	// fails in the path helpers or reads as absent and silently defaults, and a
	// default is not what the sibling declared. Absent is normal.
	for _, field := range []string{"indexPath", "changelogPath", "agentProfilesPath", "decisionRecordsPath"} {
		declared, present := machine[field]
		if !present {
			continue
		}
		if _, ok := declared.(string); !ok {
			return unavailable("the pinned leji.json machine." + field + " is not a string")
		}
	}
	var categories map[string]any
	if raw, present := sibling["categories"]; present {
		obj, ok := raw.(map[string]any)
		if !ok {
			return unavailable("the pinned leji.json has no categories object")
		}
		categories = obj
	}
	var agents map[string]any
	if raw, present := sibling["agents"]; present {
		obj, ok := raw.(map[string]any)
		if !ok {
			return unavailable("the pinned leji.json has no agents object")
		}
		agents = obj
	}

	// Directory selections. Absence contributes nothing: a selection matching no
	// entry is an empty contribution, never a failure.
	var prefixes []string
	prefixSeen := map[string]bool{}
	addPrefix := func(p string) {
		if !prefixSeen[p] {
			prefixSeen[p] = true
			prefixes = append(prefixes, p)
		}
	}
	if rootPrefix == "" {
		addPrefix(".")
	} else {
		addPrefix(rootPrefix)
	}
	for _, what := range []string{"agentProfilesPath", "decisionRecordsPath"} {
		raw, ok := machine[what].(string)
		if !ok {
			continue
		}
		d, contained := declaredDir(raw)
		if !contained {
			return unsafe("uncontained " + what + ": " + raw)
		}
		if d != "" && rootPrefix != "" && !(d == rootPrefix || strings.HasPrefix(d, rootPrefix+"/")) {
			addPrefix(d)
		}
	}

	// File selections. `critical` maps each required path to its declaring artifact;
	// `optional` files are included when present at the pin and owe nothing absent.
	critical := map[string]string{}
	optional := map[string]bool{}
	addCritical := func(raw any, declaring string) *closureResult {
		s, ok := raw.(string)
		if !ok {
			r := unavailable("the pinned leji.json declares no " + declaring)
			return &r
		}
		f, contained := declaredFile(s)
		if !contained {
			r := unsafe("uncontained " + declaring + ": " + s)
			return &r
		}
		if _, exists := critical[f]; !exists {
			critical[f] = declaring
		}
		return nil
	}
	if err := addCritical(sibling["bootProfilePath"], "bootProfilePath"); err != nil {
		return *err
	}
	for _, id := range jsonObjectKeyOrder(manifestRaw.Stdout, "categories") {
		cat, ok := categories[id].(map[string]any)
		if !ok {
			return unavailable("the pinned leji.json categories." + id + " is not an object")
		}
		indexes, present := cat["indexes"]
		if !present {
			continue
		}
		arr, ok := indexes.([]any)
		if !ok {
			return unavailable("the pinned leji.json categories." + id + " has no indexes array")
		}
		for _, idx := range arr {
			if err := addCritical(idx, "categories."+id+" index"); err != nil {
				return *err
			}
		}
	}
	for _, role := range jsonObjectKeyOrder(manifestRaw.Stdout, "agents") {
		if err := addCritical(agents[role], "agents."+role+" profile"); err != nil {
			return *err
		}
	}
	// Machine artifacts: included when present, whether their effective path was
	// declared or defaulted — presence is the criterion, declaration is not.
	indexDeclared := joinPosix(rootPrefix, "context-index.json")
	if s, ok := machine["indexPath"].(string); ok {
		indexDeclared = s
	}
	changelogDeclared := joinPosix(rootPrefix, "context-changelog.json")
	if s, ok := machine["changelogPath"].(string); ok {
		changelogDeclared = s
	}
	var machineFiles []string
	for _, raw := range []string{indexDeclared, changelogDeclared} {
		f, contained := declaredFile(raw)
		if !contained {
			return unsafe("uncontained machine path: " + raw)
		}
		optional[f] = true
		machineFiles = append(machineFiles, f)
	}

	// The canonical schema, not a hand-rolled restatement of it. Each pinned artifact
	// clears its own pointed guards first, because those name the exact field and read
	// better than "does not validate"; the schema is the backstop for what a guard
	// cannot see, a field the schema requires and the closure never dereferences
	// (`leji`, `name`, `owners`, and a `categories` map that is absent rather than
	// misshapen). A pinned artifact missing one is malformed pinned content, which
	// distribution.md classes as availability. Every detail here is stable Leji text,
	// never the validator's error list: three validators phrase and order their
	// messages differently, and the class is what the caller acts on. All of it runs
	// before the tree is enumerated, so nothing schema-invalid is traversed, let alone
	// published. The same pattern repeats for the index and the changelog below.
	if len(schemas.SchemaErrors("context-manifest", parsedManifest)) > 0 {
		return unavailable("the pinned leji.json does not validate against the manifest schema")
	}

	// Content closure: the pinned generated index names the governed paths, which are
	// required wherever they live. Read as JSON from the object store; no new parser.
	indexPath := machineFiles[0]
	indexRaw := RunGit([]string{"-C", repo, "cat-file", "blob", commit + ":" + indexPath}, "")
	if indexRaw.OK {
		var stored any
		if err := json.Unmarshal(indexRaw.Stdout, &stored); err != nil {
			return unavailable("the pinned context index is not valid JSON")
		}
		if !manifest.AllStringsScalar(indexRaw.Stdout) {
			return unsafe("the pinned context index contains a malformed string")
		}
		obj, ok := stored.(map[string]any)
		if !ok {
			return unavailable("the pinned context index is not an object")
		}
		var entries []any
		if raw, present := obj["entries"]; present {
			arr, isArray := raw.([]any)
			if !isArray {
				return unavailable("the pinned context index has no entries array")
			}
			entries = arr
		}
		for _, entry := range entries {
			eo, ok := entry.(map[string]any)
			if !ok {
				return unavailable("the pinned context index entry is not an object")
			}
			if err := addCritical(eo["path"], "context index entry"); err != nil {
				return *err
			}
		}
		if len(schemas.SchemaErrors("context-index", stored)) > 0 {
			return unavailable("the pinned context index does not validate against the index schema")
		}
	}

	// The changelog contributes no path to the closure, so it is read for one reason:
	// it is a pinned machine artifact, and a projection that publishes one which does
	// not validate hands the host malformed content under the schema's name. Absent is
	// normal (a core layer has no changelog) and contributes nothing.
	changelogRaw := RunGit([]string{"-C", repo, "cat-file", "blob", commit + ":" + machineFiles[1]}, "")
	if changelogRaw.OK {
		var storedChangelog any
		if err := json.Unmarshal(changelogRaw.Stdout, &storedChangelog); err != nil {
			return unavailable("the pinned context changelog is not valid JSON")
		}
		if !manifest.AllStringsScalar(changelogRaw.Stdout) {
			return unsafe("the pinned context changelog contains a malformed string")
		}
		if len(schemas.SchemaErrors("context-changelog", storedChangelog)) > 0 {
			return unavailable("the pinned context changelog does not validate against the changelog schema")
		}
	}

	// Selection is a literal comparison against the enumerated tree: a name is
	// matched as a name, and a directory by its prefix. Nothing is handed to git as
	// a pattern, so a path carrying `*`, `?` or `[` selects itself and only itself.
	selected := func(p string) bool {
		if p == "leji.json" || isUnderAny(p, prefixes) {
			return true
		}
		if _, ok := critical[p]; ok {
			return true
		}
		return optional[p]
	}

	// The same selection expressed as bytes, for the one entry kind that cannot be
	// decoded into `selected`'s argument. Every selection came from a JSON string
	// that cleared the scalar gate, so each has a well-defined UTF-8 form; the two
	// predicates must agree, and this one mirrors `selected` term for term.
	selectsEverything := false
	for _, p := range prefixes {
		if p == "." || p == "" {
			selectsEverything = true
		}
	}
	fileBytes := [][]byte{[]byte("leji.json")}
	for f := range critical {
		fileBytes = append(fileBytes, []byte(f))
	}
	for f := range optional {
		fileBytes = append(fileBytes, []byte(f))
	}
	var dirBytes [][]byte
	for _, p := range prefixes {
		if p != "." && p != "" {
			dirBytes = append(dirBytes, []byte(p))
		}
	}
	selectsRawPath := func(raw []byte) bool {
		if selectsEverything {
			return true
		}
		for _, f := range fileBytes {
			if bytes.Equal(raw, f) {
				return true
			}
		}
		for _, d := range dirBytes {
			if bytes.Equal(raw, d) {
				return true
			}
			// 0x2f is "/": the entry sits under the prefix rather than merely sharing
			// its opening bytes.
			if len(raw) > len(d) && raw[len(d)] == 0x2f && bytes.Equal(raw[:len(d)], d) {
				return true
			}
		}
		return false
	}

	listed, listErr, listKind := listTree(repo, commit, selectsRawPath)
	if listErr != "" {
		return closureResult{Error: listErr, Kind: listKind}
	}

	files := 0
	seen := map[string]bool{}
	lowered := map[string]bool{}
	gitlinks := []Gitlink{}
	var symlinks []symlinkEntry
	var writes []writeEntry

	for _, e := range listed {
		// Filtered before any per-entry rule runs: the enumeration is the whole tree,
		// and a case collision or an unsupported mode outside the projection is not
		// this projection's business.
		if !selected(e.relPath) {
			continue
		}
		// Overlapping selections legitimately reach the same entry; the projection is
		// their deduplicated union.
		if seen[e.relPath] {
			continue
		}
		seen[e.relPath] = true
		if !containedRelPath(e.relPath) {
			return unsafe("unsafe path in the pinned tree: " + e.relPath)
		}
		lower := asciiFold(e.relPath)
		if lowered[lower] {
			return unsafe("case collision in the pinned tree: " + e.relPath)
		}
		lowered[lower] = true
		if e.mode == "160000" {
			gitlinks = append(gitlinks, Gitlink{Path: e.relPath, Oid: e.oid})
			continue
		}
		if e.mode == "120000" {
			target, ok := catBlob(repo, e.oid)
			if !ok {
				return unsafe("unreadable symlink " + e.relPath)
			}
			// A target that is not valid UTF-8 is refused rather than decoded. The three
			// runtimes disagree about what decoding even means here (Node substitutes
			// U+FFFD, Python has to be told to, Go carries the raw bytes through), so a
			// decoded target is a different string in each and the containment check
			// below would then be checking three different things. There is no portable
			// form to fall back to, so there is nothing to do but refuse it.
			if !utf8.Valid(target) {
				return unsafe("symlink target is not valid UTF-8 in " + e.relPath)
			}
			// An empty target is malformed pinned content, not a link to anything: the
			// system call that would materialize it fails, and resolving it produced a
			// different answer in each SDK (Python read it as the containing directory,
			// Node and Go as the entry itself). Refused, so all three agree on nothing.
			if len(target) == 0 {
				return unsafe("symlink target is empty in " + e.relPath)
			}
			symlinks = append(symlinks, symlinkEntry{relPath: e.relPath, target: string(target)})
			continue
		}
		if e.typ != "blob" || (e.mode != "100644" && e.mode != "100755") {
			return unsafe("unsupported entry " + e.mode + " " + e.relPath + " in the pinned tree")
		}
		mode := os.FileMode(0o644)
		if e.mode == "100755" {
			mode = 0o755
		}
		writes = append(writes, writeEntry{relPath: e.relPath, oid: e.oid, mode: mode})
		files++
		if files > MaxProjectionFiles {
			return unsafe("projection exceeds the file-count limit")
		}
	}

	// The failure boundary: every closure-critical file resolves at the pin, or the
	// projection fails naming the declaring artifact and the missing path. Symlinked
	// criticals count as present (their targets are containment-checked below).
	//
	// Byte order, not map order: with several criticals missing, the one the failure
	// names has to be the same in every SDK, and a Go map iterates at random.
	present := map[string]bool{}
	for _, w := range writes {
		present[w.relPath] = true
	}
	for _, s := range symlinks {
		present[s.relPath] = true
	}
	criticalPaths := make([]string, 0, len(critical))
	for f := range critical {
		criticalPaths = append(criticalPaths, f)
	}
	// Go's string comparison is UTF-8 byte order: the byteCompare the TS scan uses.
	sort.Strings(criticalPaths)
	for _, f := range criticalPaths {
		if !present[f] {
			return unavailable("closure-critical path missing at the pin: " + critical[f] + " " + f)
		}
	}

	// Symlink targets must stay inside the projection after resolution.
	projected := map[string]bool{}
	for _, w := range writes {
		projected[w.relPath] = true
	}
	for _, s := range symlinks {
		if strings.HasPrefix(s.target, "/") || strings.Contains(s.target, "\\") {
			return unsafe("unsafe symlink target in " + s.relPath)
		}
		// Trailing slashes come off the resolved path before it is compared. An
		// ordinary directory symlink (`ln -s sub/ link`) resolves to `dir/sub/`, which
		// is not a key of any projected path and not a prefix any selection carries, so
		// a conforming sibling was refused for pointing inside itself by the Node and
		// Python ports; path.Join already Cleaned the slash away here, and the explicit
		// strip is what makes all three answer the same. Containment itself is
		// unchanged: an escaping trailing-slash target is still refused, because `..`
		// resolves before this.
		resolved := stripTrailingSlashes(path.Join(path.Dir(s.relPath), s.target))
		if !containedRelPath(resolved) || (!projected[resolved] && !isUnderAny(resolved, prefixes)) {
			return unsafe("symlink " + s.relPath + " escapes the projection")
		}
	}

	result := closureResult{
		OK:       true,
		Commit:   commit,
		Tree:     tree,
		Prefixes: prefixes,
		Writes:   writes,
		Symlinks: symlinks,
		Gitlinks: gitlinks,
	}
	if name, ok := sibling["name"].(string); ok {
		result.SiblingName = &name
	}
	return result
}

// ExtractProjection extracts the layer projection of the pinned sibling into
// destDir: the closure, materialized. Byte limits bind here, where content is
// actually read. The error return carries filesystem failures (which the TS
// reference surfaces as exceptions); projection rejections come back in the
// result's Error, tagged with the class the closure gave them.
func ExtractProjection(repo, pin, destDir string) (ProjectionResult, error) {
	closure := computeClosure(repo, pin)
	if !closure.OK {
		return ProjectionResult{Error: closure.Error, Kind: closure.Kind}, nil
	}

	var totalBytes int64
	for _, w := range closure.Writes {
		blob, ok := catBlob(repo, w.oid)
		if !ok {
			return ProjectionResult{Error: "unreadable blob for " + w.relPath, Kind: KindSafety}, nil
		}
		totalBytes += int64(len(blob))
		if totalBytes > MaxProjectionBytes {
			return ProjectionResult{Error: "projection exceeds the byte limit", Kind: KindSafety}, nil
		}
		abs := filepath.Join(append([]string{destDir}, strings.Split(w.relPath, "/")...)...)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return ProjectionResult{}, err
		}
		if err := os.WriteFile(abs, blob, w.mode); err != nil {
			return ProjectionResult{}, err
		}
	}
	for _, s := range closure.Symlinks {
		abs := filepath.Join(append([]string{destDir}, strings.Split(s.relPath, "/")...)...)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return ProjectionResult{}, err
		}
		if err := os.Symlink(s.target, abs); err != nil {
			return ProjectionResult{}, err
		}
	}

	return ProjectionResult{
		OK:          true,
		Commit:      closure.Commit,
		Tree:        closure.Tree,
		Files:       len(closure.Writes),
		Bytes:       totalBytes,
		Gitlinks:    closure.Gitlinks,
		SiblingName: closure.SiblingName,
	}, nil
}

// SelfProjection is the `leji status` projection section: would this layer, at
// HEAD, project completely if a host mounted it? Enumeration-level (closure
// completeness and per-entry rules against the object store); read-only, offline,
// deterministic. State is "ok", "fail", or "no-commit".
type SelfProjection struct {
	State  string
	Commit string
	Files  int
	Detail string
}

// ComputeSelfProjection judges the layer at HEAD as a mounted sibling would be.
func ComputeSelfProjection(root string) SelfProjection {
	head := RunGit([]string{"-C", root, "rev-parse", "HEAD^{commit}"}, "")
	if !head.OK {
		return SelfProjection{State: "no-commit"}
	}
	commit := strings.TrimSpace(string(head.Stdout))
	closure := computeClosure(root, commit)
	if !closure.OK {
		return SelfProjection{State: "fail", Commit: commit, Detail: closure.Error}
	}
	return SelfProjection{State: "ok", Commit: commit, Files: len(closure.Writes) + len(closure.Symlinks)}
}

// asciiFold is ASCII-only case folding: the portable rule the case-collision check
// uses, and the porting contract for it. `A`-`Z` fold to `a`-`z`; every other code
// point is left exactly as it is.
//
// Deliberately not the runtime's own lowercase mapping. JavaScript's `toLowerCase`,
// Go's `strings.ToLower` and Python's `str.lower` implement different Unicode
// versions with different special cases, so the same pinned tree can collide in one
// SDK and not in another; a shared versioned Unicode table was considered and
// rejected, because pinning a table version is the same problem one layer down. The
// cost is stated rather than hidden: a case-insensitive filesystem that folds
// non-ASCII will still collide on a pair this check passes, so the guard is a
// portable floor, not a claim about any particular filesystem.
//
// Byte-safe in every SDK: no byte of a multi-byte UTF-8 sequence falls in 0x41-0x5A.
func asciiFold(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

func isUnderAny(relPath string, prefixes []string) bool {
	for _, p := range prefixes {
		if p == "." || p == "" {
			return true
		}
		if relPath == p || strings.HasPrefix(relPath, p+"/") {
			return true
		}
	}
	return false
}

// --- Cache publication -------------------------------------------------------
//
// There is no lock over the cache. Git owns object-store and ref concurrency,
// refs publish by compare-and-swap, and the cache is content-addressed, so every
// producer for a key stages byte-identical content. What remains is publishing an
// entry exactly once, which `rename` already decides.

// completeMarker is the publication marker, written *inside* the staged tree
// before it is moved. Publishing the content and its completion evidence in one
// atomic move closes the window where an entry exists without its marker: without
// that, a producer racing a live publisher reads "destination without marker" and
// wrongly calls it poison.
func completeMarker(projection string) string {
	return filepath.Join(projection, "complete")
}

// projectionDir is the published projection for a cache key, marker and all.
func projectionDir(root, key string) string {
	return filepath.Join(MountsDir(root), "cache", key, "projection")
}

// CacheEntryPublished is true when this cache key holds a published entry. The
// directory existing proves nothing; only the marker inside it does.
func CacheEntryPublished(root, key string) bool {
	return fsx.IsFile(completeMarker(projectionDir(root, key)))
}

// destinationExists reports the whole family of errors a rename onto an existing
// non-empty directory produces: POSIX reports ENOTEMPTY or EEXIST, Windows fails
// whenever the destination exists (EPERM or EACCES). The whole set is matched
// rather than one code assumed, so no other failure is read as "destination
// exists" by inference.
func destinationExists(err error) bool {
	return errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, os.ErrExist) || errors.Is(err, os.ErrPermission)
}

// stagingToken makes staging names unique, so two producers never stage into the
// same directory.
func stagingToken() string {
	return fmt.Sprintf("%d-%s", os.Getpid(), randomHex(8))
}

// publishCacheEntry publishes the staged tree as this key's projection.
//
// The sidecar and the marker are written into staging first, so the single rename
// publishes a complete entry or nothing at all. A published projection therefore
// always holds at least the marker and is never empty, which is what makes the
// rename exclusive in practice: POSIX replaces only an *empty* destination
// directory.
//
// Poison, meaning a projection with no marker, is never repaired. Repairing it
// would mean deciding from the outside that no other process is mid-publish, and
// that decision cannot be made without reintroducing the race this protocol
// removes. status is "hydrated" or "cached"; detail is set only on error.
func publishCacheEntry(cacheDir, staging string, metadataJSON []byte) (status, detail string, err error) {
	if err := os.WriteFile(filepath.Join(staging, "metadata.json"), metadataJSON, 0o644); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(completeMarker(staging), nil, 0o644); err != nil {
		return "", "", err
	}
	target := filepath.Join(cacheDir, "projection")
	err = os.Rename(staging, target)
	if err == nil {
		return "hydrated", "", nil
	}
	if rerr := os.RemoveAll(staging); rerr != nil {
		return "", "", rerr
	}
	if !destinationExists(err) {
		return "error", "the projection could not be published into the cache", nil
	}
	if fsx.IsFile(completeMarker(target)) {
		return "cached", "", nil
	}
	return "error", "the cache entry is incomplete and is not repaired automatically", nil
}

func declaredMounts(m *manifest.Manifest) []MountDecl {
	if m.Federation == nil {
		return nil
	}
	out := make([]MountDecl, 0, len(m.Federation.Mounts))
	for _, mt := range m.Federation.Mounts {
		out = append(out, MountDecl{Name: mt.Name, Source: mt.Source, Pin: mt.Pin, TrackingRef: mt.TrackingRef})
	}
	return out
}

// TrackedCacheFiles lists host-git-tracked files under .leji/mounts/ (hydrate
// rejects outright when any exist).
func TrackedCacheFiles(root string) []string {
	r := RunGit([]string{"-C", root, "ls-files", "--", ".leji/mounts"}, "")
	if !r.OK {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(r.Stdout), "\n") {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// HydrateMounts materializes every declared (or named) mount. The error return
// carries filesystem failures (TS exceptions); everything else is an outcome or
// the fatal refusal.
func HydrateMounts(root string, m *manifest.Manifest, opts HydrateOptions) (HydrateResult, error) {
	tracked := TrackedCacheFiles(root)
	if len(tracked) > 0 {
		return HydrateResult{Fatal: fmt.Sprintf("git-tracked files under .leji/mounts/ (%s); the cache is never committed", tracked[0])}, nil
	}
	var mounts []MountDecl
	for _, mount := range declaredMounts(m) {
		if opts.Names != nil && !contains(opts.Names, mount.Name) {
			continue
		}
		mounts = append(mounts, mount)
	}
	var outcomes []HydrateOutcome
	for _, mount := range mounts {
		identity, idOK := NormalizeSource(mount.Source)
		// Details never echo a declaration back: a source may be a local path, and
		// canonical output carries no filesystem paths. The mount name locates it.
		if !idOK {
			outcomes = append(outcomes, HydrateOutcome{
				Name:   mount.Name,
				Status: "error",
				Detail: "source is not a normalizable locator",
			})
			continue
		}
		if mount.TrackingRef != "" && !ValidTrackingRef(mount.TrackingRef) {
			outcomes = append(outcomes, HydrateOutcome{
				Name:   mount.Name,
				Status: "error",
				Detail: "trackingRef is not a fully qualified branch or tag",
			})
			continue
		}
		// --fetch populates the store for every declared mount, cached or already
		// resolvable: the store is the only witness namespace the resolver owns,
		// and `status` never fetches.
		fetchedErr := ""
		witnessRefreshFailed := false
		var storeFetched *bool
		if opts.Fetch {
			repo, refreshFailed, msg, ferr := FetchIntoStore(root, mount, identity)
			if ferr != nil {
				return HydrateResult{}, ferr
			}
			witnessRefreshFailed, fetchedErr = refreshFailed, msg
			established := repo != ""
			storeFetched = &established
		}
		// A requested fetch that did not establish the store is reported on its own
		// terms, whatever the projection then manages from a hint or the cache.
		outcome := func(o HydrateOutcome) HydrateOutcome {
			o.StoreFetched = storeFetched
			o.WitnessRefreshFailed = witnessRefreshFailed
			return o
		}
		key := CacheKeyFor(identity, mount.Pin)
		cacheDir := filepath.Join(MountsDir(root), "cache", key)
		if CacheEntryPublished(root, key) {
			outcomes = append(outcomes, outcome(HydrateOutcome{Name: mount.Name, Status: "cached", CacheKey: key}))
			continue
		}
		src := FindObjectSource(root, mount, identity)
		if src.Ambiguous {
			outcomes = append(outcomes, outcome(HydrateOutcome{
				Name:   mount.Name,
				Status: "error",
				Detail: "more than one submodule matches the source; declare an explicit hint in .leji/mounts.local.json",
			}))
			continue
		}
		if src.Repo == "" {
			detail := "no reachable object store holds the pin (declare a hint, or pass --fetch)"
			if fetchedErr != "" {
				detail = fetchedErr
			}
			outcomes = append(outcomes, outcome(HydrateOutcome{
				Name:   mount.Name,
				Status: "unavailable",
				Detail: detail,
			}))
			continue
		}
		// Staged inside the entry's own directory, so publication is a rename on one
		// filesystem, and under a per-process name, so no two producers collide.
		staging := filepath.Join(cacheDir, ".staging-"+stagingToken())
		if err := os.MkdirAll(staging, 0o755); err != nil {
			return HydrateResult{}, err
		}
		projected, err := ExtractProjection(src.Repo, mount.Pin, staging)
		if err != nil {
			return HydrateResult{}, err
		}
		if !projected.OK {
			if err := os.RemoveAll(staging); err != nil {
				return HydrateResult{}, err
			}
			// The class the failure was tagged with at its own site decides this, never
			// the detail text: a pinned layer that is absent or malformed leaves the
			// mount unavailable (hydrate is best-effort), while a safety guard the
			// projection refused to cross is an error the run fails on.
			status := "error"
			if projected.Kind == KindUnavailable {
				status = "unavailable"
			}
			outcomes = append(outcomes, outcome(HydrateOutcome{
				Name:             mount.Name,
				Status:           status,
				Detail:           projected.Error,
				ProjectionFailed: true,
			}))
			continue
		}
		hostManifestRaw, _ := readTextWithin(root, filepath.Join(root, "leji.json"))
		metadata := newOrdered()
		metadata.set("name", mount.Name)
		metadata.set("sourceIdentity", identity)
		metadata.set("pin", mount.Pin)
		metadata.set("commit", projected.Commit)
		metadata.set("tree", projected.Tree)
		metadata.set("cacheFormatVersion", CacheFormatVersion)
		metadata.set("resolverVersion", "leji-sdk")
		metadata.set("manifestDigest", Sha256Hex(hostManifestRaw))
		metadata.set("files", projected.Files)
		metadata.set("bytes", projected.Bytes)
		gitlinksArr := make([]any, 0, len(projected.Gitlinks))
		for _, g := range projected.Gitlinks {
			gl := newOrdered()
			gl.set("path", g.Path)
			gl.set("oid", g.Oid)
			gitlinksArr = append(gitlinksArr, gl)
		}
		metadata.set("gitlinks", gitlinksArr)
		if projected.SiblingName != nil {
			metadata.set("siblingName", *projected.SiblingName)
		} else {
			metadata.set("siblingName", nil)
		}
		metadata.set("completionState", "complete")
		metadata.set("hydratedAt", nowISO())
		var buf bytes.Buffer
		metadata.encodeIndent(&buf, "", "  ")
		buf.WriteByte('\n')
		// The whole tree is extracted and validated before it is publishable.
		status, detail, perr := publishCacheEntry(cacheDir, staging, buf.Bytes())
		if perr != nil {
			return HydrateResult{}, perr
		}
		if status == "error" {
			outcomes = append(outcomes, outcome(HydrateOutcome{Name: mount.Name, Status: "error", Detail: detail}))
			continue
		}
		published := HydrateOutcome{Name: mount.Name, Status: status, CacheKey: key}
		if status == "hydrated" {
			published.ObjectSource = src.Kind
		}
		outcomes = append(outcomes, outcome(published))
	}
	// Nothing is recorded: a mount's cache key is derivable from its declaration, and
	// whether it is hydrated is the marker on disk. A state file would only be a second
	// copy of both, and one that two concurrent partial runs can each drop entries from.
	return HydrateResult{Outcomes: outcomes}, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// VerifyProjection verifies a cached projection against a reachable object
// store: every projected file's bytes and mode against the pinned tree. Returns
// nil when no object store is reachable (unverifiable), true/false otherwise.
// The error return carries filesystem failures (TS exceptions).
func VerifyProjection(root string, mount MountDecl) (*bool, error) {
	f := false
	identity, idOK := NormalizeSource(mount.Source)
	if !idOK {
		return &f, nil
	}
	key := CacheKeyFor(identity, mount.Pin)
	if !CacheEntryPublished(root, key) {
		return &f, nil
	}
	projDir := projectionDir(root, key)
	src := FindObjectSource(root, mount, identity)
	if src.Repo == "" {
		return nil, nil
	}
	commitR := RunGit([]string{"-C", src.Repo, "rev-parse", mount.Pin + "^{commit}"}, "")
	if !commitR.OK {
		return nil, nil
	}
	commit := strings.TrimSpace(string(commitR.Stdout))
	staging := filepath.Join(MountsDir(root), fmt.Sprintf("verify-%d", os.Getpid()))
	if err := os.RemoveAll(staging); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	projected, err := ExtractProjection(src.Repo, commit, staging)
	if err != nil {
		return nil, err
	}
	if !projected.OK {
		return &f, nil
	}
	// The published entry carries two resolver files the pinned tree does not: the
	// completion marker and the sidecar. Staging them too keeps the comparison a
	// comparison of sibling content, rather than one that always finds two extras.
	if err := os.WriteFile(completeMarker(staging), nil, 0o644); err != nil {
		return nil, err
	}
	sidecar, err := os.ReadFile(filepath.Join(projDir, "metadata.json"))
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(staging, "metadata.json"), sidecar, 0o644); err != nil {
		return nil, err
	}
	eq, err := treesEqual(staging, projDir)
	if err != nil {
		return nil, err
	}
	return &eq, nil
}

func treesEqual(a, b string) (bool, error) {
	listA, err := walkAll(a, "")
	if err != nil {
		return false, err
	}
	listB, err := walkAll(b, "")
	if err != nil {
		return false, err
	}
	sort.Strings(listA)
	sort.Strings(listB)
	if len(listA) != len(listB) {
		return false, nil
	}
	for i := range listA {
		if listA[i] != listB[i] {
			return false, nil
		}
	}
	for _, rel := range listA {
		fa := filepath.Join(a, filepath.FromSlash(rel))
		fb := filepath.Join(b, filepath.FromSlash(rel))
		sa, err := os.Lstat(fa)
		if err != nil {
			return false, err
		}
		sb, err := os.Lstat(fb)
		if err != nil {
			return false, err
		}
		aLink := sa.Mode()&os.ModeSymlink != 0
		bLink := sb.Mode()&os.ModeSymlink != 0
		if aLink != bLink {
			return false, nil
		}
		if aLink {
			// Bytes, not a lossily decoded string: os.Readlink hands back the target's
			// raw bytes in a Go string, so this comparison is already byte-exact. The
			// Node port compared decoded strings, where two targets differing in bytes
			// both decode through U+FFFD and a tampered link verified.
			ta, err := os.Readlink(fa)
			if err != nil {
				return false, err
			}
			tb, err := os.Readlink(fb)
			if err != nil {
				return false, err
			}
			if ta != tb {
				return false, nil
			}
			continue
		}
		if sa.Mode().Perm() != sb.Mode().Perm() {
			return false, nil
		}
		ba, err := os.ReadFile(fa)
		if err != nil {
			return false, err
		}
		bb, err := os.ReadFile(fb)
		if err != nil {
			return false, err
		}
		if !bytes.Equal(ba, bb) {
			return false, nil
		}
	}
	return true, nil
}

func walkAll(dir, prefix string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	var out []string
	for _, name := range names {
		abs := filepath.Join(dir, name)
		rel := name
		if prefix != "" {
			rel = prefix + "/" + name
		}
		st, err := os.Lstat(abs)
		if err != nil {
			return nil, err
		}
		if st.IsDir() {
			sub, err := walkAll(abs, rel)
			if err != nil {
				return nil, err
			}
			out = append(out, sub...)
		} else {
			out = append(out, rel)
		}
	}
	return out, nil
}

// LocateMount resolves a declared mount's hydrated projection: the cache key is
// derived from the declaration, and the published marker decides presence. The
// error return carries filesystem failures (TS exceptions).
func LocateMount(root string, m *manifest.Manifest, name string) (LocateResult, error) {
	var mount *MountDecl
	for _, mt := range declaredMounts(m) {
		if mt.Name == name {
			cp := mt
			mount = &cp
			break
		}
	}
	if mount == nil {
		return LocateResult{
			Name:   name,
			Detail: "no mount with this name is declared",
		}, nil
	}
	identity, idOK := NormalizeSource(mount.Source)
	if !idOK {
		pin := mount.Pin
		return LocateResult{
			Name:   name,
			Pin:    &pin,
			Detail: "source is not a normalizable locator",
		}, nil
	}
	key := CacheKeyFor(identity, mount.Pin)
	projDir := projectionDir(root, key)
	present := CacheEntryPublished(root, key)
	verified := false
	if present {
		v, err := VerifyProjection(root, *mount)
		if err != nil {
			return LocateResult{}, err
		}
		verified = v != nil && *v
	}
	pin := mount.Pin
	result := LocateResult{
		Name:           name,
		SourceIdentity: &identity,
		Pin:            &pin,
		Present:        present,
		Verified:       verified,
	}
	if present {
		result.Path = &projDir
	}
	if present && !verified {
		result.Detail = "projection present but not verified against a reachable object store"
	}
	return result, nil
}

// MountStatus reports every declared mount's pin against its witness, offline.
// Comparison is the availability matrix: the resolver's own witness in the
// managed store first, then any object source that holds both the pin and the
// tracking ref. The pin and the witness always come from the same repository,
// and nothing here fetches. The error return carries filesystem failures (TS
// exceptions).
func MountStatus(root string, m *manifest.Manifest, opts StatusOptions) ([]StatusResult, error) {
	// One observation time for the whole execution, injectable so tests are stable.
	observedAt := nowISO()
	if !opts.Now.IsZero() {
		observedAt = opts.Now.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	declared := declaredMounts(m)
	sorted := make([]MountDecl, len(declared))
	copy(sorted, declared)
	// Go's string comparison is UTF-8 byte order: the one comparator every ordered
	// canonical surface uses across the three SDKs.
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	var out []StatusResult
	for _, mount := range sorted {
		identity, idOK := NormalizeSource(mount.Source)
		var identityPtr *string
		if idOK {
			id := identity
			identityPtr = &id
		}
		var trackingRefPtr *string
		if mount.TrackingRef != "" {
			tr := mount.TrackingRef
			trackingRefPtr = &tr
		}
		present := idOK && CacheEntryPublished(root, CacheKeyFor(identity, mount.Pin))
		var verified *bool
		if opts.CheckIntegrity && present {
			v, err := VerifyProjection(root, mount)
			if err != nil {
				return nil, err
			}
			verified = v
		}
		base := StatusResult{
			Name:           mount.Name,
			SourceIdentity: identityPtr,
			Pin:            mount.Pin,
			TrackingRef:    trackingRefPtr,
			Present:        present,
			Verified:       verified,
		}
		unknown := func(reason string, comparisonRepository, witnessProvenance *string) StatusResult {
			r := base
			r.PinReport = PinReport{
				State:                "unknown",
				ComparedRef:          trackingRefPtr,
				ComparisonRepository: comparisonRepository,
				WitnessProvenance:    witnessProvenance,
				AncestryComplete:     false,
				Reason:               reason,
				ObservedAt:           observedAt,
			}
			return r
		}
		if !idOK {
			out = append(out, unknown("mount-source-unnormalizable", nil, nil))
			continue
		}
		if mount.TrackingRef == "" {
			out = append(out, unknown("mount-no-tracking-ref", nil, nil))
			continue
		}
		if !ValidTrackingRef(mount.TrackingRef) {
			out = append(out, unknown("mount-tracking-ref-invalid", nil, nil))
			continue
		}
		// Row 1: the managed store holds the pin and the resolver's own witness.
		store := storeDir(root, identity)
		managedTip := ""
		if isGitRepo(store) && hasCommit(store, mount.Pin) {
			managedTip = revOid(store, WitnessRefFor(identity, mount.TrackingRef))
		}
		// Row 2: the first pin-holding source that also resolves the ref itself. A
		// candidate holding only the pin is passed over, never allowed to mask a
		// later one holding both.
		var candidates []ObjectSource
		ambiguous := false
		if managedTip == "" {
			candidates, ambiguous = ObjectSourceCandidates(root, mount, identity)
		}
		selectedRepo, selectedKind, tipOid := "", "", ""
		if managedTip != "" {
			selectedRepo, selectedKind, tipOid = store, "store", managedTip
		}
		for _, candidate := range candidates {
			if tip := revOid(candidate.Repo, mount.TrackingRef); tip != "" {
				selectedRepo, selectedKind, tipOid = candidate.Repo, candidate.Kind, tip
				break
			}
		}
		if selectedRepo == "" {
			// Ambiguity is its own answer: those repositories were never consulted,
			// so reporting the pin unavailable would claim more than was checked.
			reason := "mount-witness-unavailable"
			if ambiguous {
				reason = "mount-source-ambiguous"
			} else if len(candidates) == 0 {
				reason = "mount-pin-unavailable"
			}
			out = append(out, unknown(reason, nil, nil))
			continue
		}
		comparisonRepository := selectedKind
		if selectedKind == "store" {
			comparisonRepository = "managed-store"
		}
		witnessProvenance := "unmanaged"
		if managedTip != "" {
			witnessProvenance = "managed"
		}
		cr, wp := comparisonRepository, witnessProvenance
		behind, behindOK := countRange(selectedRepo, mount.Pin, tipOid)
		ahead, aheadOK := countRange(selectedRepo, tipOid, mount.Pin)
		if !behindOK || !aheadOK {
			out = append(out, unknown("mount-ancestry-incomplete", &cr, &wp))
			continue
		}
		shallow := RunGit([]string{"-C", selectedRepo, "rev-parse", "--is-shallow-repository"}, "")
		ancestryComplete := shallow.OK && strings.TrimSpace(string(shallow.Stdout)) == "false"
		// Both counts positive is either divergence or two unrelated histories, and
		// only a merge base tells them apart. Exit 1 is the answer "no merge base";
		// any other failure is the repository unable to answer, never an answer.
		// Truncated history can also lose a merge base that exists, so `unrelated`
		// is a claim only complete ancestry makes.
		disjoint := false
		if behind > 0 && ahead > 0 {
			mergeBase := RunGit([]string{"-C", selectedRepo, "merge-base", mount.Pin, tipOid}, "")
			if !mergeBase.OK && mergeBase.Code != 1 {
				out = append(out, unknown("mount-ancestry-incomplete", &cr, &wp))
				continue
			}
			disjoint = !mergeBase.OK
			if disjoint && !ancestryComplete {
				out = append(out, unknown("mount-ancestry-incomplete", &cr, &wp))
				continue
			}
		}
		state := "ahead"
		switch {
		case behind == 0 && ahead == 0:
			state = "up-to-date"
		case behind > 0 && ahead > 0:
			state = "diverged"
			if disjoint {
				state = "unrelated"
			}
		case behind > 0:
			state = "behind"
		}
		row := base
		b, a := behind, ahead
		row.PinReport = PinReport{
			State:                state,
			Behind:               &b,
			Ahead:                &a,
			ComparedRef:          trackingRefPtr,
			ComparisonRepository: &cr,
			WitnessProvenance:    &wp,
			AncestryComplete:     ancestryComplete,
			ObservedAt:           observedAt,
		}
		out = append(out, row)
	}
	return out, nil
}

// countRange counts commits in from..to; ok is false when the range cannot be
// counted (missing objects).
func countRange(repo, from, to string) (int, bool) {
	r := RunGit([]string{"-C", repo, "rev-list", "--count", from + ".." + to}, "")
	if !r.OK {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(r.Stdout)))
	if err != nil {
		return 0, false
	}
	return n, true
}

// ReachabilityResult mirrors the TS ReachabilityResult (nil WitnessRef = null,
// Detail "" = absent).
type ReachabilityResult struct {
	State      string // reachable | unreachable | unknown
	WitnessRef *string
	Detail     string
}

var headSymrefRe = regexp.MustCompile(`(?m)^ref:\s+(\S+)\s+HEAD`)

// CheckPinReachability is the networked conformance probe: is the pin reachable
// from an advertised ref of the source? Advertisement comes from `git ls-remote`
// against the declared source (never a hint: hint-only resolution is
// availability, not conformance). The witness is TrackingRef, or the source's
// advertised HEAD symref when absent. Ancestry is then established by fetching
// the witness ref into the resolver store. Any failure to reach the source
// reports `unknown`, never a guess. The error return carries filesystem
// failures (TS exceptions).
func CheckPinReachability(root string, mount MountDecl) (ReachabilityResult, error) {
	identity, idOK := NormalizeSource(mount.Source)
	if !idOK {
		return ReachabilityResult{State: "unknown", Detail: "source is not a normalizable locator"}, nil
	}
	// Resolve the witness ref: declared, or the source's advertised default branch.
	witnessRef := mount.TrackingRef
	if witnessRef == "" {
		head := RunGit([]string{"ls-remote", "--symref", mount.Source, "HEAD"}, "")
		if !head.OK {
			return ReachabilityResult{State: "unknown", Detail: "the source could not be reached"}, nil
		}
		m := headSymrefRe.FindStringSubmatch(string(head.Stdout))
		if m == nil {
			return ReachabilityResult{State: "unknown", Detail: "source advertises no HEAD symref"}, nil
		}
		witnessRef = m[1]
	}
	adv := RunGit([]string{"ls-remote", mount.Source, witnessRef}, "")
	if !adv.OK {
		return ReachabilityResult{State: "unknown", WitnessRef: &witnessRef, Detail: "the source could not be reached"}, nil
	}
	line := strings.TrimSpace(string(adv.Stdout))
	if line == "" {
		return ReachabilityResult{State: "unreachable", WitnessRef: &witnessRef, Detail: "source does not advertise " + witnessRef}, nil
	}
	tip := strings.Split(line, "\t")[0]
	// Establish ancestry in the resolver store: fetch the witness ref (full history,
	// no promisor state), then ask whether the pin is an ancestor of its tip.
	store := filepath.Join(MountsDir(root), "store", Sha256Hex(identity))
	if !isGitRepo(store) {
		if err := os.MkdirAll(store, 0o755); err != nil {
			return ReachabilityResult{}, err
		}
		init := RunGit([]string{"init", "--bare", "-q", store}, "")
		if !init.OK {
			return ReachabilityResult{State: "unknown", WitnessRef: &witnessRef, Detail: "the managed store could not be initialized"}, nil
		}
	}
	fetch := RunGit([]string{"-C", store, "-c", "fetch.recurseSubmodules=no", "fetch", "-q", mount.Source, witnessRef}, "")
	if !fetch.OK {
		return ReachabilityResult{State: "unknown", WitnessRef: &witnessRef, Detail: "the witness ref could not be fetched from the source"}, nil
	}
	anc := RunGit([]string{"-C", store, "merge-base", "--is-ancestor", mount.Pin, tip}, "")
	if anc.OK {
		return ReachabilityResult{State: "reachable", WitnessRef: &witnessRef}, nil
	}
	// is-ancestor distinguishes "no" (exit 1) from "cannot answer" (missing objects).
	if !hasCommit(store, mount.Pin) {
		return ReachabilityResult{State: "unreachable", WitnessRef: &witnessRef, Detail: "the pin is not in the history advertised by the source"}, nil
	}
	return ReachabilityResult{State: "unreachable", WitnessRef: &witnessRef, Detail: "the pin is not an ancestor of " + witnessRef}, nil
}

// EnforcementFinding mirrors the TS EnforcementFinding (Severity always "error").
type EnforcementFinding struct {
	Rule     string
	Severity string
	Message  string
	Path     string
}

// FederationEnforcement is the opt-in federation enforcement for
// `leji validate --federation=<mode>`. `available`: every cleanly declared mount
// must be hydrated AND verified against a reachable object store (a restored or
// unverifiable cache is not evidence). `required`: only mounts the given task
// paths route to (category overlap, the routing algorithm's machine-decidable
// signal) must be available; `requiredWhen` stays the agent's judgment. Never
// mutates; run `mounts hydrate` first. A nil taskMountNames mirrors the TS null.
// The error return carries filesystem failures (TS exceptions).
func FederationEnforcement(root string, m *manifest.Manifest, mode string, taskMountNames map[string]bool) ([]EnforcementFinding, error) {
	var out []EnforcementFinding
	for _, mount := range declaredMounts(m) {
		if mode == "required" && (taskMountNames == nil || !taskMountNames[mount.Name]) {
			continue
		}
		identity, idOK := NormalizeSource(mount.Source)
		if !idOK {
			continue // declaration errors are ordinary validation's
		}
		if !CacheEntryPublished(root, CacheKeyFor(identity, mount.Pin)) {
			requiredBy := "by --federation=available"
			if mode == "required" {
				requiredBy = "by this task"
			}
			out = append(out, EnforcementFinding{
				Rule:     "mount-enforcement",
				Severity: "error",
				Message:  "mount \"" + mount.Name + "\" is required " + requiredBy + " but is not hydrated; run `leji mounts hydrate`",
				Path:     mount.Name,
			})
			continue
		}
		verified, err := VerifyProjection(root, mount)
		if err != nil {
			return nil, err
		}
		if verified == nil || !*verified {
			message := "mount \"" + mount.Name + "\" projection cannot be verified (no reachable object store); an unverified cache is not evidence"
			if verified != nil {
				message = "mount \"" + mount.Name + "\" projection does not match its pin; re-run `leji mounts hydrate`"
			}
			out = append(out, EnforcementFinding{
				Rule:     "mount-enforcement",
				Severity: "error",
				Message:  message,
				Path:     mount.Name,
			})
		}
	}
	return out, nil
}

// ProjectionDir resolves a mount's hydrated projection directory, or "" when it
// is not materialized here. The cache key is derived from the declaration itself,
// so there is no state file to read and nothing to fall out of step with the
// manifest; a projection counts only when it carries its completion marker, since
// a directory without one is an entry that was never published.
func ProjectionDir(root, source, pin string) string {
	identity, ok := NormalizeSource(source)
	if !ok {
		return ""
	}
	key := CacheKeyFor(identity, pin)
	if !CacheEntryPublished(root, key) {
		return ""
	}
	return projectionDir(root, key)
}
