// Package cli parses flags, dispatches commands, and emits results. Mirrors
// index.ts: same flags, per-command extra fields, and exit codes.
package cli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/changelog"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	detectcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/freshness"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/status"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/viewer"
	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/git"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
	"github.com/leji-org/leji/packages/sdk-go/internal/layer"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/mounts"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
	"github.com/leji-org/leji/packages/sdk-go/internal/writeplan"
)

type flags struct {
	root         string
	json         bool
	check        bool
	strict       bool
	yes          bool
	open         bool
	content      bool
	dryRun       bool
	wireAdapters bool
	noAgents     bool
	hooks        bool
	explain      bool
	fetch        bool
	checkIntegr  bool
	help         bool
	version      bool
	port         *int
	dir          string
	level        string
	mode         string
	name         string
	hasName      bool
	agent        string
	host         string
	role         string
	out          string
	hasOut       bool
	keep         int
	hasKeep      bool
	before       string
	hasBefore    bool
	provider     string
	paths        string
	categories   string
	// topics is repeatable: one whole topic per occurrence, accumulated in order.
	topics     []string
	asOf       string
	federation string
	hostArgs   []string
}

// quoteTopic renders s the way Node's JSON.stringify(s) does. jsonenc covers the
// ordinary escapes; a lone surrogate — the only reason this message is ever
// printed — arrives as its three-byte WTF-8 encoding, which jsonenc would decode
// to U+FFFD, so it is emitted here as the `\udXXX` escape a well-formed
// JSON.stringify writes.
func quoteTopic(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); {
		if s[i] == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 && s[i+1] <= 0xBF && s[i+2] >= 0x80 && s[i+2] <= 0xBF {
			fmt.Fprintf(&b, "\\u%04x", 0xD000|(int(s[i+1]&0x3F)<<6)|int(s[i+2]&0x3F))
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		enc, _ := jsonenc.Marshal(string(r))
		b.Write(enc[1 : len(enc)-1])
		i += size
	}
	b.WriteByte('"')
	return b.String()
}

// shortCommit truncates a commit id the way the TS reference's slice(0, 12) does:
// by UTF-16 code units, which for a hex object id is the same as bytes.
func shortCommit(commit string) string {
	if len(commit) <= 12 {
		return commit
	}
	return commit[:12]
}

// isFlagToken reports whether a token is itself a flag (not a bare "-") and so
// cannot be a value: `--root --json` is a missing value, not root="--json".
func isFlagToken(v string, ok bool) bool {
	return ok && v != "-" && strings.HasPrefix(v, "-")
}

// keepMax is the largest `--keep`, chosen so all three SDKs carry the value
// identically: above it strconv.Atoi overflows while Node's Number() and
// Python's int() keep going, and no changelog has 2^31 entries.
const keepMax = 2147483647

// expandEqualsFlags expands `--flag=value` into `--flag value` for declared
// value flags, so both spellings work (`--federation=available` and
// `--federation available`). Tokens after a literal `--` are host pass-through
// and stay untouched.
func expandEqualsFlags(argv []string) []string {
	out := make([]string, 0, len(argv))
	passthrough := false
	for _, a := range argv {
		if a == "--" {
			passthrough = true
		}
		eq := -1
		if !passthrough && strings.HasPrefix(a, "--") {
			eq = strings.Index(a, "=")
		}
		if eq > 2 && valueFlags[a[:eq]] {
			out = append(out, a[:eq], a[eq+1:])
		} else {
			out = append(out, a)
		}
	}
	return out
}

func parseFlags(argv []string) (flags, []string, string) {
	argv = expandEqualsFlags(argv)
	f := flags{root: ".", dir: "."}
	var rest []string
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch arg {
		case "--hooks":
			f.hooks = true
		case "--":
			// Everything after a literal -- passes verbatim to the launched host.
			// Only `start` declares `--` in cli.json, and the per-command flag check
			// rejects it anywhere else: a swallowed `leji validate -- --bogus` exited
			// 0, so a typo'd flag reported success on a validation command.
			f.hostArgs = argv[i+1:]
			i = len(argv)
		case "--root":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--root requires a value"
			}
			f.root = v
		case "--dir":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--dir requires a value"
			}
			f.dir = v
		case "--level":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--level requires a value"
			}
			if v != "core" && v != "indexed" {
				return f, rest, "--level must be core or indexed"
			}
			f.level = v
		case "--mode":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--mode requires a value"
			}
			if v != "solo" && v != "team" {
				return f, rest, "--mode must be solo or team"
			}
			f.mode = v
		case "--name":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--name requires a value"
			}
			f.name = v
			f.hasName = true
		case "--agent":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--agent requires a value"
			}
			f.agent = v
		case "--host":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--host requires a value"
			}
			f.host = v
		case "--role":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--role requires a value"
			}
			f.role = v
		case "--out":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--out requires a value"
			}
			f.out = v
			f.hasOut = true
		case "--keep":
			i++
			raw, ok := "", i < len(argv)
			if ok {
				raw = argv[i]
			}
			if raw == "" || isFlagToken(raw, ok) {
				return f, rest, "--keep requires a value"
			}
			v, err := strconv.Atoi(raw)
			if err != nil || v < 1 || v > keepMax {
				return f, rest, "--keep must be a positive integer"
			}
			f.keep = v
			f.hasKeep = true
		case "--before":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--before requires a value"
			}
			f.before = v
			f.hasBefore = true
		case "--provider":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--provider requires a value"
			}
			f.provider = v
		case "--paths":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--paths requires a value"
			}
			f.paths = v
		case "--categories":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--categories requires a value"
			}
			f.categories = v
		// Repeatable and never comma-split: a topic is free text, so a comma inside
		// one would be unrepresentable under the --paths/--categories list form. An
		// empty occurrence is kept here and rejected by the command, so the caller
		// gets the topic-shaped message rather than a bare usage dump.
		case "--topics":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if !ok || isFlagToken(v, ok) {
				return f, rest, "--topics requires a value"
			}
			f.topics = append(f.topics, v)
		case "--as-of":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--as-of requires a value"
			}
			f.asOf = v
		case "--open":
			f.open = true
		case "--fetch":
			f.fetch = true
		case "--federation":
			i++
			v, ok := "", i < len(argv)
			if ok {
				v = argv[i]
			}
			if v == "" || isFlagToken(v, ok) {
				return f, rest, "--federation requires a value"
			}
			f.federation = v
		case "--check-integrity":
			f.checkIntegr = true
		case "--port":
			i++
			raw, ok := "", i < len(argv)
			if ok {
				raw = argv[i]
			}
			if raw == "" || isFlagToken(raw, ok) {
				return f, rest, "--port requires a value"
			}
			v, err := strconv.Atoi(raw)
			if err != nil || v < 0 || v > 65535 {
				return f, rest, "--port must be 0-65535"
			}
			f.port = &v
		case "--json":
			f.json = true
		case "--check":
			f.check = true
		case "--content":
			f.content = true
		case "--dry-run":
			f.dryRun = true
		case "--wire-adapters":
			f.wireAdapters = true
		case "--no-agents":
			f.noAgents = true
		case "--explain":
			f.explain = true
		case "--strict":
			f.strict = true
		case "--yes", "-y":
			f.yes = true
		case "-h", "--help":
			f.help = true
		// No -V: there is no --verbose flag, so the GNU "-v means verbose"
		// convention does not apply.
		case "-v", "--version":
			f.version = true
		default:
			if strings.HasPrefix(arg, "-") {
				return f, rest, "unknown option " + arg
			}
			rest = append(rest, arg)
		}
	}
	return f, rest, ""
}

// emit prints findings and returns the exit code (0 ok, 1 on errors).
func emit(command string, fs []findings.Finding, asJSON bool, extra *orderedExtra) int {
	sorted := findings.Sort(fs)
	summary := findings.Summarize(sorted)
	ok := summary.Errors == 0
	if asJSON {
		fmt.Println(emitJSON(command, ok, sorted, summary, extra))
	} else {
		printFindings(sorted)
		var parts []string
		if extra != nil {
			for _, k := range extra.keys {
				v := extra.values[k]
				switch v.(type) {
				case string, int:
					parts = append(parts, fmt.Sprintf("%s: %v", k, v))
				}
			}
		}
		errWord := "errors"
		if summary.Errors == 1 {
			errWord = "error"
		}
		warnWord := "warnings"
		if summary.Warnings == 1 {
			warnWord = "warning"
		}
		status := "failed"
		if ok {
			status = "ok"
		}
		extras := ""
		if len(parts) > 0 {
			extras = "; " + strings.Join(parts, ", ")
		}
		fmt.Printf("%s (%d %s, %d %s%s)\n", status, summary.Errors, errWord, summary.Warnings, warnWord, extras)
	}
	if ok {
		return 0
	}
	return 1
}

// reportScaffoldIndex reports index-generation findings from init/adopt. The
// scaffold is already on disk, so this never unwinds it; it says what could not be
// indexed and returns the exit status, because a scaffold whose index is missing
// will fail the CI that `leji ci` generates and reporting success would hide that
// until then.
// isCalendarDate reports whether v is a real calendar date in YYYY-MM-DD. Parsing
// is the check: a pattern alone accepts 2026-02-30.
func isCalendarDate(v string) bool {
	t, err := time.Parse("2006-01-02", v)
	return err == nil && t.Format("2006-01-02") == v
}

func reportScaffoldIndex(fs []findings.Finding) int {
	if !findings.HasErrors(fs) {
		return 0
	}
	fmt.Println()
	printFindings(findings.Sort(fs))
	fmt.Fprintln(os.Stderr, "leji: the context index could not be generated, so it was not written.")
	fmt.Fprintln(os.Stderr, "      The scaffold is in place; fix the findings above and run `leji index`.")
	return 1
}

func printFindings(fs []findings.Finding) {
	for _, f := range fs {
		where := ""
		if f.HasPath && f.Path != "" {
			where = " " + f.Path
		}
		sev := "warning"
		if f.Severity == findings.Error {
			sev = "error  "
		}
		fmt.Printf("%s %s%s: %s\n", sev, f.Rule, where, f.Message)
	}
}

// orderedExtra preserves the insertion order of the per-command extra fields.
type orderedExtra struct {
	keys   []string
	values map[string]any
}

func newExtra() *orderedExtra { return &orderedExtra{values: map[string]any{}} }
func (e *orderedExtra) set(k string, v any) {
	if _, ok := e.values[k]; !ok {
		e.keys = append(e.keys, k)
	}
	e.values[k] = v
}

func findingToMap(f findings.Finding) *jsonObj {
	o := newJSONObj()
	o.set("rule", f.Rule)
	o.set("severity", f.Severity)
	if f.HasPath {
		o.set("path", f.Path)
	}
	o.set("message", f.Message)
	return o
}

func emitJSON(command string, ok bool, fs []findings.Finding, summary findings.Summary, extra *orderedExtra) string {
	root := newJSONObj()
	root.set("command", command)
	root.set("ok", ok)
	findingsArr := make([]any, 0, len(fs))
	for _, f := range fs {
		findingsArr = append(findingsArr, findingToMap(f))
	}
	root.set("findings", findingsArr)
	sum := newJSONObj()
	sum.set("errors", summary.Errors)
	sum.set("warnings", summary.Warnings)
	root.set("summary", sum)
	if extra != nil {
		for _, k := range extra.keys {
			root.set(k, extra.values[k])
		}
	}
	var buf bytes.Buffer
	root.encode(&buf, "", "  ")
	return buf.String()
}

// valueFlags drives per-command flag validation from cli.json: each command
// accepts the globals plus its own flags; any other is a usage error, not
// silently ignored.
var valueFlags = map[string]bool{"--root": true, "--dir": true, "--level": true, "--mode": true, "--name": true, "--port": true, "--agent": true, "--host": true, "--role": true, "--out": true, "--keep": true, "--before": true, "--provider": true, "--paths": true, "--categories": true, "--topics": true, "--as-of": true, "--federation": true}

func flagTokens(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if fields := strings.Fields(part); len(fields) > 0 {
			out = append(out, fields[0])
		}
	}
	return out
}

func seenFlags(argv []string) []string {
	var out []string
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		// `--` is itself a declared flag (on `start` only); everything after it is
		// host pass-through and never our flags, so the scan records it and stops.
		if a == "--" {
			out = append(out, "--")
			break
		}
		if strings.HasPrefix(a, "-") {
			eq := -1
			if strings.HasPrefix(a, "--") {
				eq = strings.Index(a, "=")
			}
			name := a
			if eq > 2 {
				name = a[:eq]
			}
			out = append(out, name)
			if valueFlags[name] && eq < 0 {
				i++ // skip the flag's value, not a flag itself
			}
		}
	}
	return out
}

// twoWordCommands take a subcommand (e.g. `changelog check`, `viewer serve`).
// The bare form is valid only when cli.json documents it (e.g. `viewer`); a bare
// `changelog` falls through to the dispatcher's usage error.
var twoWordCommands = map[string]bool{"changelog": true, "viewer": true, "mounts": true}

func allowedFlagsFor(command, sub string) (map[string]bool, bool) {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		return nil, false
	}
	name := command
	if twoWordCommands[command] && sub != "" {
		name = command + " " + sub
	}
	var cmd *schemas.CliCommand
	for i := range spec.Commands {
		if spec.Commands[i].Name == name {
			cmd = &spec.Commands[i]
			break
		}
	}
	if cmd == nil {
		return nil, false
	}
	allowed := map[string]bool{}
	for _, o := range append(append([]schemas.CliOption{}, spec.GlobalOptions...), cmd.Options...) {
		for _, t := range flagTokens(o.Flags) {
			allowed[t] = true
		}
	}
	return allowed, true
}

func Run(argv []string) int {
	f, rest, perr := parseFlags(argv)
	usage := BuildUsage()
	if perr != "" {
		fmt.Fprintf(os.Stderr, "leji: %s\n\n", perr)
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
	// Meta-flags short-circuit before dispatch, wherever they appear in argv, so
	// `leji <command> --help`/`--version` never runs the command (a help request
	// must not have side effects).
	if f.help {
		var hcmd, hsub string
		if len(rest) > 0 {
			hcmd = rest[0]
		}
		if len(rest) > 1 {
			hsub = rest[1]
		}
		hname := hcmd
		if twoWordCommands[hcmd] && hsub != "" {
			hname = hcmd + " " + hsub
		}
		if hname != "" {
			if h, ok := BuildCommandHelp(hname); ok {
				fmt.Println(h)
				return 0
			}
		}
		fmt.Println(usage)
		return 0
	}
	if f.version {
		fmt.Println(schemas.SDKVersion)
		return 0
	}
	var command, sub string
	if len(rest) > 0 {
		command = rest[0]
	}
	if len(rest) > 1 {
		sub = rest[1]
	}
	if command == "" || command == "help" {
		fmt.Println(usage)
		if command != "" {
			return 0
		}
		return 2
	}
	if command == "version" {
		fmt.Println(schemas.SDKVersion)
		return 0
	}

	// Reject any flag not declared for this command in cli.json (globals allowed
	// everywhere). Runs after the version/help short-circuit; unknown commands fall
	// through to the dispatcher's default.
	if allowed, ok := allowedFlagsFor(command, sub); ok {
		for _, t := range seenFlags(argv) {
			if !allowed[t] {
				where := command
				if twoWordCommands[command] && sub != "" {
					where = command + " " + sub
				}
				fmt.Fprintf(os.Stderr, "leji: %s is not valid for %q\n\n", t, where)
				fmt.Fprintln(os.Stderr, usage)
				return 2
			}
		}
	}

	// Reject surplus positional arguments. Python's parser rejected them while this
	// implementation and Node silently ignored them, so a typo or an accidentally
	// appended filename was accepted by two implementations out of three.
	{
		expected := 1
		if twoWordCommands[command] && sub != "" {
			expected = 2
		}
		if command == "mounts" && sub == "locate" {
			expected++
		}
		// `view` has its own usage message for a stray subcommand, and it is the more
		// useful one; let that case fall through to it.
		if command != "view" && len(rest) > expected {
			where := command
			if twoWordCommands[command] && sub != "" {
				where = command + " " + sub
			}
			fmt.Fprintf(os.Stderr, "leji: unexpected argument %q for %q\n\n", rest[expected], where)
			fmt.Fprintln(os.Stderr, usage)
			return 2
		}
	}

	switch command {
	case "validate":
		result := validate.ValidateLayer(f.root, f.content)
		if f.federation == "" {
			return emit("validate", result.Findings, f.json, nil)
		}
		if f.federation != "available" && f.federation != "required" {
			fmt.Fprint(os.Stderr, "leji: --federation must be available or required\n\n")
			fmt.Fprintln(os.Stderr, usage)
			return 2
		}
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("validate", result.Findings, f.json, nil)
		}
		var taskMounts map[string]bool
		if f.federation == "required" {
			if f.paths == "" {
				fmt.Fprint(os.Stderr, "leji: --federation=required needs --paths <a,b,...> (the task scope)\n\n")
				fmt.Fprintln(os.Stderr, usage)
				return 2
			}
			paths := []string{}
			for _, p := range strings.Split(f.paths, ",") {
				p = strings.TrimSpace(p)
				if p != "" {
					paths = append(paths, p)
				}
			}
			routed, rerr := layer.Route(f.root, load.Manifest, layer.RouteInput{Paths: paths})
			if rerr != nil {
				fmt.Fprintf(os.Stderr, "leji: %s\n", rerr.Error())
				return 2
			}
			taskMounts = map[string]bool{}
			for _, mt := range routed.Mounts {
				taskMounts[mt.Name] = true
			}
		}
		enforcement, eerr := mounts.FederationEnforcement(f.root, load.Manifest, f.federation, taskMounts)
		if eerr != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", eerr.Error())
			return 2
		}
		all := append([]findings.Finding{}, result.Findings...)
		for _, ef := range enforcement {
			all = append(all, findings.New(ef.Rule, ef.Severity, ef.Message, ef.Path))
		}
		return emit("validate --federation="+f.federation, all, f.json, nil)
	case "index":
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("index", load.Findings, f.json, nil)
		}
		if f.check {
			result := indexgen.CheckIndex(f.root, load.Manifest)
			extra := newExtra()
			stale := true
			if result.Stale != nil {
				stale = *result.Stale
			}
			extra.set("stale", stale)
			return emit("index --check", append(load.Findings, result.Findings...), f.json, extra)
		}
		result, werr := indexgen.WriteIndex(f.root, load.Manifest)
		if werr != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", werr.Error())
			return 2
		}
		extra := newExtra()
		// WriteIndex refuses to write when generation hit a hard error, and reports it
		// in Findings with a nil error; in that case report nothing written and do not
		// seed a changelog off a bad tree.
		wrote := !findings.HasErrors(result.Findings)
		entries := 0
		if wrote && result.Index != nil {
			entries = len(result.Index.Entries)
		}
		if wrote {
			extra.set("written", manifest.EffectiveIndexPath(load.Manifest))
		}
		extra.set("entries", entries)
		if wrote {
			// If the layer claims indexed (or higher) and has no changelog yet, seed it
			// (otherwise only `init --level indexed` does).
			seeded, err := changelog.SeedChangelogIfMissing(f.root, load.Manifest)
			if err != nil {
				fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
				return 2
			}
			if seeded != "" {
				extra.set("changelog", seeded)
			}
		}
		return emit("index", append(load.Findings, result.Findings...), f.json, extra)
	case "changelog":
		if sub == "check" {
			load := manifest.LoadManifest(f.root)
			if load.Manifest == nil {
				return emit("changelog check", load.Findings, f.json, nil)
			}
			rel := manifest.EffectiveChangelogPath(load.Manifest)
			result := validate.CheckChangelogAppendOnly(f.root, rel, f.strict)
			extra := newExtra()
			extra.set("verified", result.Verified)
			return emit("changelog check", append(load.Findings, result.Findings...), f.json, extra)
		}
		if sub == "compact" {
			if !f.hasKeep && !f.hasBefore {
				fmt.Fprint(os.Stderr, "leji: changelog compact requires --keep or --before\n\n")
				fmt.Fprintln(os.Stderr, usage)
				return 2
			}
			// Compaction removes entries. A merely digit-shaped date would select a run
			// for a destructive rewrite on a day that does not exist.
			if f.hasBefore && !isCalendarDate(f.before) {
				fmt.Fprintf(os.Stderr, "leji: --before must be a calendar date (YYYY-MM-DD), got %q\n", f.before)
				return 2
			}
			load := manifest.LoadManifest(f.root)
			if load.Manifest == nil {
				return emit("changelog compact", load.Findings, f.json, nil)
			}
			result := changelog.CompactChangelog(f.root, load.Manifest, changelog.CompactOptions{
				Keep: f.keep, HasKeep: f.hasKeep, Before: f.before, HasBefore: f.hasBefore,
			})
			extra := newExtra()
			extra.set("changelog", result.Path)
			extra.set("folded", result.Folded)
			extra.set("kept", result.Kept)
			if result.Folded == 0 && len(result.Findings) == 0 {
				extra.set("note", "nothing to compact")
			}
			return emit("changelog compact", append(load.Findings, result.Findings...), f.json, extra)
		}
		fmt.Fprint(os.Stderr, "leji: usage: leji changelog <check|compact>\n\n")
		return 2
	case "freshness":
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("freshness", load.Findings, f.json, nil)
		}
		report := freshness.FreshnessReport(f.root, load.Manifest, f.strict)
		if !f.json {
			for _, item := range report.Upcoming {
				fmt.Printf("upcoming %s: review after %s\n", item.Path, item.ReviewAfter)
			}
		}
		extra := newExtra()
		extra.set("declared", report.Declared)
		if f.json {
			extra.set("expired", freshItems(report.Expired))
			extra.set("upcoming", freshItems(report.Upcoming))
		} else {
			extra.set("expired", len(report.Expired))
			extra.set("upcoming", len(report.Upcoming))
		}
		return emit("freshness", append(load.Findings, report.Findings...), f.json, extra)
	case "status":
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("status", load.Findings, f.json, nil)
		}
		report := status.StatusReport(f.root, load.Manifest)
		flagged := len(report.Unindexed) + len(report.Dangling) + len(report.Stale) + len(report.Pending)
		exit := 0
		if f.strict && flagged > 0 {
			exit = 1
		}
		if f.json {
			o := newJSONObj()
			o.set("command", "status")
			o.set("ok", exit == 0)
			o.set("strict", f.strict)
			unindexed := make([]any, 0, len(report.Unindexed))
			for _, p := range report.Unindexed {
				unindexed = append(unindexed, p)
			}
			o.set("unindexed", unindexed)
			dangling := make([]any, 0, len(report.Dangling))
			for _, d := range report.Dangling {
				do := newJSONObj()
				do.set("indexFile", d.IndexFile)
				do.set("detail", d.Detail)
				dangling = append(dangling, do)
			}
			o.set("dangling", dangling)
			stale := make([]any, 0, len(report.Stale))
			for _, p := range report.Stale {
				stale = append(stale, p)
			}
			o.set("stale", stale)
			pending := make([]any, 0, len(report.Pending))
			for _, p := range report.Pending {
				pending = append(pending, p)
			}
			o.set("pending", pending)
			shadowed := make([]any, 0, len(report.Shadowed))
			for _, s := range report.Shadowed {
				so := newJSONObj()
				so.set("indexFile", s.IndexFile)
				so.set("path", s.Path)
				shadowed = append(shadowed, so)
			}
			o.set("shadowed", shadowed)
			skippedReadmes := make([]any, 0, len(report.SkippedReadmes))
			for _, s := range report.SkippedReadmes {
				so := newJSONObj()
				so.set("indexFile", s.IndexFile)
				so.set("path", s.Path)
				skippedReadmes = append(skippedReadmes, so)
			}
			o.set("skippedReadmes", skippedReadmes)
			proj := newJSONObj()
			proj.set("state", report.Projection.State)
			switch report.Projection.State {
			case "ok":
				proj.set("commit", report.Projection.Commit)
				proj.set("files", report.Projection.Files)
			case "fail":
				proj.set("commit", report.Projection.Commit)
				proj.set("detail", report.Projection.Detail)
			}
			o.set("projection", proj)
			var buf bytes.Buffer
			o.encode(&buf, "", "  ")
			fmt.Println(buf.String())
			return exit
		}
		fmt.Printf("Unindexed (present, in no category index; reference): %d\n", len(report.Unindexed))
		for _, p := range report.Unindexed {
			fmt.Printf("  %s\n", p)
		}
		fmt.Printf("Dangling index entries (listed but unresolved): %d\n", len(report.Dangling))
		for _, d := range report.Dangling {
			fmt.Printf("  %s: %s\n", d.IndexFile, d.Detail)
		}
		fmt.Printf("Stale index entries (in stored index, no longer resolved): %d\n", len(report.Stale))
		for _, p := range report.Stale {
			fmt.Printf("  %s\n", p)
		}
		fmt.Printf("Pending index entries (governed, not yet in the stored index; run `leji index`): %d\n", len(report.Pending))
		for _, p := range report.Pending {
			fmt.Printf("  %s\n", p)
		}
		// Informational only: shadowed selectors never count toward strict.
		fmt.Printf("Shadowed selectors (fully displaced by more-specific ones): %d\n", len(report.Shadowed))
		for _, s := range report.Shadowed {
			fmt.Printf("  %s: %s\n", s.IndexFile, s.Path)
		}
		// Informational only: directory expansion skips READMEs by rule; this
		// surfaces each skip so governing one is a decision, not an accident.
		fmt.Printf("READMEs skipped by directory expansion (govern with an explicit entry, or leave as reference): %d\n", len(report.SkippedReadmes))
		for _, s := range report.SkippedReadmes {
			fmt.Printf("  %s: %s\n", s.IndexFile, s.Path)
		}
		// Report-only: judged against HEAD's object store, so it sees what a host's
		// hydrate would see, including untracked-but-bound files.
		proj := report.Projection
		switch proj.State {
		case "no-commit":
			fmt.Println("Projection (as a mounted sibling, at HEAD): no commit to judge")
		case "ok":
			fileWord := "files"
			if proj.Files == 1 {
				fileWord = "file"
			}
			fmt.Printf("Projection (as a mounted sibling, at %s): closure enumerates completely (%d %s)\n",
				shortCommit(proj.Commit), proj.Files, fileWord)
		default:
			fmt.Printf("Projection (as a mounted sibling, at %s): FAILS: %s\n", shortCommit(proj.Commit), proj.Detail)
		}
		statusWord := "ok"
		if exit != 0 {
			statusWord = "flagged"
		}
		itemWord := "items"
		if flagged == 1 {
			itemWord = "item"
		}
		strictNote := ""
		if f.strict {
			strictNote = ", strict"
		}
		fmt.Printf("%s (%d %s%s)\n", statusWord, flagged, itemWord, strictNote)
		return exit
	case "route":
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("route", load.Findings, f.json, nil)
		}
		asOf := f.asOf
		if asOf == "" {
			asOf = time.Now().UTC().Format("2006-01-02")
		}
		// Validate before routing. An unknown category or a non-date silently produced a
		// plausible, empty result: the caller cannot tell "nothing routes here" from
		// "you typed it wrong".
		if !isCalendarDate(asOf) {
			fmt.Fprintf(os.Stderr, "leji: --as-of must be a calendar date (YYYY-MM-DD), got %q\n", asOf)
			return 2
		}
		splitList := func(s string) []string {
			out := []string{}
			for _, x := range strings.Split(s, ",") {
				x = strings.TrimSpace(x)
				if x != "" {
					out = append(out, x)
				}
			}
			return out
		}
		requestedCategories := splitList(f.categories)
		for _, c := range requestedCategories {
			known := false
			for _, k := range manifest.CategoryIDs {
				if c == k {
					known = true
					break
				}
			}
			if !known {
				fmt.Fprintf(os.Stderr, "leji: unknown category %q; expected one of %s\n",
					c, strings.Join(manifest.CategoryIDs, ", "))
				return 2
			}
		}
		// Each --topics occurrence is one whole topic: never split, never trimmed. A
		// topic is a non-empty string of Unicode scalar values, so an unpaired
		// surrogate (which has no UTF-8 encoding) is rejected here rather than routed
		// as a value no manifest can match.
		requestedTopics := f.topics
		for _, t := range requestedTopics {
			if t == "" {
				fmt.Fprintln(os.Stderr, "leji: --topics takes a non-empty topic; each occurrence is one whole topic")
				return 2
			}
		}
		for _, t := range requestedTopics {
			if layer.HasLoneSurrogate(t) {
				fmt.Fprintf(os.Stderr, "leji: invalid topic %s; a topic is Unicode scalar values (no unpaired surrogates)\n", quoteTopic(t))
				return 2
			}
		}
		result, routeErr := layer.Route(f.root, load.Manifest, layer.RouteInput{
			Paths: splitList(f.paths), Categories: requestedCategories, Topics: requestedTopics, AsOf: asOf,
		})
		if routeErr != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", routeErr.Error())
			return 2
		}
		nullable := func(p *string) any {
			if p == nil {
				return nil
			}
			return *p
		}
		if f.json {
			o := newJSONObj()
			o.set("command", "route")
			o.set("ok", true)
			o.set("asOf", asOf)
			o.set("pathScoped", result.PathScoped)
			cats := make([]any, 0, len(result.Categories))
			for _, c := range result.Categories {
				cats = append(cats, c)
			}
			o.set("categories", cats)
			sigs := make([]any, 0, len(result.CategorySignals))
			for _, c := range result.CategorySignals {
				sigs = append(sigs, c)
			}
			o.set("categorySignals", sigs)
			docs := make([]any, 0, len(result.Documents))
			for _, d := range result.Documents {
				do := newJSONObj()
				do.set("path", d.Path)
				do.set("category", d.Category)
				do.set("reviewAfter", nullable(d.ReviewAfter))
				do.set("expired", d.Expired)
				docs = append(docs, do)
			}
			o.set("documents", docs)
			recs := make([]any, 0, len(result.Records))
			for _, r := range result.Records {
				ro := newJSONObj()
				ro.set("path", r.Path)
				ro.set("category", r.Category)
				ro.set("date", nullable(r.Date))
				ro.set("required", r.Required)
				recs = append(recs, ro)
			}
			o.set("records", recs)
			decs := make([]any, 0, len(result.Decisions))
			for _, dec := range result.Decisions {
				deo := newJSONObj()
				deo.set("id", dec.ID)
				deo.set("path", dec.Path)
				deo.set("status", dec.Status)
				deo.set("matchedBy", dec.MatchedBy)
				deo.set("reviewAfter", nullable(dec.ReviewAfter))
				deo.set("expired", dec.Expired)
				decs = append(decs, deo)
			}
			o.set("decisions", decs)
			mts := make([]any, 0, len(result.Mounts))
			for _, mt := range result.Mounts {
				mo := newJSONObj()
				mo.set("name", mt.Name)
				mo.set("pin", mt.Pin)
				mts = append(mts, mo)
			}
			o.set("mounts", mts)
			var buf bytes.Buffer
			o.encode(&buf, "", "  ")
			fmt.Println(buf.String())
			return 0
		}
		fmt.Printf("Task routing as of %s\n", asOf)
		if len(result.Categories) > 0 {
			fmt.Printf("Categories: %s\n", strings.Join(result.Categories, ", "))
		} else {
			fmt.Println("Categories: (none)")
		}
		fmt.Printf("Documents (%d):\n", len(result.Documents))
		for _, d := range result.Documents {
			fr := ""
			if d.ReviewAfter != nil {
				exp := ""
				if d.Expired {
					exp = ", EXPIRED"
				}
				fr = fmt.Sprintf(" (review after %s%s)", *d.ReviewAfter, exp)
			}
			fmt.Printf("   %s [%s]%s\n", d.Path, d.Category, fr)
		}
		fmt.Printf("Records (%d; dated candidates, never current intent):\n", len(result.Records))
		for _, r := range result.Records {
			dated := "undated"
			if r.Date != nil {
				dated = "dated " + *r.Date
			}
			req := ""
			if r.Required {
				req = ", required by task path"
			}
			fmt.Printf("   %s [%s] (%s%s)\n", r.Path, r.Category, dated, req)
		}
		fmt.Printf("Decisions (%d):\n", len(result.Decisions))
		for _, dec := range result.Decisions {
			fmt.Printf("   %s [%s] (%s)\n", dec.ID, dec.Status, dec.MatchedBy)
		}
		fmt.Printf("Mounts (%d):\n", len(result.Mounts))
		for _, mt := range result.Mounts {
			fmt.Printf("   %s @ %s\n", mt.Name, mt.Pin)
		}
		if !result.PathScoped {
			fmt.Println("Note: no task paths given; path-scoped routing was not evaluated.")
		}
		return 0
	case "conformance":
		if f.federation != "" && f.federation != "verify" {
			fmt.Fprint(os.Stderr, "leji: --federation on conformance takes only verify\n\n")
			fmt.Fprintln(os.Stderr, usage)
			return 2
		}
		result, rerr := conformance.Report(f.root, f.federation == "verify")
		if rerr != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", rerr.Error())
			return 2
		}
		if !f.json {
			for _, item := range result.Items {
				mark := "manual "
				switch item.Status {
				case conformance.Pass:
					mark = "pass   "
				case conformance.Fail:
					mark = "FAIL   "
				case conformance.Unknown:
					mark = "unknown"
				case conformance.NotApplicable:
					mark = "n/a    "
				}
				detail := ""
				if item.Detail != "" {
					detail = " — " + item.Detail
				}
				fmt.Printf("%s [%s] %s%s\n", mark, item.Level, item.Description, detail)
			}
			fmt.Println("")
			if f.explain {
				fmt.Println(conformance.RenderExplain(result) + "\n")
			}
		}
		extra := newExtra()
		claimed := result.ClaimedLevel
		if claimed == "" {
			claimed = "none"
		}
		verified := result.VerifiedLevel
		if verified == "" {
			verified = "none"
		}
		extra.set("claimedLevel", claimed)
		extra.set("verifiedLevel", verified)
		extra.set("processAttested", result.ProcessAttested)
		if f.json {
			extra.set("items", checklistItems(result.Items))
		}
		return emit("conformance", result.Findings, f.json, extra)
	case "mounts":
		if sub != "hydrate" && sub != "status" && sub != "locate" {
			fmt.Fprint(os.Stderr, "leji: usage: leji mounts <hydrate|status|locate>\n\n")
			fmt.Fprintln(os.Stderr, usage)
			return 2
		}
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("mounts "+sub, load.Findings, f.json, nil)
		}
		if sub == "hydrate" {
			r, err := mounts.HydrateMounts(f.root, load.Manifest, mounts.HydrateOptions{Fetch: f.fetch})
			if err != nil {
				fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
				return 2
			}
			if r.Fatal != "" {
				fmt.Fprintf(os.Stderr, "leji: %s\n", r.Fatal)
				return 1
			}
			rows := make([]mountFindingRow, 0, len(r.Outcomes))
			for _, o := range r.Outcomes {
				rows = append(rows, mountFindingRow{
					name:                 o.Name,
					status:               o.Status,
					detail:               o.Detail,
					storeFetched:         o.StoreFetched,
					witnessRefreshFailed: o.WitnessRefreshFailed,
					projectionFailed:     o.ProjectionFailed,
				})
			}
			issues := mountFindings(rows)
			hadError := false
			for _, o := range r.Outcomes {
				if o.Status == "error" {
					hadError = true
				}
			}
			if f.json {
				fmt.Println(mountsHydrateJSON(r.Outcomes, !hadError, issues))
			} else {
				available := 0
				for _, o := range r.Outcomes {
					detail := ""
					if o.Detail != "" {
						detail = ": " + o.Detail
					}
					fmt.Printf("%-11s %s%s\n", o.Status, o.Name, detail)
					if o.Status == "hydrated" || o.Status == "cached" {
						available++
					}
				}
				printFindings(issues)
				word := "ok"
				if hadError {
					word = "failed"
				}
				mountWord := "mounts"
				if len(r.Outcomes) == 1 {
					mountWord = "mount"
				}
				fmt.Printf("%s (%d/%d %s available)\n", word, available, len(r.Outcomes), mountWord)
			}
			// Best-effort: unavailability is availability, never failure, whether no
			// object store held the pin or the pinned layer would not project. Errors
			// (declaration, and the projection's safety guards) are.
			if hadError {
				return 1
			}
			return 0
		}
		if sub == "locate" {
			name := ""
			if len(rest) > 2 {
				name = rest[2]
			}
			if name == "" {
				fmt.Fprint(os.Stderr, "leji: usage: leji mounts locate <name>\n\n")
				return 2
			}
			r, err := mounts.LocateMount(f.root, load.Manifest, name)
			if err != nil {
				fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
				return 2
			}
			if f.json {
				fmt.Println(mountsLocateJSON(r))
			} else {
				fmt.Printf("name: %s\n", r.Name)
				fmt.Printf("pin: %s\n", strOr(r.Pin, "(undeclared)"))
				fmt.Printf("present: %t · verified: %t\n", r.Present, r.Verified)
				fmt.Printf("path: %s\n", strOr(r.Path, "(not hydrated)"))
				if r.Detail != "" {
					fmt.Printf("note: %s\n", r.Detail)
				}
			}
			if r.Present {
				return 0
			}
			return 1
		}
		rows, err := mounts.MountStatus(f.root, load.Manifest, mounts.StatusOptions{CheckIntegrity: f.checkIntegr})
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		// No per-row findings here: `status` never fetches, so it has nothing of
		// its own to report.
		issues := mountFindings(nil)
		if f.json {
			fmt.Println(mountsStatusJSON(rows, issues))
		} else {
			for _, row := range rows {
				rep := row.PinReport
				pinLine := rep.State
				switch rep.State {
				case "behind":
					pinLine = fmt.Sprintf("behind %d (vs %s)", *rep.Behind, strOr(rep.ComparedRef, "null"))
				case "diverged":
					pinLine = fmt.Sprintf("diverged +%d/-%d (vs %s)", *rep.Ahead, *rep.Behind, strOr(rep.ComparedRef, "null"))
				case "ahead":
					pinLine = fmt.Sprintf("ahead %d (vs %s)", *rep.Ahead, strOr(rep.ComparedRef, "null"))
				}
				ver := ""
				if row.Verified != nil {
					ver = fmt.Sprintf(" · verified: %t", *row.Verified)
				}
				pin := row.Pin
				if len(pin) > 12 {
					pin = pin[:12]
				}
				fmt.Printf("%s @ %s · present: %t%s · pin: %s\n", row.Name, pin, row.Present, ver, pinLine)
				if rep.Reason != "" {
					prose := mountReasons[rep.Reason]
					if prose == "" {
						prose = rep.Reason
					}
					fmt.Printf("   %s\n", prose)
				}
			}
			if len(rows) == 0 {
				fmt.Println("no federation.mounts declared")
			}
			printFindings(issues)
		}
		return 0
	case "view", "viewer":
		// `leji view` is an alias for `leji viewer serve` that also opens the browser.
		// `leji viewer` generates only; `leji viewer serve` serves.
		isAlias := command == "view"
		if command == "viewer" && sub != "" && sub != "serve" && sub != "build" {
			fmt.Fprint(os.Stderr, "leji: usage: leji viewer [serve|build]\n\n")
			fmt.Fprintln(os.Stderr, usage)
			return 2
		}
		if isAlias && sub != "" {
			fmt.Fprint(os.Stderr, "leji: usage: leji view\n\n")
			fmt.Fprintln(os.Stderr, usage)
			return 2
		}
		if command == "viewer" && sub == "build" {
			load := manifest.LoadManifest(f.root)
			if load.Manifest == nil {
				return emit("viewer build", load.Findings, f.json, nil)
			}
			out := ""
			if f.hasOut {
				out = f.out
			}
			r, err := viewer.BuildViewer(f.root, load.Manifest, out)
			if err != nil {
				fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
				return 2
			}
			for _, fnd := range r.Findings {
				if fnd.Severity == findings.Error {
					return emit("viewer build", r.Findings, f.json, nil)
				}
			}
			if f.json {
				o := newJSONObj()
				o.set("command", "viewer build")
				o.set("ok", true)
				o.set("out", r.Out)
				o.set("warning", viewer.ProtectWarning)
				var buf bytes.Buffer
				o.encode(&buf, "", "  ")
				fmt.Println(buf.String())
			} else {
				fmt.Printf("Exported the static viewer to %s/\n", r.Out)
				fmt.Printf("\n%s\n", viewer.ProtectWarning)
			}
			return 0
		}
		wantServe := isAlias || sub == "serve"
		wantOpen := f.open || isAlias
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("viewer", load.Findings, f.json, nil)
		}
		result, err := viewer.GenerateViewer(f.root, load.Manifest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		// Terse by design: findings when something needs attention, one status
		// line otherwise. The full write list lives in --json.
		allFindings := append(load.Findings, result.Findings...)
		var code int
		switch {
		case f.json:
			extra := newExtra()
			extra.set("written", strings.Join(result.Written, ", "))
			extra.set("entries", result.Entries)
			code = emit("viewer", allFindings, true, extra)
		case len(allFindings) > 0:
			code = emit("viewer", allFindings, false, nil)
		default:
			code = 0
		}
		if !wantServe || code != 0 {
			if !f.json && code == 0 {
				dir := fsx.StripSlash(load.Manifest.RootPath)
				if dir == "" {
					dir = "."
				}
				fmt.Printf("viewer ready (%d entries) → %s/.leji/viewer/   serve: leji view\n", result.Entries, dir)
			}
			return code
		}
		port := viewer.ResolveViewerPort(load.Manifest, f.port)
		var logf func(string)
		if !f.json {
			logf = func(line string) { fmt.Println(line) }
		}
		ln, srv, err := viewer.Serve(f.root, port, load.Manifest.RootPath, logf)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		actual := port
		if tcp, ok := ln.Addr().(*net.TCPAddr); ok {
			actual = tcp.Port
		}
		// Display localhost (nicer, still a secure context); the server stays bound
		// to 127.0.0.1, which localhost resolves to on loopback. Viewer is served
		// at the web root, so the URL is just `/`.
		url := fmt.Sprintf("http://localhost:%d/", actual)
		title := load.Manifest.Name
		if load.Manifest.Viewer != nil && load.Manifest.Viewer.Title != "" {
			title = load.Manifest.Viewer.Title
		}
		fmt.Printf("%s viewer → %s   (Ctrl+C to stop)\n", title, url)
		if wantOpen {
			viewer.OpenBrowser(url)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		serveErr := make(chan error, 1)
		go func() { serveErr <- srv.Serve(ln) }()
		select {
		case <-ctx.Done():
			stop()
			_ = srv.Shutdown(context.Background())
			<-serveErr
			return 0
		case err := <-serveErr:
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
				return 2
			}
			return 0
		}
	case "detect":
		hosts := detectcmd.DetectLayer(f.root)
		if f.json {
			fmt.Println(detectJSON(hosts))
		} else {
			fmt.Println(detectcmd.RenderDetect(hosts))
		}
		return 0
	case "adopt":
		dir := f.dir
		if f.dir == "." && f.root != "." {
			dir = f.root
		}
		opts := initcmd.AdoptOptions{Dir: dir, Yes: f.yes, DryRun: f.dryRun, WireAdapters: f.wireAdapters, NoAgents: f.noAgents, Agent: f.agent, Mode: f.mode}
		if f.hasName {
			opts.Name = f.name
		}
		result, err := initcmd.AdoptLayer(opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		if result.DryRun {
			// A wire-only run scaffolds nothing, so "Adopting the existing
			// repository" misnames it: the layer is already there and the plan
			// beneath is entrypoint conversions.
			if result.WiredOnly {
				fmt.Printf("\nWiring vendor entrypoints into the existing layer (context root: %s).\n", result.DetectedRoot)
			} else {
				fmt.Printf("\nAdopting the existing repository (context root: %s).\n", result.DetectedRoot)
			}
			fmt.Println("\n" + writeplan.Render(result.Plan))
			fmt.Println("\nNo files written (--dry-run). Re-run without --dry-run to apply.")
			return 0
		}
		fmt.Printf("\nWrote %d files (context root: %s):\n", len(result.Written), result.DetectedRoot)
		for _, rel := range result.Written {
			fmt.Printf("   %s\n", rel)
		}
		indexFailed := reportScaffoldIndex(result.Findings)
		hio := initcmd.DefaultHandoffIO(os.Stdin, os.Stdout)
		interactive := !f.yes && stdinIsTTY()
		mcp := initcmd.OfferMcpInstall(initcmd.McpOfferOptions{Root: result.Root, Detected: result.Detected, Interactive: interactive, Agent: f.agent}, hio, os.Stdout)
		if gerr := initcmd.OfferApprovalGuard(initcmd.GuardOfferOptions{Root: result.Root, RootPath: result.Manifest.RootPath, Detected: result.Detected, Interactive: interactive, Agent: f.agent}, hio, os.Stdout); gerr != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", gerr.Error())
			return 2
		}
		launched, herr := initcmd.HandoffOffer(result.Manifest, result.Detected, interactive, hio, os.Stdout, f.agent, result.Root, mcp)
		if herr != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", herr.Error())
			return 2
		}
		if !launched {
			fmt.Println(initcmd.EnteringAdopted(result))
		}
		return indexFailed
	case "init":
		dir := f.dir
		if f.dir == "." && f.root != "." {
			dir = f.root
		}
		// StdinTTY gates the interactive mode question the same way the handoff
		// offer is gated: piped/CI runs never see it.
		opts := initcmd.Options{Dir: dir, Yes: f.yes, Level: f.level, DryRun: f.dryRun, NoAgents: f.noAgents, Agent: f.agent, Mode: f.mode, StdinTTY: stdinIsTTY()}
		if f.hasName {
			opts.Name = f.name
		}
		result, err := initcmd.InitLayer(opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		if result.DryRun {
			fmt.Println("\n" + writeplan.Render(result.Plan))
			fmt.Println("\nNo files written (--dry-run). Re-run without --dry-run to create them.")
			return 0
		}
		fmt.Printf("\nWrote %d files:\n", len(result.Written))
		for _, rel := range result.Written {
			fmt.Printf("   %s\n", rel)
		}
		indexFailed := reportScaffoldIndex(result.Findings)
		hio := initcmd.DefaultHandoffIO(os.Stdin, os.Stdout)
		interactive := !f.yes && stdinIsTTY()
		mcp := initcmd.OfferMcpInstall(initcmd.McpOfferOptions{Root: result.Root, Detected: result.Detected, Interactive: interactive, Agent: f.agent}, hio, os.Stdout)
		if gerr := initcmd.OfferApprovalGuard(initcmd.GuardOfferOptions{Root: result.Root, RootPath: result.Manifest.RootPath, Detected: result.Detected, Interactive: interactive, Agent: f.agent}, hio, os.Stdout); gerr != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", gerr.Error())
			return 2
		}
		launched, herr := initcmd.HandoffOffer(result.Manifest, result.Detected, interactive, hio, os.Stdout, f.agent, result.Root, mcp)
		if herr != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", herr.Error())
			return 2
		}
		if !launched {
			fmt.Println(initcmd.EnteringTheLayer(result.Manifest, result.Mode))
		}
		return indexFailed
	case "start":
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("start", load.Findings, f.json, nil)
		}
		detected := detect.DetectHosts(detect.Options{Root: f.root})
		interactive := !f.yes && stdinIsTTY()
		hio := initcmd.DefaultHandoffIO(os.Stdin, os.Stdout)
		outcome, err := initcmd.EnterLayer(initcmd.StartOptions{
			Root: f.root, Manifest: load.Manifest, Detected: detected, Agent: f.agent, Interactive: interactive,
			HostArgs: f.hostArgs,
		}, hio, os.Stdout)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		if outcome == initcmd.StartBootMissing {
			fmt.Fprintf(os.Stderr, "leji: boot profile %s is missing or invalid; run leji validate\n", load.Manifest.BootProfilePath)
			return 1
		}
		if outcome == initcmd.StartFallback {
			fmt.Println(initcmd.EnteringViaBoot(load.Manifest, f.hostArgs))
		}
		return 0
	case "ci":
		if f.hooks {
			load := manifest.LoadManifest(f.root)
			if load.Manifest == nil {
				return emit("ci", load.Findings, f.json, nil)
			}
			h, err := initcmd.EnsureLocalHook(f.root)
			if err != nil {
				fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
				return 2
			}
			if f.json {
				o := newJSONObj()
				o.set("command", "ci")
				o.set("ok", true)
				o.set("hook", h.Path)
				o.set("action", h.Action)
				if h.Action == "manual" {
					o.set("reason", h.Reason)
					o.set("snippet", h.Snippet)
				}
				var buf bytes.Buffer
				o.encode(&buf, "", "  ")
				fmt.Println(buf.String())
			} else if h.Action == "manual" {
				lead := fmt.Sprintf("%s was not modified (not leji-managed); add this yourself:", h.Path)
				if h.Reason == "outside-root" {
					lead = fmt.Sprintf("%s resolves outside the repository (core.hooksPath); add this yourself where your hooks run:", h.Path)
				}
				fmt.Printf("%s\n\n%s\n", lead, h.Snippet)
			} else if h.Managed == "block" {
				var lead string
				switch h.Action {
				case "unchanged":
					lead = fmt.Sprintf("Hook block already current in %s", h.Path)
				case "created":
					lead = fmt.Sprintf("Wrote leji hook block to %s", h.Path)
				default:
					lead = fmt.Sprintf("Merged leji hook block into %s", h.Path)
				}
				fmt.Printf("%s (validate + index --check before every commit; remove the leji block to opt out).\n", lead)
			} else {
				verb := "Wrote"
				if h.Action == "unchanged" {
					verb = "Hook already current"
				}
				fmt.Printf("%s %s (validate + index --check before every commit; per-clone, delete to opt out).\n", verb, h.Path)
			}
			return 0
		}
		// No --provider: infer from the origin remote (a GitLab repo must
		// never silently receive a GitHub workflow); say which and why.
		provider := f.provider
		if provider == "" {
			origin, _ := git.OriginURL(f.root)
			inferred := initcmd.CiProviderFromRemote(origin)
			provider = inferred
			if provider == "" {
				provider = "github"
			}
			if !f.json {
				if inferred != "" {
					fmt.Printf("No --provider given; origin remote (%s) → %s.\n", origin, inferred)
				} else {
					fmt.Println("No --provider given and no recognizable origin remote; defaulting to github.")
				}
			}
		}
		if provider != "github" && provider != "gitlab" && provider != "circleci" && provider != "azure" {
			fmt.Fprintf(os.Stderr, "leji: unknown provider %q; expected github, gitlab, circleci, or azure\n\n", provider)
			return 2
		}
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("ci", load.Findings, f.json, nil)
		}
		r, err := initcmd.EnsureCiWorkflow(f.root, provider)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		if f.json {
			o := newJSONObj()
			o.set("command", "ci")
			o.set("ok", true)
			o.set("provider", r.Provider)
			o.set("workflow", r.Path)
			o.set("action", r.Action)
			o.set("created", r.Action == "created")
			if r.Action == "manual" {
				o.set("snippet", r.Snippet)
			}
			if r.Note != "" {
				o.set("note", r.Note)
			}
			var buf bytes.Buffer
			o.encode(&buf, "", "  ")
			fmt.Println(buf.String())
		} else {
			switch r.Action {
			case "created":
				fmt.Printf("Wrote %s\n", r.Path)
			case "updated":
				fmt.Printf("Updated %s\n", r.Path)
			case "unchanged":
				fmt.Printf("%s already present; nothing to do.\n", r.Path)
			case "manual":
				fmt.Printf("%s already exists; not modifying it. Add this to your CircleCI config:\n\n%s\n", r.Path, r.Snippet)
			}
			if r.Note != "" {
				fmt.Println(r.Note)
			}
		}
		return 0
	case "agent":
		if f.name == "" {
			fmt.Fprint(os.Stderr, "leji: agent requires --name\n\n")
			fmt.Fprintln(os.Stderr, usage)
			return 2
		}
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("agent", load.Findings, f.json, nil)
		}
		r, err := initcmd.AddAgent(f.root, load.Manifest, initcmd.AgentOptions{Host: f.host, Name: f.name, Role: f.role})
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		if f.json {
			o := newJSONObj()
			o.set("command", "agent")
			o.set("ok", true)
			o.set("name", r.Name)
			o.set("role", r.Role)
			if r.HostID == "" {
				o.set("host", nil)
			} else {
				o.set("host", r.HostID)
			}
			o.set("profile", r.ProfilePath)
			created := newJSONObj()
			created.set("profile", r.ProfileCreated)
			created.set("manifest", r.ManifestChanged)
			o.set("created", created)
			var buf bytes.Buffer
			o.encode(&buf, "", "  ")
			fmt.Println(buf.String())
		} else {
			var lines []string
			if r.ProfileCreated {
				lines = append(lines, "Wrote "+r.ProfilePath)
			} else {
				lines = append(lines, r.ProfilePath+" already present")
			}
			roleHost := "role " + r.Role
			if r.HostID != "" {
				roleHost = "role " + r.Role + ", host " + r.HostID
			}
			if r.ManifestChanged {
				lines = append(lines, fmt.Sprintf("Bound agent %q (%s) in leji.json", r.Name, roleHost))
			} else {
				lines = append(lines, fmt.Sprintf("agent %q already bound in leji.json; nothing to do.", r.Name))
			}
			fmt.Println(strings.Join(lines, "\n"))
		}
		return 0
	default:
		fmt.Fprintf(os.Stderr, "leji: unknown command %q\n\n", command)
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
}

// detectJSON renders the detect result as {command, ok, hosts:[...]}, with each
// host's keys in Node DetectedHost order and a null adapter for directory hosts.
func detectJSON(hosts []detect.DetectedHost) string {
	root := newJSONObj()
	root.set("command", "detect")
	root.set("ok", true)
	arr := make([]any, 0, len(hosts))
	for _, h := range hosts {
		o := newJSONObj()
		o.set("id", h.ID)
		o.set("name", h.Name)
		o.set("strength", string(h.Strength))
		o.set("onPath", h.OnPath)
		o.set("inRepo", h.InRepo)
		o.set("userConfig", h.UserConfig)
		if h.Adapter == "" {
			o.set("adapter", nil)
		} else {
			o.set("adapter", h.Adapter)
		}
		arr = append(arr, o)
	}
	root.set("hosts", arr)
	var buf bytes.Buffer
	root.encode(&buf, "", "  ")
	return buf.String()
}

// strOr renders a nullable string the way a JS template renders it, with a
// fallback for the null case.
func strOr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}

// nullableStr maps a nil pointer to JSON null.
func nullableStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// mountFindings is what `mounts hydrate` and `mounts status` emit: what this run
// observed and nothing beyond it. The row-level warnings describe the run that is
// happening, never a remembered one, and all are visibility rather than failure —
// `hydrate` stays best-effort, so none moves the exit code.
func mountFindings(rows []mountFindingRow) []findings.Finding {
	var out []findings.Finding
	for _, r := range rows {
		// An unavailable mount whose pinned layer would not project: the outcome alone
		// is not the diagnostic interface JSON consumers read, so the failure reaches
		// findings[] too, carrying the projection's own stable detail unaltered.
		if r.status == "unavailable" && r.projectionFailed {
			out = append(out, findings.New(
				"mount-projection-failed",
				findings.Warning,
				"mount \""+r.name+"\" did not project at its pin: "+r.detail,
				r.name,
			))
		}
		if r.storeFetched != nil && !*r.storeFetched {
			out = append(out, findings.New(
				"mount-store-fetch-failed",
				findings.Warning,
				"the managed store could not be established by the requested fetch",
				r.name,
			))
		}
		if r.witnessRefreshFailed {
			out = append(out, findings.New(
				"mount-witness-refresh-failed",
				findings.Warning,
				"the managed witness ref could not be refreshed by the requested fetch",
				r.name,
			))
		}
	}
	return findings.Sort(out)
}

type mountFindingRow struct {
	name                 string
	status               string
	detail               string
	storeFetched         *bool
	witnessRefreshFailed bool
	projectionFailed     bool
}

// mountReasons is prose for the stable `mounts status` reason codes: --json emits
// the code, a person reads the sentence.
var mountReasons = map[string]string{
	"mount-source-unnormalizable": "source is not a normalizable locator",
	"mount-no-tracking-ref":       "no trackingRef declared; the source's advertised default branch needs network access",
	"mount-tracking-ref-invalid":  "trackingRef is not a fully qualified branch or tag",
	"mount-pin-unavailable":       "no reachable object store holds the pin (declare a hint, or pass --fetch)",
	"mount-witness-unavailable":   "no object store holding the pin resolves the witness ref; run `leji mounts hydrate --fetch`",
	"mount-source-ambiguous":      "more than one submodule matches the source; declare an explicit hint in .leji/mounts.local.json",
	"mount-ancestry-incomplete":   "incomplete ancestry; the comparison repository cannot answer the range",
}

// mountsHydrateJSON renders {command, ok, outcomes, findings} with each outcome's
// keys in Node insertion order and undefined fields omitted.
func mountsHydrateJSON(outcomes []mounts.HydrateOutcome, ok bool, fs []findings.Finding) string {
	root := newJSONObj()
	root.set("command", "mounts hydrate")
	root.set("ok", ok)
	arr := make([]any, 0, len(outcomes))
	for _, o := range outcomes {
		oo := newJSONObj()
		oo.set("name", o.Name)
		oo.set("status", o.Status)
		if o.Detail != "" {
			oo.set("detail", o.Detail)
		}
		if o.ProjectionFailed {
			oo.set("projectionFailed", true)
		}
		if o.CacheKey != "" {
			oo.set("cacheKey", o.CacheKey)
		}
		if o.ObjectSource != "" {
			oo.set("objectSource", o.ObjectSource)
		}
		if o.StoreFetched != nil {
			oo.set("storeFetched", *o.StoreFetched)
		}
		if o.WitnessRefreshFailed {
			oo.set("witnessRefreshFailed", true)
		}
		arr = append(arr, oo)
	}
	root.set("outcomes", arr)
	findingsArr := make([]any, 0, len(fs))
	for _, f := range fs {
		findingsArr = append(findingsArr, findingToMap(f))
	}
	root.set("findings", findingsArr)
	var buf bytes.Buffer
	root.encode(&buf, "", "  ")
	return buf.String()
}

// mountsLocateJSON renders {command, ...locate fields} in Node key order.
func mountsLocateJSON(r mounts.LocateResult) string {
	root := newJSONObj()
	root.set("command", "mounts locate")
	root.set("name", r.Name)
	root.set("sourceIdentity", nullableStr(r.SourceIdentity))
	root.set("pin", nullableStr(r.Pin))
	root.set("present", r.Present)
	root.set("verified", r.Verified)
	root.set("path", nullableStr(r.Path))
	if r.Detail != "" {
		root.set("detail", r.Detail)
	}
	var buf bytes.Buffer
	root.encode(&buf, "", "  ")
	return buf.String()
}

// mountsStatusJSON renders {command, mounts, findings} with each row's pinReport
// keys in Node insertion order (behind/ahead only when counted, reason only when
// degraded).
func mountsStatusJSON(rows []mounts.StatusResult, fs []findings.Finding) string {
	root := newJSONObj()
	root.set("command", "mounts status")
	arr := make([]any, 0, len(rows))
	for _, row := range rows {
		ro := newJSONObj()
		ro.set("name", row.Name)
		ro.set("sourceIdentity", nullableStr(row.SourceIdentity))
		ro.set("pin", row.Pin)
		ro.set("trackingRef", nullableStr(row.TrackingRef))
		ro.set("present", row.Present)
		if row.Verified == nil {
			ro.set("verified", nil)
		} else {
			ro.set("verified", *row.Verified)
		}
		rep := row.PinReport
		po := newJSONObj()
		po.set("state", rep.State)
		if rep.Behind != nil {
			po.set("behind", *rep.Behind)
		}
		if rep.Ahead != nil {
			po.set("ahead", *rep.Ahead)
		}
		po.set("comparedRef", nullableStr(rep.ComparedRef))
		po.set("comparisonRepository", nullableStr(rep.ComparisonRepository))
		po.set("witnessProvenance", nullableStr(rep.WitnessProvenance))
		po.set("ancestryComplete", rep.AncestryComplete)
		if rep.Reason != "" {
			po.set("reason", rep.Reason)
		}
		po.set("observedAt", rep.ObservedAt)
		ro.set("pinReport", po)
		arr = append(arr, ro)
	}
	root.set("mounts", arr)
	findingsArr := make([]any, 0, len(fs))
	for _, f := range fs {
		findingsArr = append(findingsArr, findingToMap(f))
	}
	root.set("findings", findingsArr)
	var buf bytes.Buffer
	root.encode(&buf, "", "  ")
	return buf.String()
}

func freshItems(items []freshness.Item) []any {
	out := make([]any, 0, len(items))
	for _, it := range items {
		o := newJSONObj()
		o.set("path", it.Path)
		o.set("reviewAfter", it.ReviewAfter)
		out = append(out, o)
	}
	return out
}

func checklistItems(items []conformance.ChecklistItem) []any {
	out := make([]any, 0, len(items))
	for _, it := range items {
		o := newJSONObj()
		o.set("id", it.ID)
		o.set("level", it.Level)
		o.set("description", it.Description)
		o.set("status", it.Status)
		if it.Detail != "" {
			o.set("detail", it.Detail)
		}
		out = append(out, o)
	}
	return out
}
