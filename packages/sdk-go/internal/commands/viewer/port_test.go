package viewer

import (
	"testing"

	"github.com/leji-org/leji/packages/sdk-go/internal/manifest"
)

func TestResolveViewerPort(t *testing.T) {
	flag := 1234
	if got := ResolveViewerPort(&manifest.Manifest{}, &flag); got != 1234 {
		t.Fatalf("flag port: got %d, want 1234", got)
	}
	mp := 4321
	if got := ResolveViewerPort(&manifest.Manifest{Viewer: &manifest.Viewer{Port: &mp}}, nil); got != 4321 {
		t.Fatalf("manifest port: got %d, want 4321", got)
	}
	if got := ResolveViewerPort(&manifest.Manifest{}, nil); got != 5354 {
		t.Fatalf("default port: got %d, want 5354", got)
	}
}
