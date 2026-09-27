package cli

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// `leji doctor` end to end: the report `leji start` prints before it launches, as a
// command of its own. The central cases run both commands on the same inputs (the same
// seeded root from fixtures/start-preflight/, the same stub PATH, a non-TTY so start
// launches nothing) and compare what they print. Mirrors
// packages/sdk/test/proc/doctor.test.ts.

const launchSentence = " The agent starts either way."

// doctorPrompt is how every question the CLI asks ends: `<question> [<default>]: `.
var doctorPrompt = regexp.MustCompile(`\[[^\]\n]*\]: `)

// aboveLaunch is start's output above its launch line: the Setup block, as start
// printed it.
func aboveLaunch(t *testing.T, stdout string) string {
	t.Helper()
	cut := strings.Index(stdout, "No coding agent was launched.")
	if cut <= 0 {
		t.Fatalf("start printed no entry instructions:\n%s", stdout)
	}
	return strings.TrimRight(stdout[:cut], " \n") + "\n"
}

// assertSameBlock: doctor's block equals start's, line for line, except the closing
// line, which is start's with the agent sentence removed.
func assertSameBlock(t *testing.T, doctor, start string) {
	t.Helper()
	d := strings.Split(doctor, "\n")
	s := strings.Split(aboveLaunch(t, start), "\n")
	if len(d) != len(s) {
		t.Fatalf("line counts differ:\n%s\n---\n%s", doctor, start)
	}
	closing := len(d) - 2 // the last element is the empty string after the final newline
	if !slices.Equal(d[:closing], s[:closing]) {
		t.Fatalf("a line above the closing line differs:\n%s\n---\n%s", doctor, start)
	}
	if !strings.HasSuffix(s[closing], launchSentence) {
		t.Fatalf("start's closing line lacks the sentence: %q", s[closing])
	}
	if d[closing] != strings.TrimSuffix(s[closing], launchSentence) {
		t.Fatalf("closing line %q, want %q", d[closing], strings.TrimSuffix(s[closing], launchSentence))
	}
	if d[closing+1] != "" {
		t.Fatalf("doctor's block does not end in one newline: %q", doctor)
	}
}

// asDoctor is start's JSON document with the one field doctor's differs in.
func asDoctor(startJSON string) string {
	return strings.Replace(startJSON, `"command": "start"`, `"command": "doctor"`, 1)
}

// --- doctor against start, on identical inputs ---------------------------------------

func TestDoctorPrintsStartBlockExceptTheClosingLine(t *testing.T) {
	// One host reporting the server unregistered, no `.mcp.json`, no hook: a fix for
	// this user and one for a maintainer, so the closing line has both counts.
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub, "claude": "exit 1"})
	startCode, startOut, startErr := captureRun(t, []string{"start", "--root", dir})
	doctorCode, doctorOut, _ := captureRun(t, []string{"doctor", "--root", dir})
	if startCode != 0 {
		t.Fatalf("start exit %d: %s", startCode, startErr)
	}
	if doctorCode != 1 {
		t.Fatalf("doctor exit %d, want 1 (the clone is not ready)", doctorCode)
	}
	assertSameBlock(t, doctorOut, startOut)
	if !strings.Contains(doctorOut, "\n  2 fixes for you, 1 for a maintainer.\n") {
		t.Fatalf("closing line:\n%s", doctorOut)
	}
}

func TestDoctorJSONIsStartJSONApartFromCommand(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub, "claude": "exit 1"})
	startCode, startOut, startErr := captureRun(t, []string{"start", "--root", dir, "--json"})
	doctorCode, doctorOut, _ := captureRun(t, []string{"doctor", "--root", dir, "--json"})
	if startCode != 0 {
		t.Fatalf("start exit %d: %s", startCode, startErr)
	}
	if doctorCode != 1 {
		t.Fatalf("doctor exit %d, want 1: the exit status agrees with `ready`", doctorCode)
	}
	if doctorOut != asDoctor(startOut) {
		t.Fatalf("documents differ beyond `command`:\n%s\n---\n%s", doctorOut, startOut)
	}
	doc := decodeStart(t, doctorOut)
	if doc.Command != "doctor" || !doc.OK || doc.Ready {
		t.Fatalf("doc = %+v", doc)
	}
}

func TestDoctorSeveralHostsBothComparisonsHoldAndTheUnresolvedFixIsStarts(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub, "claude": "exit 1", "codex": "exit 1"})
	_, startOut, _ := captureRun(t, []string{"start", "--root", dir})
	doctorCode, doctorOut, _ := captureRun(t, []string{"doctor", "--root", dir})
	if doctorCode != 1 {
		t.Fatalf("doctor exit %d", doctorCode)
	}
	assertSameBlock(t, doctorOut, startOut)
	if !strings.Contains(doctorOut, "\n        $ leji start --agent <name>\n") {
		t.Fatalf("unresolved fix:\n%s", doctorOut)
	}

	_, startJSON, _ := captureRun(t, []string{"start", "--root", dir, "--json"})
	_, doctorJSON, _ := captureRun(t, []string{"doctor", "--root", dir, "--json"})
	if doctorJSON != asDoctor(startJSON) {
		t.Fatalf("documents differ beyond `command`:\n%s\n---\n%s", doctorJSON, startJSON)
	}
	for _, c := range decodeStart(t, doctorJSON).Checks {
		if c.ID == "mcp" && (c.Status != "unresolved" || !slices.Equal(c.Fix, []string{"leji start --agent <name>"})) {
			t.Fatalf("mcp = %+v", c)
		}
	}
}

// --- what doctor does on its own ------------------------------------------------------

func TestDoctorOffersNothingAndLaunchesNothing(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub, "claude": "exit 1"})
	_, out, _ := captureRun(t, []string{"doctor", "--root", dir})
	if !strings.Contains(out, "Setup for this clone") {
		t.Fatalf("no block:\n%s", out)
	}
	for _, absent := range []string{
		"No coding agent was launched.",
		"Starting ",
		"Register the Leji MCP server",
		"Install the pre-commit hook",
		"either way",
	} {
		if strings.Contains(out, absent) {
			t.Fatalf("doctor printed %q:\n%s", absent, out)
		}
	}
}

func TestDoctorExits1OnACloneWithNoHookInBothModes(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub})
	code, out, errs := captureRun(t, []string{"doctor", "--root", dir})
	if code != 1 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	for _, want := range []string{"\n  you   Git hook    none yet (per clone)\n", "\n  1 fix for you.\n"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	code, out, _ = captureRun(t, []string{"doctor", "--root", dir, "--json"})
	if code != 1 || decodeStart(t, out).Ready {
		t.Fatalf("exit %d:\n%s", code, out)
	}
}

func TestDoctorExits0OnAReadyCloneInBothModes(t *testing.T) {
	// The ready state the start tests use: the CLI declared and answering, the host
	// reporting the server registered, `.mcp.json` committed, and the clone hook
	// installed.
	dir := startFixture(t, "node-mcp-json", map[string]string{"leji": versionStub, "claude": "exit 0"})
	if code, _, errs := captureRun(t, []string{"ci", "--hooks", "--root", dir}); code != 0 {
		t.Fatalf("ci --hooks exit %d: %s", code, errs)
	}
	code, out, errs := captureRun(t, []string{"doctor", "--root", dir, "--json"})
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	doc := decodeStart(t, out)
	if !doc.Ready {
		t.Fatalf("doc = %+v", doc)
	}
	for _, c := range doc.Checks {
		if c.Status != "ok" {
			t.Fatalf("%s is %s", c.ID, c.Status)
		}
	}
	// The `cli` row is `ok` because the declared CLI resolves in this context layer:
	// the probe runs the installed shim, not whatever `leji` the machine has.
	if doc.Checks[0].Detail != "1.4.0 (node_modules/.bin/leji)" {
		t.Fatalf("cli detail = %q", doc.Checks[0].Detail)
	}
	code, out, errs = captureRun(t, []string{"doctor", "--root", dir})
	if code != 0 || !strings.Contains(out, "\n  Setup complete.\n") {
		t.Fatalf("exit %d: %s\n%s", code, errs, out)
	}
}

func TestDoctorAgentBogusIsAUsageErrorInBothModes(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub})
	for _, extra := range [][]string{nil, {"--json"}} {
		code, out, errs := captureRun(t, append([]string{"doctor", "--root", dir, "--agent", "bogus"}, extra...))
		if code != 2 || !strings.Contains(errs, "--agent must be a launchable host") {
			t.Fatalf("%v: exit %d: %s", extra, code, errs)
		}
		if strings.TrimSpace(out) != "" {
			t.Fatalf("%v: something was reported for a rejected argument:\n%s", extra, out)
		}
	}
}

func TestDoctorBootMissingExits1InBothModes(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub})
	if err := os.Remove(filepath.Join(dir, "docs", "boot-profile.md")); err != nil {
		t.Fatal(err)
	}
	code, out, _ := captureRun(t, []string{"doctor", "--root", dir, "--json"})
	if code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !strings.HasPrefix(out, "{\n  \"command\": \"doctor\",\n  \"ok\": false,\n  \"ready\": false,\n  \"error\": \"boot-missing\",\n  \"checks\": [],\n  \"ecosystem\": ") {
		t.Fatalf("document:\n%s", out)
	}
	code, out, errs := captureRun(t, []string{"doctor", "--root", dir})
	if code != 1 || !strings.Contains(errs, "boot profile docs/boot-profile.md is missing or invalid; run leji validate") {
		t.Fatalf("exit %d: %s", code, errs)
	}
	if out != "" {
		t.Fatalf("no block for a context layer with nothing to enter:\n%s", out)
	}
}

func TestDoctorNoManifestIsTheFindingsEnvelope(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", startStubs(t, map[string]string{}))
	t.Setenv("HOME", t.TempDir())
	code, out, _ := captureRun(t, []string{"doctor", "--root", dir, "--json"})
	if code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !strings.HasPrefix(out, "{\n  \"command\": \"doctor\",\n  \"ok\": false,\n  \"findings\": [") {
		t.Fatalf("envelope:\n%s", out)
	}
}

func TestDoctorRejectsUndeclaredFlagsYesIncluded(t *testing.T) {
	dir := startFixture(t, "node-declared", map[string]string{"leji": versionStub})
	for _, flag := range []string{"--yes", "-y", "--dry-run", "--strict", "--", "--frobnicate"} {
		code, out, errs := captureRun(t, []string{"doctor", "--root", dir, flag})
		if code != 2 {
			t.Fatalf("%s: exit %d: %s%s", flag, code, out, errs)
		}
		if strings.Contains(out, "Setup for this clone") {
			t.Fatalf("%s ran the report", flag)
		}
	}
}

// --- a terminal: never a prompt, never a write ----------------------------------------

// onTerminal gives the run a pseudo-terminal as its stdin: the one input `start` reads to
// decide it may prompt, offer, and launch. Every line waiting on it is Enter (a
// question's default), so a regression that asks one fails on the assertions instead of
// waiting on input.
func onTerminal(t *testing.T) {
	t.Helper()
	master, slave, err := openPTY()
	if err != nil {
		t.Skipf("no pseudo-terminal: %v", err)
	}
	saved := os.Stdin
	os.Stdin = slave
	t.Cleanup(func() {
		os.Stdin = saved
		slave.Close()
		master.Close()
	})
	if !stdinIsTTY() {
		t.Fatal("the pseudo-terminal does not answer as a terminal")
	}
	if _, err := master.Write([]byte(strings.Repeat("\n", 16))); err != nil {
		t.Fatalf("answer the terminal: %v", err)
	}
}

// recording is a stub body that appends its own argv to log before answering.
func recording(log, name, then string) string {
	return `echo "` + name + ` $*" >> '` + log + "'\n" + then
}

// recordShim replaces the installed bin shim, so the version probe is recorded too.
func recordShim(t *testing.T, dir, log string) {
	t.Helper()
	shim := filepath.Join(dir, "node_modules", ".bin", "leji")
	if err := os.WriteFile(shim, []byte("#!/bin/sh\n"+recording(log, "shim", versionStub)+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func recorded(t *testing.T, log string) []string {
	t.Helper()
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatalf("no call was recorded: %v", err)
	}
	return strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
}

func TestDoctorOnATerminalWithTwoHostsAndNoAgentPromptsForNothing(t *testing.T) {
	log := filepath.Join(t.TempDir(), "calls")
	dir := startFixture(t, "node-declared", map[string]string{
		"leji":   versionStub,
		"claude": recording(log, "claude", "exit 1"),
		"codex":  recording(log, "codex", "exit 1"),
	})
	recordShim(t, dir, log)
	onTerminal(t)
	code, out, errs := captureRun(t, []string{"doctor", "--root", dir})
	if code != 1 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	// A host prompt would print its question and then resolve a host; neither happened.
	if doctorPrompt.MatchString(out) {
		t.Fatalf("a prompt was printed:\n%s", out)
	}
	if !strings.Contains(out, "\n  you   MCP server  pick one: Claude Code, Codex\n") {
		t.Fatalf("mcp row:\n%s", out)
	}
	// The only subprocess a stub saw is the version probe: no host was picked, so no
	// registration was queried, and nothing was registered or launched.
	if got := recorded(t, log); !slices.Equal(got, []string{"shim --version"}) {
		t.Fatalf("calls = %q", got)
	}
}

func TestDoctorOnATerminalWithOneHostQueriesAndOffersNothingMore(t *testing.T) {
	// The state where `start` on a terminal offers both personal fixes: the host
	// registration and the clone hook.
	log := filepath.Join(t.TempDir(), "calls")
	dir := startFixture(t, "node-declared", map[string]string{
		"leji":   versionStub,
		"claude": recording(log, "claude", "exit 1"),
	})
	recordShim(t, dir, log)
	before := treeSnapshot(t, dir)
	onTerminal(t)
	code, out, errs := captureRun(t, []string{"doctor", "--root", dir})
	if code != 1 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	if doctorPrompt.MatchString(out) {
		t.Fatalf("an offer was printed:\n%s", out)
	}
	if !strings.Contains(out, "\n  you   MCP server  not registered for Claude Code\n") {
		t.Fatalf("mcp row:\n%s", out)
	}
	// The version probe and the host's registration query, and nothing else: no
	// `claude mcp add`, and no launch.
	if got := recorded(t, log); !slices.Equal(got, []string{"shim --version", "claude mcp get leji"}) {
		t.Fatalf("calls = %q", got)
	}
	if after := treeSnapshot(t, dir); !slices.Equal(before, after) {
		t.Fatal("the tree, .git included, changed")
	}
}
