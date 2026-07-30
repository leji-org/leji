// Package detect does best-effort, read-only detection of available coding-agent
// hosts, ranked by signal strength. Mirrors the Node SDK's lib/detect.ts. Never
// launches or writes anything.
package detect

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// HostSpec is a coding-agent host Leji knows how to wire. Adapter is the vendor
// entrypoint file (a one-line redirect to the boot profile); empty Adapter marks
// a directory-style host (Cursor, Windsurf) whose wiring is deferred.
type HostSpec struct {
	ID        string
	Name      string
	Bins      []string
	RepoFiles []string
	UserDirs  []string
	Adapter   string
	// McpAdd is the argv (after the host bin) that registers the local Leji MCP
	// server, or nil for a host with no known `mcp add` command. Run from the layer
	// root so a project-scoped write (Claude's `.mcp.json`) lands in the right repo.
	McpAdd []string
	// McpCheck reports whether the Leji MCP server is already registered (exit 0 =
	// present); used to skip the install offer when it's already there.
	McpCheck []string
}

// MCPServerName and MCPPackage are the registered server name and the npm package
// behind the local Leji MCP server.
const (
	MCPServerName = "leji"
	MCPPackage    = "@leji-org/mcp"
)

// PortableAdapter is the portable discovery adapter. `AGENTS.md` is a cross-host
// entrypoint convention (stewarded by the Linux Foundation's Agentic AI
// Foundation, read natively by Codex, Copilot, Cursor, Gemini CLI, and others),
// not any one vendor's file, so `init`/`adopt` generate it as the default
// pointer-only redirect to the boot profile. Hosts with their own entrypoint
// (`CLAUDE.md`) are wired individually via `--wire-adapters` / `--agent`.
const PortableAdapter = "AGENTS.md"

// HostSpecs are the six hosts Leji knows, in spec order.
var HostSpecs = []HostSpec{
	{
		ID:        "claude-code",
		Name:      "Claude Code",
		Bins:      []string{"claude"},
		RepoFiles: []string{"CLAUDE.md"},
		UserDirs:  []string{".claude", ".config/claude"},
		Adapter:   "CLAUDE.md",
		// Project scope writes a committed `.mcp.json` so the whole team gets the server.
		McpAdd:   []string{"mcp", "add", MCPServerName, "--scope", "project", "--", "npx", "-y", MCPPackage},
		McpCheck: []string{"mcp", "get", MCPServerName},
	},
	{
		ID:   "codex",
		Name: "Codex",
		Bins: []string{"codex"},
		// AGENTS.md is a detection signal for Codex but is not Codex's file: it is
		// the portable adapter (PortableAdapter) many hosts read.
		RepoFiles: []string{"AGENTS.md"},
		UserDirs:  []string{".codex"},
		Adapter:   "AGENTS.md",
		// Codex registers at user level (~/.codex/config.toml); no project scope.
		McpAdd:   []string{"mcp", "add", MCPServerName, "--", "npx", "-y", MCPPackage},
		McpCheck: []string{"mcp", "get", MCPServerName},
	},
	{
		ID:        "copilot",
		Name:      "GitHub Copilot",
		Bins:      []string{"gh", "code"},
		RepoFiles: []string{".github/copilot-instructions.md"},
		UserDirs:  []string{},
		Adapter:   ".github/copilot-instructions.md",
	},
	{
		ID:        "gemini",
		Name:      "Gemini CLI",
		Bins:      []string{"gemini"},
		RepoFiles: []string{"GEMINI.md", ".gemini"},
		UserDirs:  []string{".gemini"},
		Adapter:   "GEMINI.md",
	},
	{
		ID:        "cursor",
		Name:      "Cursor",
		Bins:      []string{"cursor"},
		RepoFiles: []string{".cursor/rules", ".cursorrules"},
		UserDirs:  []string{},
		Adapter:   ".cursor/rules/leji.md",
	},
	{
		ID:        "windsurf",
		Name:      "Windsurf",
		Bins:      []string{"windsurf"},
		RepoFiles: []string{".windsurf/rules", ".windsurfrules"},
		UserDirs:  []string{},
		Adapter:   ".windsurf/rules/leji.md",
	},
}

// hostAliases map common user-typed names to a host id.
var hostAliases = map[string]string{
	"claude":         "claude-code",
	"claude-code":    "claude-code",
	"codex":          "codex",
	"copilot":        "copilot",
	"github-copilot": "copilot",
	"gemini":         "gemini",
	"cursor":         "cursor",
	"windsurf":       "windsurf",
}

// ResolveHostId returns the canonical host id for a name/alias, or "" when unknown.
func ResolveHostId(name string) string {
	return hostAliases[strings.ToLower(name)]
}

// Strength is a signal strength, strongest first: runnable binary > repo config
// file > user-level config directory.
type Strength string

const (
	Confirmed       Strength = "confirmed"
	ProjectPresent  Strength = "project-present"
	InstalledLikely Strength = "installed-likely"
)

var strengthRank = map[Strength]int{
	Confirmed:       0,
	ProjectPresent:  1,
	InstalledLikely: 2,
}

// DetectedHost is one host found, with the signals that surfaced it.
type DetectedHost struct {
	ID         string
	Name       string
	Strength   Strength
	OnPath     bool
	InRepo     bool
	UserConfig bool
	Adapter    string
}

// Options configures DetectHosts. Probes are injectable so the result is
// deterministic under test. Zero values fall back to the live environment.
type Options struct {
	Root string
	// Env overrides the process environment used for the PATH scan; nil uses os.Environ.
	Env map[string]string
	// HasEnv signals Env was explicitly provided (so an empty map means "no PATH").
	HasEnv bool
	// Homedir overrides the user home directory; "" uses os.UserHomeDir.
	Homedir string
	// Platform overrides the OS for PATH-separator/extension choices; "" uses runtime.GOOS.
	Platform string
	// HasBinary is an injectable PATH probe; nil defaults to a manual scan of PATH.
	HasBinary func(bin string) bool
}

// onPathFactory builds a dependency-free `which`: scans PATH for an executable,
// OS-aware on separators and extensions.
func onPathFactory(env map[string]string, platform string) func(bin string) bool {
	raw := env["PATH"]
	if raw == "" {
		raw = env["Path"]
	}
	sep := ":"
	exts := []string{""}
	if platform == "windows" {
		sep = ";"
		exts = []string{".exe", ".cmd", ".bat", ""}
	}
	var dirs []string
	for _, d := range strings.Split(raw, sep) {
		if d != "" {
			dirs = append(dirs, d)
		}
	}
	return func(bin string) bool {
		for _, d := range dirs {
			for _, ext := range exts {
				info, err := os.Stat(filepath.Join(d, bin+ext))
				if err != nil || !info.Mode().IsRegular() {
					continue
				}
				// On POSIX a "confirmed" host means a runnable binary: require an
				// executable bit. On Windows the extension implies executability.
				if platform == "windows" || info.Mode()&0o111 != 0 {
					return true
				}
			}
		}
		return false
	}
}

func envFromOS() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			out[kv[:i]] = kv[i+1:]
		}
	}
	return out
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// DetectHosts returns available hosts ranked by strength (confirmed >
// project-present > installed-likely), ties broken by id.
func DetectHosts(opts Options) []DetectedHost {
	platform := opts.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	home := opts.Homedir
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	hasBinary := opts.HasBinary
	if hasBinary == nil {
		env := opts.Env
		if !opts.HasEnv {
			env = envFromOS()
		}
		hasBinary = onPathFactory(env, platform)
	}

	out := []DetectedHost{}
	for _, spec := range HostSpecs {
		onPath := false
		for _, bin := range spec.Bins {
			if hasBinary(bin) {
				onPath = true
				break
			}
		}
		inRepo := false
		for _, f := range spec.RepoFiles {
			if exists(filepath.Join(opts.Root, f)) {
				inRepo = true
				break
			}
		}
		userConfig := false
		for _, d := range spec.UserDirs {
			if exists(filepath.Join(home, d)) {
				userConfig = true
				break
			}
		}
		if !onPath && !inRepo && !userConfig {
			continue
		}
		strength := InstalledLikely
		if onPath {
			strength = Confirmed
		} else if inRepo {
			strength = ProjectPresent
		}
		out = append(out, DetectedHost{
			ID:         spec.ID,
			Name:       spec.Name,
			Strength:   strength,
			OnPath:     onPath,
			InRepo:     inRepo,
			UserConfig: userConfig,
			Adapter:    spec.Adapter,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := strengthRank[out[i].Strength], strengthRank[out[j].Strength]
		if ri != rj {
			return ri < rj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// AdapterContent is the one-line vendor redirect Leji writes for a file-style host.
func AdapterContent(bootProfilePath string) string {
	return "Read ./" + bootProfilePath + " first. It is the canonical context entrypoint for this repository.\n"
}

// SpecByID returns the host spec for a canonical id, or nil when unknown.
func SpecByID(id string) *HostSpec {
	for i := range HostSpecs {
		if HostSpecs[i].ID == id {
			return &HostSpecs[i]
		}
	}
	return nil
}
