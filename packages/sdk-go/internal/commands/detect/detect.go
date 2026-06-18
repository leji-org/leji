// Package detectcmd renders the human-readable detection report, mirroring the
// Node SDK's commands/detect.ts (detectLayer + renderDetect).
package detectcmd

import (
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
)

// DetectLayer returns the agent hosts available to this user, ranked.
func DetectLayer(root string) []detect.DetectedHost {
	return detect.DetectHosts(detect.Options{Root: root})
}

// RenderDetect produces the human-readable detection report.
func RenderDetect(hosts []detect.DetectedHost) string {
	if len(hosts) == 0 {
		return "No coding-agent hosts detected. Leji works without one; the onboarding brief still guides any agent you point at it."
	}
	lines := []string{"Detected agent hosts (strongest signal first):"}
	for _, h := range hosts {
		var sig []string
		if h.OnPath {
			sig = append(sig, "binary on PATH")
		}
		if h.InRepo {
			sig = append(sig, "config in repo")
		}
		if h.UserConfig {
			sig = append(sig, "user config")
		}
		signals := strings.Join(sig, ", ")
		adapter := "directory-style adapter (wiring deferred)"
		if h.Adapter != "" {
			adapter = "adapter " + h.Adapter
		}
		lines = append(lines, "   "+padEnd(string(h.Strength), 16)+" "+h.Name+" — "+signals+"; "+adapter)
	}
	lines = append(lines, "", "Wire one into a fresh layer with: leji init --agent <name>")
	return strings.Join(lines, "\n")
}

// padEnd right-pads s with spaces to at least width, matching JS String.padEnd.
func padEnd(s string, width int) string {
	if len(s) >= width {
		return s
	}
	return s + strings.Repeat(" ", width-len(s))
}
