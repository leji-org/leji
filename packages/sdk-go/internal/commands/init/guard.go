package initcmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/leji-org/leji/packages/sdk-go/internal/detect"
	"github.com/leji-org/leji/packages/sdk-go/internal/fsx"
	"github.com/leji-org/leji/packages/sdk-go/internal/jsonenc"
)

// The onboarding approval guard: a transient Claude Code PreToolUse hook that
// counters the ask-prompt pattern. AskUserQuestion stays blocked until the
// proposal is written to <rootPath>/.leji/proposal.md AND printed as message
// text; the corrective message lands at the action boundary, where instruction
// reliably reaches the model. Self-disabling once the onboarding brief is gone;
// the finalize step removes it entirely.

// ProposalMarker is the required first line of the proposal artifact.
const ProposalMarker = "# Proposal for approval"

// approvalGuardScript renders the guard script, byte-identical to the Node SDK's.
func approvalGuardScript(lejiRel string) string {
	lejiJSON, _ := jsonenc.Marshal(lejiRel)
	markerJSON, _ := jsonenc.Marshal(ProposalMarker)
	return "#!/usr/bin/env node\n" +
		"// Leji onboarding approval guard (transient; Claude Code PreToolUse hook on\n" +
		"// AskUserQuestion). The approval prompt stays blocked until the proposal is\n" +
		"// written to " + lejiRel + "/proposal.md AND printed as plain message text.\n" +
		"// Self-disabling: once the onboarding brief is gone it always allows.\n" +
		"// Removed at finalize; safe to delete at any time.\n" +
		"import fs from 'node:fs';\n" +
		"import path from 'node:path';\n" +
		"\n" +
		"const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };\n" +
		"const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();\n" +
		"const lejiDir = path.join(root, " + string(lejiJSON) + ");\n" +
		"if (read(path.join(lejiDir, 'onboarding-brief.md')) === null) process.exit(0);\n" +
		"const MARKER = " + string(markerJSON) + ";\n" +
		"const proposal = read(path.join(lejiDir, 'proposal.md'));\n" +
		"let printed = false;\n" +
		"if (proposal !== null && proposal.includes(MARKER)) {\n" +
		"   let stdin = '';\n" +
		"   try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* no hook input */ }\n" +
		"   let transcriptPath = null;\n" +
		"   try { transcriptPath = JSON.parse(stdin).transcript_path ?? null; } catch { /* not json */ }\n" +
		"   const transcript = transcriptPath ? read(transcriptPath) : null;\n" +
		"   if (transcript === null) {\n" +
		"      printed = true; // no transcript to inspect: the artifact stands as evidence\n" +
		"   } else {\n" +
		"      // \"Printed\" means the reply itself carries the proposal: the marker must\n" +
		"      // appear in one of the last few assistant text blocks, not in a plan,\n" +
		"      // a file diff, or the artifact alone.\n" +
		"      const texts = [];\n" +
		"      for (const line of transcript.trim().split('\\n')) {\n" +
		"         let entry;\n" +
		"         try { entry = JSON.parse(line); } catch { continue; }\n" +
		"         if (entry.type !== 'assistant') continue;\n" +
		"         const chunk = (entry.message?.content ?? [])\n" +
		"            .filter((b) => b.type === 'text')\n" +
		"            .map((b) => b.text)\n" +
		"            .join('\\n');\n" +
		"         if (chunk.trim() !== '') texts.push(chunk);\n" +
		"      }\n" +
		"      printed = texts.slice(-3).some((c) => c.includes(MARKER));\n" +
		"   }\n" +
		"}\n" +
		"if (printed) process.exit(0);\n" +
		"console.error(\n" +
		"   'Approval blocked by the Leji onboarding guard: write the full proposal to ' +\n" +
		"   " + string(lejiJSON) + " + '/proposal.md (first line \"' + MARKER + '\"), print that same ' +\n" +
		"   'content as plain text in your reply, then retry this question unchanged.',\n" +
		");\n" +
		"process.exit(2);\n"
}

// GuardAction is what EnsureApprovalGuard did: "installed" | "unchanged".
type GuardAction = string

// parseOrderedJSON decodes a JSON document preserving object key order
// (objects become *ordered, arrays []any, numbers json.Number), so the
// settings round-trip re-serializes byte-identically to Node's
// JSON.parse → mutate → JSON.stringify(_, null, 2).
func parseOrderedJSON(text string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	v, err := decodeOrderedValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing content after JSON value")
	}
	return v, nil
}

func decodeOrderedValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return tok, nil // string, json.Number, bool, or nil
	}
	switch delim {
	case '{':
		o := newOrdered()
		for dec.More() {
			keyTok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, _ := keyTok.(string)
			val, err := decodeOrderedValue(dec)
			if err != nil {
				return nil, err
			}
			o.set(key, val)
		}
		if _, err := dec.Token(); err != nil { // consume '}'
			return nil, err
		}
		return o, nil
	case '[':
		arr := []any{}
		for dec.More() {
			val, err := decodeOrderedValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, val)
		}
		if _, err := dec.Token(); err != nil { // consume ']'
			return nil, err
		}
		return arr, nil
	}
	return nil, errors.New("unexpected JSON delimiter")
}

// EnsureApprovalGuard writes the guard script under <rootPath>/.leji/hooks/ and
// merges its PreToolUse entry into .claude/settings.json (created if absent,
// other settings preserved). Idempotent: an existing guard entry is left
// untouched.
func EnsureApprovalGuard(root, rootPath string) (GuardAction, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		rootAbs = root
	}
	lejiRel := fsx.JoinUnderRoot(rootPath, ".leji")
	scriptRel := lejiRel + "/hooks/approval-guard.mjs"
	scriptAbs := filepath.Join(rootAbs, scriptRel)
	if err := guardWithinRoot(rootAbs, scriptAbs, scriptRel); err != nil {
		return "", err
	}

	settingsRel := ".claude/settings.json"
	settingsAbs := filepath.Join(rootAbs, settingsRel)
	if err := guardWithinRoot(rootAbs, settingsAbs, settingsRel); err != nil {
		return "", err
	}
	settings := newOrdered()
	if fsx.IsFile(settingsAbs) {
		existing, rerr := fsx.ReadText(settingsAbs)
		if rerr != nil {
			return "", rerr
		}
		if strings.TrimSpace(existing) != "" {
			parsed, perr := parseOrderedJSON(existing)
			obj, isObj := parsed.(*ordered)
			if perr != nil || !isObj {
				return "", fmt.Errorf("%s is not valid JSON; fix it before installing the onboarding guard", settingsRel)
			}
			settings = obj
		}
	}
	hooks, isObj := settings.values["hooks"].(*ordered)
	if !isObj {
		hooks = newOrdered()
		settings.set("hooks", hooks)
	}
	pre, isArr := hooks.values["PreToolUse"].([]any)
	if !isArr {
		pre = []any{}
	}
	present := false
	for _, e := range pre {
		entry, isEntry := e.(*ordered)
		if !isEntry {
			continue
		}
		entryHooks, isHooks := entry.values["hooks"].([]any)
		if !isHooks {
			continue
		}
		for _, h := range entryHooks {
			ho, isHook := h.(*ordered)
			if !isHook {
				continue
			}
			if cmd, isStr := ho.values["command"].(string); isStr && strings.Contains(cmd, "approval-guard.mjs") {
				present = true
			}
		}
	}
	if err := writeFileAtomic(rootAbs, scriptAbs, scriptRel, approvalGuardScript(lejiRel)); err != nil {
		return "", err
	}
	if present {
		return "unchanged", nil
	}
	hook := newOrdered()
	hook.set("type", "command")
	hook.set("command", "node \"$CLAUDE_PROJECT_DIR/"+scriptRel+"\"")
	entry := newOrdered()
	entry.set("matcher", "AskUserQuestion")
	entry.set("hooks", []any{hook})
	hooks.set("PreToolUse", append(pre, entry))
	var buf bytes.Buffer
	settings.encode(&buf)
	buf.WriteByte('\n')
	if err := writeFileAtomic(rootAbs, settingsAbs, settingsRel, buf.String()); err != nil {
		return "", err
	}
	return "installed", nil
}

// GuardOfferOptions configures OfferApprovalGuard: the consent-gated install
// offer, made only when the resolved launch host is Claude Code (the host whose
// prompt pattern the guard counters).
type GuardOfferOptions struct {
	Root        string
	RootPath    string
	Detected    []detect.DetectedHost
	Interactive bool
	// Agent forces a specific launchable host (claude-code/codex); empty means detect.
	Agent string
}

// OfferApprovalGuard offers the onboarding approval guard for a Claude Code
// handoff. Silent when non-interactive or the host is not Claude Code; says so
// when already installed (a silent skip is indistinguishable from broken).
func OfferApprovalGuard(opts GuardOfferOptions, hio *HandoffIO, out io.Writer) error {
	if !opts.Interactive {
		return nil
	}
	hostID := ""
	if opts.Agent != "" {
		hostID = detect.ResolveHostId(opts.Agent)
	} else {
		hosts := promptCapableHosts(opts.Detected)
		if len(hosts) == 1 {
			hostID = hosts[0].id
		} else if len(hosts) > 1 {
			for _, h := range hosts {
				if h.id == "claude-code" {
					hostID = "claude-code"
					break
				}
			}
		}
	}
	if hostID != "claude-code" {
		return nil
	}
	answer := strings.ToLower(hio.ReadLine(
		"Add the temporary onboarding guard for Claude Code, in this repository only? It has the agent print its proposal before asking for approval. Writes two project-local files (a hook entry in this repo’s .claude/settings.json, a script in the gitignored .leji/ workspace); nothing outside this repository is touched, and the finalize step removes both",
		"Y/n",
	))
	if !(answer == "" || answer == "y" || answer == "yes") {
		return nil
	}
	action, err := EnsureApprovalGuard(opts.Root, opts.RootPath)
	if err != nil {
		return err
	}
	if action == "installed" {
		fmt.Fprintln(out, "Onboarding guard added (this repository only: .claude/settings.json hook + .leji/hooks/approval-guard.mjs; removed at finalize).")
	} else {
		fmt.Fprintln(out, "Onboarding guard already present in this repository; refreshed the script.")
	}
	return nil
}
