package cli

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// Terminal help wraps at a fixed width, never the actual terminal's: help bytes
// are a shared contract across the three SDKs, so they may not depend on the
// environment. Mirrors HELP_WIDTH in index.ts.
const helpWidth = 80

// paragraphBreak splits a description into paragraphs, mirroring the TS
// `/\n[ \t]*\n/` split.
var paragraphBreak = regexp.MustCompile(`\n[ \t]*\n`)

// wrap is the one line-wrapper behind every terminal help surface, so the three
// SDKs emit the same bytes: whitespace runs collapse to one space, the first line
// is indented by indentFirst and every continuation by indentRest, and width is
// counted in RUNES, never bytes. A token that cannot fit the remaining width takes
// a line of its own, unbroken (URLs and flag spellings stay copyable). Empty text
// yields no lines. Mirrors wrap() in lib/text.ts.
func wrap(text string, width, indentFirst, indentRest int) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return nil
	}
	var lines []string
	indent := indentFirst
	current := ""
	for _, word := range words {
		room := width - indent - utf8.RuneCountInString(current)
		switch {
		case current == "":
			current = word
		case utf8.RuneCountInString(word)+1 <= room:
			current += " " + word
		default:
			lines = append(lines, strings.Repeat(" ", indent)+current)
			indent = indentRest
			current = word
		}
	}
	return append(lines, strings.Repeat(" ", indent)+current)
}

// helpRow renders one row of a two-column help block: a label on the left, its prose
// on the right, the prose hanging under itself at col. A label that would leave no gap
// before its summary — one at least as wide as the column, which the option column's
// clamp makes reachable — takes the line alone and its summary starts on the next line
// at the same column, so a long flag never concatenates into the text describing it.
// Mirrors helpRow() in lib/text.ts.
func helpRow(label string, col int, text string) []string {
	lines := wrap(text, helpWidth, col, col)
	if utf8.RuneCountInString(label) >= col-3 {
		head := "   " + label
		if len(lines) == 0 {
			return []string{head}
		}
		return append([]string{head}, lines...)
	}
	head := "   " + pad(label, col-3)
	if len(lines) == 0 {
		return []string{strings.TrimRight(head, " ")}
	}
	// Every wrapped line opens with `col` ASCII spaces, so trimming that many bytes
	// off the first one is exactly the indent.
	return append([]string{head + lines[0][col:]}, lines[1:]...)
}

// boundedColumn is where a two-column block's right column starts: the longest label
// plus a gap, kept inside a band so one long label cannot push every summary to the
// right edge, and measured in RUNES. Past the band's top the label outgrows the column
// and helpRow gives it its own line. Every dynamic label class in terminal help
// resolves its column here. Mirrors boundedColumn() in lib/text.ts.
func boundedColumn(labels []string, gap, min, max int) int {
	longest := 0
	for _, l := range labels {
		if n := utf8.RuneCountInString(l); n > longest {
			longest = n
		}
	}
	col := longest + gap
	if col < min {
		col = min
	}
	if col > max {
		col = max
	}
	return 3 + col
}

// optionColumn: option rows, top-level and per-command, flags plus 3, bounded [20, 30].
func optionColumn(options []schemas.CliOption) int {
	labels := make([]string, len(options))
	for i, o := range options {
		labels[i] = o.Flags
	}
	return boundedColumn(labels, 3, 20, 30)
}

// nameColumn: command and alias rows, the name plus 3, bounded [12, 30].
func nameColumn(commands []schemas.CliCommand) int {
	labels := make([]string, len(commands))
	for i, c := range commands {
		labels[i] = c.Name
	}
	return boundedColumn(labels, 3, 12, 30)
}

// exitCodeColumn: exit-code rows, the code plus 2 (digits, not words), bounded [3, 8].
func exitCodeColumn(codes []schemas.CliExitCode) int {
	labels := make([]string, len(codes))
	for i, e := range codes {
		labels[i] = e.Code.String()
	}
	return boundedColumn(labels, 2, 3, 8)
}

// BuildUsage renders the top-level terminal help from cli.json (so it cannot
// drift from the docs site): the commands by group, the global options, and the
// exit codes. Per-command options live in `leji <command> --help`. Mirrors
// renderUsage() in index.ts.
func BuildUsage() string {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		return "leji " + schemas.SDKVersion
	}
	return buildUsage(spec)
}

// buildUsage renders one spec, so the bounds can be exercised against a synthetic one.
func buildUsage(spec schemas.CliSpec) string {
	// Every emitted field goes through the wrapper, including the ones no current value
	// is long enough to overflow: a longer version string or group title must not be
	// what discovers that a line was never wrapped.
	out := wrap("leji "+schemas.SDKVersion+": reference CLI for the Leji specification (spec line "+
		strings.Join(schemas.SupportedLines, ", ")+")", helpWidth, 0, 3)
	out = append(out, "")
	out = append(out, wrap("Usage: "+spec.Usage, helpWidth, 0, 7)...)

	// One name column across every group, so the summaries line up down the whole
	// list rather than jumping per section.
	cmdCol := nameColumn(spec.Commands)
	for _, g := range spec.Groups {
		out = append(out, "")
		out = append(out, wrap(g.Title+":", helpWidth, 0, 0)...)
		for _, c := range spec.Commands {
			if c.Group != g.ID || c.AliasOf != "" {
				continue
			}
			out = append(out, helpRow(c.Name, cmdCol, c.Summary)...)
			// An alias earns a line under its primary, not a row of its own: it is
			// the same command, and repeating the summary reads as a second one. It
			// keeps the name column, so the right-hand column stays straight down
			// the whole list.
			for _, a := range spec.Commands {
				if a.AliasOf == c.Name {
					out = append(out, helpRow(a.Name, cmdCol, "(alias of "+c.Name+")")...)
				}
			}
		}
	}

	optCol := optionColumn(spec.GlobalOptions)
	out = append(out, "", "Options:")
	for _, o := range spec.GlobalOptions {
		out = append(out, helpRow(o.Flags, optCol, o.Summary)...)
	}

	// The meaning hangs under itself, like every other two-column block here, so a
	// continuation line is never mistaken for another code.
	codeCol := exitCodeColumn(spec.ExitCodes)
	out = append(out, "", "Exit codes:")
	for _, e := range spec.ExitCodes {
		out = append(out, helpRow(e.Code.String(), codeCol, e.Meaning)...)
	}

	out = append(out,
		"",
		"Run `leji <command> --help` for a command and its options.",
		"Full reference: https://leji.org/cli/",
	)
	return strings.Join(out, "\n")
}

// BuildCommandHelp renders per-command help from cli.json: this command's own
// options only, with the globals one pointer away. The bool is false when name is
// not a documented command, so the caller falls back to top-level usage. Mirrors
// renderCommandHelp() in index.ts.
func BuildCommandHelp(name string) (string, bool) {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		return "", false
	}
	return buildCommandHelp(name, spec)
}

// buildCommandHelp renders one spec, so the bounds can be exercised against a
// synthetic one.
func buildCommandHelp(name string, spec schemas.CliSpec) (string, bool) {
	var cmd *schemas.CliCommand
	for i := range spec.Commands {
		if spec.Commands[i].Name == name {
			cmd = &spec.Commands[i]
			break
		}
	}
	if cmd == nil {
		return "", false
	}
	out := wrap("leji "+cmd.Name+": "+cmd.Summary, helpWidth, 0, 3)
	out = append(out, "")
	out = append(out, wrap("Usage: "+cmd.Usage, helpWidth, 0, 7)...)
	for _, para := range paragraphBreak.Split(cmd.Description, -1) {
		out = append(out, "")
		out = append(out, wrap(para, helpWidth, 0, 0)...)
	}
	if len(cmd.Details) > 0 {
		out = append(out, "", "Details:")
		for _, d := range cmd.Details {
			out = append(out, wrap("- "+d, helpWidth, 3, 5)...)
		}
	}
	if len(cmd.Options) > 0 {
		optCol := optionColumn(cmd.Options)
		out = append(out, "", "Options:")
		for _, o := range cmd.Options {
			out = append(out, helpRow(o.Flags, optCol, o.Summary)...)
		}
	}
	out = append(out, "", "Global options: see leji --help.")
	if len(cmd.Examples) > 0 {
		out = append(out, "", "Examples:")
		for _, e := range cmd.Examples {
			out = append(out, "   "+e)
		}
	}
	out = append(out, "", "Full reference: https://leji.org/cli/")
	return strings.Join(out, "\n"), true
}

// pad right-pads to a column measured in runes, not bytes: a multibyte
// character (e.g. the ellipsis in "-- <host flags…>") is one column wide, and
// counting its bytes would over-pad every other row. Mirrors Node and Python.
func pad(s string, width int) string {
	if utf8.RuneCountInString(s) >= width {
		return s
	}
	return s + strings.Repeat(" ", width-utf8.RuneCountInString(s))
}
