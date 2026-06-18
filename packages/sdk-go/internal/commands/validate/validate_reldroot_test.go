package validate_test

import (
	"io"
	"os"
	"testing"

	initcmd "github.com/leji-org/leji/packages/sdk-go/internal/commands/init"
	"github.com/leji-org/leji/packages/sdk-go/internal/commands/validate"
	"github.com/leji-org/leji/packages/sdk-go/internal/findings"
)

// Regression for the relative-root walk bug: validating with root "." while the
// process cwd is the layer directory must produce the same findings as an
// absolute root. Before the fix, fsx.ResolvesUnder compared an absolute
// realRoot against a relative target, so WalkMd excluded every file and every
// mapped category reported a spurious category-empty error.
func TestValidateLayerRelativeRoot(t *testing.T) {
	dir := t.TempDir()
	if _, err := initcmd.InitLayer(initcmd.Options{Dir: dir, Yes: true, Out: io.Discard}); err != nil {
		t.Fatalf("init core layer: %v", err)
	}

	prev, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer func() { _ = os.Chdir(prev) }()

	res := validate.ValidateLayer(".", false)

	for _, f := range res.Findings {
		if f.Severity == findings.Error {
			t.Fatalf("relative-root validate produced an error finding %q: %s (path %q)", f.Rule, f.Message, f.Path)
		}
	}
}
