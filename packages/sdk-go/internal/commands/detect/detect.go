// Package detectcmd renders the human-readable agent-host detection report.
package detectcmd

import (
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/ecosystem"
)

// DetectLayer returns the agent hosts available to this user, ranked.
func DetectLayer(root string) []detect.DetectedHost {
	return detect.DetectHosts(detect.Options{Root: root})
}

func RenderDetect(hosts []detect.DetectedHost, eco ecosystem.Report) string {
	ecoLine := ecosystem.RenderLine(eco)
	if len(hosts) == 0 {
		return "No coding-agent hosts detected. Leji works without one; the onboarding brief still guides any agent you point at it." +
			"\n\n" + ecoLine
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
		lines = append(lines, "   "+padEnd(string(h.Strength), 16)+" "+h.Name+": "+signals+"; "+adapter)
	}
	// One line about the repository's own ecosystem: what would declare and run the
	// CLI here. The full offer block belongs to init/adopt, which can act on it.
	lines = append(lines, "", ecoLine)
	// --agent names the host Leji launches, and only claude-code and codex accept
	// an inline prompt; suggesting `--agent <name>` for every detected host offered
	// a command the flag rejects.
	lines = append(lines, "",
		"--agent takes a launchable host, claude-code or codex: leji init --agent claude-code, leji start --agent codex.",
		"Any other host above enters the layer through its vendor-file redirect.")
	return strings.Join(lines, "\n")
}

// padEnd right-pads s with spaces to at least width.
func padEnd(s string, width int) string {
	if len(s) >= width {
		return s
	}
	return s + strings.Repeat(" ", width-len(s))
}
