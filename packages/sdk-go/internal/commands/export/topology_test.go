package export

// The structural prong of the no-network guarantee: the export package's transitive
// import set contains no networking package. It catches the static introduction of a
// network dependency and nothing else — dynamic side doors are covered by the offline
// CI leg, and the subprocess claim (git and nothing else) by the reference suite's spy.

import (
	"os/exec"
	"strings"
	"testing"
)

// networkPackages are the standard library's networking packages: the ones that open
// a socket, or exist only to serve one. `net/url` and `net/netip` are deliberately
// NOT here — they parse URLs and IP addresses and dial nothing, and the export graph
// reaches both through the vendored JSON-schema library's format checks. The
// reference implementation draws the same line (it bans node:net/http/https/dgram
// and not node:url).
var networkPackages = []string{"net", "net/http", "net/rpc", "net/smtp", "net/textproto", "crypto/tls"}

// deps is `go list -deps` for one package path, relative to this directory.
func deps(t *testing.T, pkg string) map[string]bool {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain on PATH; the import graph cannot be listed")
	}
	out, err := exec.Command("go", "list", "-deps", pkg).CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps %s: %v\n%s", pkg, err, out)
	}
	set := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			set[line] = true
		}
	}
	return set
}

func TestExportGraphReachesNoNetworkPackage(t *testing.T) {
	graph := deps(t, ".")
	// The graph is real: the export pulls in the chrome generation and the layer
	// libraries, so a truncated or empty listing cannot pass this test by accident.
	const mod = "github.com/leji-org/leji/packages/sdk-go/internal/"
	if !graph[mod+"commands/viewer"] {
		t.Fatalf("the graph must reach the generator (%d packages listed)", len(graph))
	}
	if !graph[mod+"renderlint"] {
		t.Fatal("the graph must reach the rendering lint")
	}
	if graph[mod+"commands/serve"] {
		t.Fatal("the export must never reach the serve package")
	}
	for _, pkg := range networkPackages {
		if graph[pkg] {
			t.Fatalf("the export package graph imports %s", pkg)
		}
	}
	for pkg := range graph {
		if strings.HasPrefix(pkg, "net/http") {
			t.Fatalf("the export package graph imports %s", pkg)
		}
	}

	// Positive control: the serve package DOES reach net/http, so the assertions above
	// are testing a real property rather than a lister that sees nothing.
	serve := deps(t, "../serve")
	if !serve["net/http"] || !serve["net"] {
		t.Fatal("the serve package graph must import net/http")
	}
}
