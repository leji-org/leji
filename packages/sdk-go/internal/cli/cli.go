// Package cli parses flags, dispatches commands, and emits results, mirroring
// index.ts: same flags, same per-command extra fields, same exit codes.
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

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/changelog"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	detectcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/docs"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/freshness"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/indexgen"
	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
	"github.com/leji-org/leji/packages/sdk-go/internal/writeplan"
)

type flags struct {
	root         string
	json         bool
	check        bool
	strict       bool
	yes          bool
	serve        bool
	content      bool
	dryRun       bool
	wireAdapters bool
	explain      bool
	ci           bool
	help         bool
	version      bool
	port         *int
	dir          string
	level        string
	name         string
	hasName      bool
	agent        string
	reviewer     string
	keep         int
	hasKeep      bool
	before       string
	hasBefore    bool
}

func parseFlags(argv []string) (flags, []string, string) {
	f := flags{root: ".", dir: "."}
	var rest []string
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch arg {
		case "--root":
			i++
			if i < len(argv) {
				f.root = argv[i]
			} else {
				f.root = ""
			}
			if f.root == "" {
				return f, rest, "--root requires a value"
			}
		case "--dir":
			i++
			if i < len(argv) {
				f.dir = argv[i]
			} else {
				f.dir = ""
			}
			if f.dir == "" {
				return f, rest, "--dir requires a value"
			}
		case "--level":
			i++
			var v string
			if i < len(argv) {
				v = argv[i]
			}
			if v != "core" && v != "indexed" {
				return f, rest, "--level must be core or indexed"
			}
			f.level = v
		case "--name":
			i++
			if i < len(argv) {
				f.name = argv[i]
			}
			if f.name == "" {
				return f, rest, "--name requires a value"
			}
			f.hasName = true
		case "--agent":
			i++
			if i < len(argv) {
				f.agent = argv[i]
			}
			if f.agent == "" {
				return f, rest, "--agent requires a value"
			}
		case "--reviewer":
			i++
			if i < len(argv) {
				f.reviewer = argv[i]
			}
			if f.reviewer == "" {
				return f, rest, "--reviewer requires a value"
			}
		case "--keep":
			i++
			var raw string
			if i < len(argv) {
				raw = argv[i]
			}
			v, err := strconv.Atoi(raw)
			if raw == "" || err != nil || v < 1 {
				return f, rest, "--keep must be a positive integer"
			}
			f.keep = v
			f.hasKeep = true
		case "--before":
			i++
			if i < len(argv) {
				f.before = argv[i]
			}
			if f.before == "" {
				return f, rest, "--before requires a value"
			}
			f.hasBefore = true
		case "--serve":
			f.serve = true
		case "--port":
			i++
			var raw string
			if i < len(argv) {
				raw = argv[i]
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
		case "--explain":
			f.explain = true
		case "--ci":
			f.ci = true
		case "--strict":
			f.strict = true
		case "--yes", "-y":
			f.yes = true
		case "-h", "--help":
			f.help = true
		case "-V", "--version":
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

// emit prints the result and returns the exit code (0 if no errors, else 1).
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

// Run executes the CLI and returns the process exit code.
// Per-command flag validation, driven by cli.json (the documented surface): each
// command accepts the global options plus its own, and any other command flag is a
// usage error rather than being silently ignored. (Meta-flag -h/-V handling,
// short-circuited above, is a separate concern.)
var valueFlags = map[string]bool{"--root": true, "--dir": true, "--level": true, "--name": true, "--port": true, "--agent": true, "--reviewer": true, "--keep": true, "--before": true}

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
		if strings.HasPrefix(a, "-") {
			out = append(out, a)
			if valueFlags[a] {
				i++ // skip the flag's value, not a flag itself
			}
		}
	}
	return out
}

func allowedFlagsFor(command, sub string) (map[string]bool, bool) {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		return nil, false
	}
	name := command
	if command == "changelog" {
		name = strings.TrimSpace("changelog " + sub)
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
	// `leji <command> --help`/`--version` shows usage or the version and never
	// runs the command (a help request must not have side effects).
	if f.help {
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

	// Reject any flag not declared for this command in cli.json (globals are allowed
	// everywhere). Runs after the version/help short-circuit, so meta-commands still
	// ignore flags; unknown commands fall through to the dispatcher's default.
	if allowed, ok := allowedFlagsFor(command, sub); ok {
		for _, t := range seenFlags(argv) {
			if !allowed[t] {
				where := command
				if command == "changelog" && sub != "" {
					where = command + " " + sub
				}
				fmt.Fprintf(os.Stderr, "leji: %s is not valid for %q\n\n", t, where)
				fmt.Fprintln(os.Stderr, usage)
				return 2
			}
		}
	}

	switch command {
	case "validate":
		result := validate.ValidateLayer(f.root, f.content)
		return emit("validate", result.Findings, f.json, nil)
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
		extra.set("written", manifest.EffectiveIndexPath(load.Manifest))
		entries := 0
		if result.Index != nil {
			entries = len(result.Index.Entries)
		}
		extra.set("entries", entries)
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
	case "conformance":
		result := conformance.Report(f.root)
		if !f.json {
			for _, item := range result.Items {
				mark := "manual"
				switch item.Status {
				case conformance.Pass:
					mark = "pass  "
				case conformance.Fail:
					mark = "FAIL  "
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
		if f.json {
			extra.set("items", checklistItems(result.Items))
		}
		return emit("conformance", result.Findings, f.json, extra)
	case "docs":
		load := manifest.LoadManifest(f.root)
		if load.Manifest == nil {
			return emit("docs", load.Findings, f.json, nil)
		}
		result, err := docs.GenerateDocs(f.root, load.Manifest)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		extra := newExtra()
		extra.set("written", strings.Join(result.Written, ", "))
		extra.set("entries", result.Entries)
		code := emit("docs", append(load.Findings, result.Findings...), f.json, extra)
		if !f.serve || code != 0 {
			if !f.json && code == 0 {
				fmt.Println("serve locally: leji docs --serve   (or any static server at the repository root)")
			}
			return code
		}
		port := docs.ResolveDocsPort(load.Manifest, f.port)
		ln, srv, err := docs.Serve(f.root, port)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		actual := port
		if tcp, ok := ln.Addr().(*net.TCPAddr); ok {
			actual = tcp.Port
		}
		fmt.Printf("serving http://127.0.0.1:%d/%s; Ctrl+C to stop\n", actual, load.Manifest.RootPath)
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
		opts := initcmd.AdoptOptions{Dir: dir, Yes: f.yes, DryRun: f.dryRun, WireAdapters: f.wireAdapters, Agent: f.agent}
		if f.hasName {
			opts.Name = f.name
		}
		result, err := initcmd.AdoptLayer(opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "leji: %s\n", err.Error())
			return 2
		}
		if result.DryRun {
			fmt.Printf("\nAdopting the existing repository (context root: %s).\n", result.DetectedRoot)
			fmt.Println("\n" + writeplan.Render(result.Plan))
			fmt.Println("\nNo files written (--dry-run). Re-run without --dry-run to apply.")
			return 0
		}
		fmt.Printf("\nWrote %d files (context root: %s):\n", len(result.Written), result.DetectedRoot)
		for _, rel := range result.Written {
			fmt.Printf("   %s\n", rel)
		}
		fmt.Println(initcmd.EnteringAdopted(result))
		return 0
	case "init":
		dir := f.dir
		if f.dir == "." && f.root != "." {
			dir = f.root
		}
		opts := initcmd.Options{Dir: dir, Yes: f.yes, Level: f.level, DryRun: f.dryRun, Agent: f.agent, Reviewer: f.reviewer, Ci: f.ci}
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
		fmt.Println(initcmd.EnteringTheLayer(result.Manifest))
		return 0
	default:
		fmt.Fprintf(os.Stderr, "leji: unknown command %q\n\n", command)
		fmt.Fprintln(os.Stderr, usage)
		return 2
	}
}

// detectJSON renders the detect result as {command, ok, hosts:[...]}, with each
// host's keys in the Node DetectedHost order and a null adapter for directory-
// style hosts.
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
