package cli

// `leji badge` is offline by construction, and the CLI surface is where that is
// enforced: the allow-list it rejects against is read from cli.json, so a
// destination parameter cannot reach the command without failing here, and the help
// bytes a person reads describe no network operation.

import (
	"sort"
	"strings"
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/schemas"
)

func TestBadgeTakesNoDestinationFlagAndItsHelpNamesNoNetwork(t *testing.T) {
	dir := t.TempDir()
	for _, argv := range [][]string{
		{"badge", "--endpoint", "x"},
		{"badge", "--url", "https://example.invalid"},
		{"badge", "--host", "example.invalid"},
		{"badge", "--token", "secret"},
		{"badge", "--federation", "verify"},
	} {
		code, _, _ := captureRun(t, append(append([]string{}, argv...), "--root", dir))
		if code != 2 {
			t.Fatalf("%v must be a usage error, got %d", argv, code)
		}
	}
	// The accept side of the same guarantee: the allow-list is exactly the globals
	// plus `--out`.
	spec, err := schemas.LoadCliSpec()
	if err != nil {
		t.Fatal(err)
	}
	var cmd *schemas.CliCommand
	for i := range spec.Commands {
		if spec.Commands[i].Name == "badge" {
			cmd = &spec.Commands[i]
			break
		}
	}
	if cmd == nil {
		t.Fatal("badge must be a documented command")
	}
	var allowed []string
	for _, o := range append(append([]schemas.CliOption{}, spec.GlobalOptions...), cmd.Options...) {
		allowed = append(allowed, flagTokens(o.Flags)...)
	}
	sort.Strings(allowed)
	want := []string{"--help", "--json", "--out", "--root", "--version", "-h", "-v"}
	if !sameTree(allowed, want) {
		t.Fatalf("badge accepts %v, want %v", allowed, want)
	}
	help, ok := BuildCommandHelp("badge")
	if !ok {
		t.Fatal("badge must render help")
	}
	lower := strings.ToLower(help)
	for _, word := range []string{"endpoint", "token", "upload", "api key", "s3://", "host", "url",
		"server", "network", "browser", "publish", "remote"} {
		if strings.Contains(lower, word) {
			t.Fatalf("the badge help text carries %q", word)
		}
	}
}
