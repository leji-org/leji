package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/leji-org/leji/packages/sdk-go/internal/commands/conformance"
	detectcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
	"github.com/leji-org/leji/packages/sdk-go/internal/writeplan"
)

// helpGolden reads one committed help golden: the byte oracle all three SDKs
// render against.
func helpGolden(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repoRoot(t), "fixtures", "help-goldens", name))
	if err != nil {
		t.Fatalf("help golden %s: %v", name, err)
	}
	return string(data)
}

func goldenName(command string) string {
	return strings.ReplaceAll(command, " ", "-") + ".txt"
}

// hasDash reports U+2013 or U+2014: the house rule is that no line the CLI prints
// carries either.
func hasDash(s string) bool {
	return strings.ContainsAny(s, "–—")
}

// --- cli.json integrity: the grouping four consumers read ---------------------

func TestCliSpecGroupsAreWellFormed(t *testing.T) {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, g := range spec.Groups {
		if ids[g.ID] {
			t.Fatalf("duplicate group id %q", g.ID)
		}
		if g.Title == "" {
			t.Fatalf("group %q has no title", g.ID)
		}
		ids[g.ID] = true
	}
	names := map[string]*schemas.CliCommand{}
	for i := range spec.Commands {
		names[spec.Commands[i].Name] = &spec.Commands[i]
	}
	for _, c := range spec.Commands {
		if !ids[c.Group] {
			t.Fatalf("%s names group %q, which is not declared", c.Name, c.Group)
		}
		if c.AliasOf == "" {
			continue
		}
		primary, ok := names[c.AliasOf]
		if !ok {
			t.Fatalf("%s aliases %q, which is not a command", c.Name, c.AliasOf)
		}
		if primary.AliasOf != "" {
			t.Fatalf("%s aliases %q, which is itself an alias", c.Name, c.AliasOf)
		}
	}
}

// --- the wrapper --------------------------------------------------------------

func TestWrapCollapsesHangsAndKeepsLongTokensWhole(t *testing.T) {
	cases := []struct {
		text                           string
		width, indentFirst, indentRest int
		want                           []string
	}{
		{"  one   two  ", 20, 0, 0, []string{"one two"}},
		{"", 20, 0, 0, nil},
		{"alpha beta gamma delta", 16, 0, 3, []string{"alpha beta gamma", "   delta"}},
		{"alpha beta gamma delta", 16, 0, 8, []string{"alpha beta gamma", "        delta"}},
		// A token wider than the line takes a line of its own rather than being
		// split: a URL or a flag spelling stays copyable.
		{"see https://leji.org/cli/#mounts-update-pin now", 20, 0, 3,
			[]string{"see", "   https://leji.org/cli/#mounts-update-pin", "   now"}},
	}
	for _, c := range cases {
		if got := wrap(c.text, c.width, c.indentFirst, c.indentRest); !reflect.DeepEqual(got, c.want) {
			t.Fatalf("wrap(%q) = %q, want %q", c.text, got, c.want)
		}
	}
}

func TestTopLevelUsageGoesThroughTheWrapper(t *testing.T) {
	// No current command is long enough to wrap this line, so the contract is pinned on
	// a vector instead: every emitted field passes the wrapper, never just the ones the
	// data happens to overflow today.
	usage := "Usage: leji mounts update-pin <name> [--to <oid>] [--allow-non-fast-forward] " +
		"[--fetch] [--dry-run] [--root <dir>] [--json]"
	got := strings.Join(wrap(usage, 80, 0, 7), "\n") + "\n"
	if want := helpGolden(t, "wrap-long-usage.txt"); got != want {
		t.Fatalf("long usage vector\n got: %q\nwant: %q", got, want)
	}
	if !strings.Contains(BuildUsage(), "\nUsage: leji <command> [options]\n") {
		t.Fatal("top-level help does not carry the usage line")
	}
}

func TestOverlongLabelTakesItsOwnLine(t *testing.T) {
	label := "--allow-non-fast-forward-with-a-very-long-spelling <oid>"
	summary := "Permit a target that is not a descendant of the current pin, in the one " +
		"spelling long enough to outgrow its column."
	got := strings.Join(helpRow(label, 23, summary), "\n") + "\n"
	if want := helpGolden(t, "row-overlong-label.txt"); got != want {
		t.Fatalf("overlong label vector\n got: %q\nwant: %q", got, want)
	}
	// The clamp is what makes an overlong label reachable: past 27 characters the flag
	// outgrows its own column.
	if col := optionColumn([]schemas.CliOption{{Flags: label}}); col != 33 {
		t.Fatalf("optionColumn = %d, want 33", col)
	}
	// A label that exactly fills the column would leave no gap, so it takes the line too.
	want := []string{"   --exactly-here", "                 summary"}
	if got := helpRow("--exactly-here", 17, "summary"); !reflect.DeepEqual(got, want) {
		t.Fatalf("exact-fit row = %q, want %q", got, want)
	}
}

func TestRowPadsByCodePoints(t *testing.T) {
	// Two U+1F600 in the label: padding by UTF-16 units (or bytes) leaves the row short
	// and misaligns every summary in the block.
	label := "--emoji-\U0001F600\U0001F600 <value>"
	summary := "A flag carrying astral characters, so a column padded in UTF-16 units " +
		"misaligns this row by two."
	got := strings.Join(helpRow(label, 23, summary), "\n") + "\n"
	if want := helpGolden(t, "row-non-bmp.txt"); got != want {
		t.Fatalf("non-BMP row vector\n got: %q\nwant: %q", got, want)
	}
}

func TestEveryLabelClassResolvesABoundedColumn(t *testing.T) {
	opt := func(flags ...string) int {
		options := make([]schemas.CliOption, len(flags))
		for i, f := range flags {
			options[i] = schemas.CliOption{Flags: f}
		}
		return optionColumn(options)
	}
	name := func(names ...string) int {
		commands := make([]schemas.CliCommand, len(names))
		for i, n := range names {
			commands[i] = schemas.CliCommand{Name: n}
		}
		return nameColumn(commands)
	}
	code := func(codes ...string) int {
		exits := make([]schemas.CliExitCode, len(codes))
		for i, c := range codes {
			exits[i] = schemas.CliExitCode{Code: json.Number(c)}
		}
		return exitCodeColumn(exits)
	}
	cases := []struct {
		got, want int
		what      string
	}{
		{opt("--json"), 23, "option floor"},
		{opt("--a-flag-of-thirty-plus-characters <value>"), 33, "option ceiling"},
		{name("leji"), 15, "name floor"},
		{name("a-command-name-long-enough-to-outgrow-its-bounded-column"), 33, "name ceiling"},
		{code("0"), 6, "exit-code floor"},
		{code("0", "127"), 8, "exit-code widening"},
		// Code points, not bytes: an astral label sizes its column by what it prints.
		{opt("--emoji-\U0001F600\U0001F600 <value>"), 24, "astral option label"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Fatalf("%s column = %d, want %d", c.what, c.got, c.want)
		}
	}
}

func TestBoundsHoldThroughTheRenderers(t *testing.T) {
	// Rendered, not just computed: a bound the column helper honors and the renderer
	// bypasses is exactly the defect this pins. The spec pushes every class past its
	// bound at once.
	raw, err := os.ReadFile(filepath.Join(repoRoot(t), "fixtures", "help-goldens", "bounds-spec.json"))
	if err != nil {
		t.Fatal(err)
	}
	var spec schemas.CliSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(helpGolden(t, "bounds-usage.txt"), "{{version}}", schemas.SDKVersion, 1)
	if got := buildUsage(spec) + "\n"; got != want {
		t.Fatalf("synthetic top-level help\n got:\n%s\nwant:\n%s", got, want)
	}
	long := "a-command-name-long-enough-to-outgrow-its-bounded-column"
	help, ok := buildCommandHelp(long, spec)
	if !ok {
		t.Fatal("the synthetic command must render help")
	}
	if got, w := help+"\n", helpGolden(t, "bounds-command.txt"); got != w {
		t.Fatalf("synthetic command help\n got:\n%s\nwant:\n%s", got, w)
	}
}

func TestWrapMeasuresCodePointsNotBytes(t *testing.T) {
	// Documented in fixtures/README.md: four U+1F600, two spaces, three ASCII words,
	// width 20, first line indented 0 and continuations 3. Measuring the emoji run in
	// bytes (or UTF-16 units) breaks the line one word early.
	input := "\U0001F600\U0001F600\U0001F600\U0001F600  alphabet six666 tail"
	got := strings.Join(wrap(input, 20, 0, 3), "\n") + "\n"
	if want := helpGolden(t, "wrap-non-bmp.txt"); got != want {
		t.Fatalf("wrap vector\n got: %q\nwant: %q", got, want)
	}
}

// --- the goldens --------------------------------------------------------------

func TestHelpGoldens(t *testing.T) {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(helpGolden(t, "usage.txt"), "{{version}}", schemas.SDKVersion, 1)
	if got := BuildUsage() + "\n"; got != want {
		t.Fatalf("leji --help does not match usage.txt\n got:\n%s\nwant:\n%s", got, want)
	}
	expected := []string{
		"usage.txt", "wrap-non-bmp.txt", "wrap-long-usage.txt", "row-overlong-label.txt",
		"row-non-bmp.txt", "bounds-spec.json", "bounds-usage.txt", "bounds-command.txt",
	}
	for _, c := range spec.Commands {
		help, ok := BuildCommandHelp(c.Name)
		if !ok {
			t.Fatalf("%s must render help", c.Name)
		}
		if got, w := help+"\n", helpGolden(t, goldenName(c.Name)); got != w {
			t.Fatalf("%s --help does not match %s\n got:\n%s\nwant:\n%s", c.Name, goldenName(c.Name), got, w)
		}
		expected = append(expected, goldenName(c.Name))
	}
	// And nothing committed is orphaned: every golden is one of the surfaces above.
	entries, err := os.ReadDir(filepath.Join(repoRoot(t), "fixtures", "help-goldens"))
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, e := range entries {
		found = append(found, e.Name())
	}
	sort.Strings(found)
	sort.Strings(expected)
	if !reflect.DeepEqual(found, expected) {
		t.Fatalf("help-goldens holds %v, want %v", found, expected)
	}
}

func TestCommandHelpListsOwnOptionsAndPointsAtGlobals(t *testing.T) {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range spec.Commands {
		help, _ := BuildCommandHelp(c.Name)
		if !strings.Contains(help, "\nGlobal options: see leji --help.\n") {
			t.Fatalf("%s help does not point at the globals", c.Name)
		}
		for _, g := range spec.GlobalOptions {
			if strings.Contains(help, "   "+g.Flags) {
				t.Fatalf("%s help repeats the global %s", c.Name, g.Flags)
			}
		}
		for _, o := range c.Options {
			if !strings.Contains(help, "   "+o.Flags) {
				t.Fatalf("%s help does not list %s", c.Name, o.Flags)
			}
		}
		// Examples are commands to copy, never prose: they are printed as authored,
		// so the width contract covers everything above them.
		prose, _, _ := strings.Cut(help, "\nExamples:\n")
		for _, line := range strings.Split(prose, "\n") {
			if utf8.RuneCountInString(line) > 80 {
				t.Fatalf("%s help line exceeds 80 code points: %q", c.Name, line)
			}
		}
	}
	for _, line := range strings.Split(BuildUsage(), "\n") {
		if utf8.RuneCountInString(line) > 80 {
			t.Fatalf("top-level help line exceeds 80 code points: %q", line)
		}
	}
}

// --- the em-dash house rule, checked on the bytes the CLI prints --------------

func TestHelpOutputCarriesNoDash(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join(repoRoot(t), "fixtures", "help-goldens"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if hasDash(helpGolden(t, e.Name())) {
			t.Fatalf("%s carries an em or en dash", e.Name())
		}
	}
}

func TestCliJSONCarriesNoDash(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(repoRoot(t), "packages", "sdk-go", "internal", "assets", "cli.json"))
	if err != nil {
		t.Fatal(err)
	}
	if hasDash(string(data)) {
		t.Fatal("cli.json carries an em or en dash")
	}
}

func TestProseBranchesCarryNoDash(t *testing.T) {
	// detect's host lines: synthetic hosts, so the branch runs wherever the suite does.
	rendered := detectcmd.RenderDetect([]detect.DetectedHost{{
		ID:         "codex",
		Name:       "Codex CLI",
		Strength:   detect.Confirmed,
		OnPath:     true,
		InRepo:     true,
		UserConfig: false,
		Adapter:    "AGENTS.md",
	}}, ecosystem.Detect(t.TempDir()))
	if !strings.Contains(rendered, "Codex CLI: binary on PATH") {
		t.Fatalf("detect host line, got:\n%s", rendered)
	}
	if hasDash(rendered) {
		t.Fatalf("detect output carries a dash:\n%s", rendered)
	}

	// conformance --explain's blocker details, likewise: the detail branch needs a
	// blocker that carries one, which a passing layer does not produce.
	explain := conformance.RenderExplain(conformance.Result{
		ClaimedLevel:  "core",
		VerifiedLevel: "core",
		Items: []conformance.ChecklistItem{{
			ID:          "index-current",
			Level:       "indexed",
			Description: "a generated context index, current with the tree",
			Status:      conformance.Fail,
			Detail:      "the stored index is stale",
		}},
	})
	if !strings.Contains(explain, "- a generated context index, current with the tree: the stored index is stale") {
		t.Fatalf("explain detail line, got:\n%s", explain)
	}
	if hasDash(explain) {
		t.Fatalf("explain output carries a dash:\n%s", explain)
	}

	// The conformance checklist's own detail column, from a real run.
	example := filepath.Join(repoRoot(t), "examples", "monorepo")
	_, out, _ := captureRun(t, []string{"conformance", "--root", example})
	if !strings.Contains(out, "freshness horizons are declared and checked (report-only is acceptable): ") {
		t.Fatalf("checklist detail column, got:\n%s", out)
	}
	if hasDash(out) {
		t.Fatalf("conformance output carries a dash:\n%s", out)
	}

	// The write plan's read-only note is library data rather than a printed line, so
	// it is asserted where it is produced.
	plan := writeplan.Build(example, nil, []string{"README.md"}, nil)
	if plan[0].Note != "existing file, read-only input; Leji will not modify it" {
		t.Fatalf("write-plan note %q", plan[0].Note)
	}
}

// The unknown-command contract the help surface leans on: exit 2, the error, and
// the top-level usage, all on stderr.
func TestUnknownCommandPrintsUsageToStderr(t *testing.T) {
	code, _, errs := captureRun(t, []string{"frobnicate"})
	if code != 2 {
		t.Fatalf("unknown command exit %d, want 2", code)
	}
	if !strings.Contains(errs, `unknown command "frobnicate"`) {
		t.Fatalf("stderr %q does not name the unknown command", errs)
	}
	if !strings.Contains(errs, "Usage: leji") {
		t.Fatalf("stderr %q does not carry the top-level usage", errs)
	}
}
