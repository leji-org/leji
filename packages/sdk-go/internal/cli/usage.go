package cli

import (
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

// BuildUsage renders the terminal help from cli.json so it cannot drift from
// the docs site. Mirrors buildUsage() in index.ts.
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
		if len(c.Name) > cmdWidth {
			cmdWidth = len(c.Name)
		}
	}
	cmdWidth += 3
	for _, c := range spec.Commands {
		out = append(out, "   "+pad(c.Name, cmdWidth)+c.Summary)
	}

	type scopedOption struct {
		flags, summary, scope string
	}
	var cmdOptions []scopedOption
	for _, c := range spec.Commands {
		for _, o := range c.Options {
			cmdOptions = append(cmdOptions, scopedOption{o.Flags, o.Summary, c.Name})
		}
	}
	optWidth := 0
	for _, o := range spec.GlobalOptions {
		if len(o.Flags) > optWidth {
			optWidth = len(o.Flags)
		}
	}
	for _, o := range cmdOptions {
		if len(o.flags) > optWidth {
			optWidth = len(o.flags)
		}
	}
	optWidth += 3
	out = append(out, "", "Options:")
	for _, o := range spec.GlobalOptions {
		out = append(out, "   "+pad(o.Flags, optWidth)+o.Summary)
	}
	for _, o := range cmdOptions {
		out = append(out, "   "+pad(o.flags, optWidth)+o.scope+": "+o.summary)
	}

	out = append(out, "", "Full reference: https://leji.org/cli/")
	return strings.Join(out, "\n")
}

func pad(s string, width int) string {
	if len(s) >= width {
		return s
	}
	return s + strings.Repeat(" ", width-len(s))
}
