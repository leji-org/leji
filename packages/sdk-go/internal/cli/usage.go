package cli

import (
	"strings"
	"unicode/utf8"

	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// BuildUsage renders the top-level terminal help from cli.json (so it cannot
// drift from the docs site). Lists commands and global options only; per-command
// options live in `leji <command> --help`. Mirrors renderUsage() in index.ts.
func BuildUsage() string {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		return "leji " + schemas.SDKVersion
	}
	out := []string{
		"leji " + schemas.SDKVersion + ": reference CLI for the Leji specification (spec line " +
			strings.Join(schemas.SupportedLines, ", ") + ")",
		"",
		"Usage: " + spec.Usage,
		"",
		"Commands:",
	}
	cmdWidth := 0
	for _, c := range spec.Commands {
		if utf8.RuneCountInString(c.Name) > cmdWidth {
			cmdWidth = utf8.RuneCountInString(c.Name)
		}
	}
	cmdWidth += 3
	for _, c := range spec.Commands {
		out = append(out, "   "+pad(c.Name, cmdWidth)+c.Summary)
	}

	optWidth := 0
	for _, o := range spec.GlobalOptions {
		if utf8.RuneCountInString(o.Flags) > optWidth {
			optWidth = utf8.RuneCountInString(o.Flags)
		}
	}
	optWidth += 3
	out = append(out, "", "Options:")
	for _, o := range spec.GlobalOptions {
		out = append(out, "   "+pad(o.Flags, optWidth)+o.Summary)
	}

	out = append(out,
		"",
		"Run `leji <command> --help` for a command and its options.",
		"Full reference: https://leji.org/cli/",
	)
	return strings.Join(out, "\n")
}

// BuildCommandHelp renders per-command help from cli.json. The bool is false
// when name is not a documented command, so the caller falls back to top-level
// usage. Mirrors renderCommandHelp() in index.ts.
func BuildCommandHelp(name string) (string, bool) {
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		return "", false
	}
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
	out := []string{
		"leji " + cmd.Name + ": " + cmd.Summary,
		"",
		"Usage: " + cmd.Usage,
		"",
		cmd.Description,
	}
	if len(cmd.Details) > 0 {
		out = append(out, "", "Details:")
		for _, d := range cmd.Details {
			out = append(out, "   - "+d)
		}
	}
	opts := append(append([]schemas.CliOption{}, spec.GlobalOptions...), cmd.Options...)
	optWidth := 0
	for _, o := range opts {
		if utf8.RuneCountInString(o.Flags) > optWidth {
			optWidth = utf8.RuneCountInString(o.Flags)
		}
	}
	optWidth += 3
	out = append(out, "", "Options:")
	for _, o := range opts {
		summary := o.Summary
		if summary == "" {
			// Mirrors Node byte-for-byte: an option that declares only a
			// description (the mounts options) renders `${o.summary}` as the
			// literal string "undefined" in the template.
			summary = "undefined"
		}
		out = append(out, "   "+pad(o.Flags, optWidth)+summary)
	}
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
