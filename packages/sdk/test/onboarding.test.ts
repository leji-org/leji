import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
   addAgent,
   adoptLayer,
   detectHosts,
   enterLayer,
   enteringAdopted,
   ensureLocalHook,
   handoffOffer,
   ensureApprovalGuard,
   offerMcpInstall,
   initLayer,
   validateLayer,
   writeIndex,
   loadManifest,
} from '../dist/index.js';

function tmpdir(): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), 'leji-onboarding-'));
}

test('init --dry-run writes nothing and reports the plan', async () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'some existing agent config\n');
   const result = await initLayer({ dir, yes: true, dryRun: true });

   assert.equal(result.dryRun, true);
   assert.deepEqual(result.written, []);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false, 'dry-run creates no manifest');

   const creates = result.plan.filter((e) => e.status === 'create').map((e) => e.rel);
   assert.ok(creates.includes('leji.json'));
   assert.ok(creates.includes('.leji/work/onboarding-brief.md'));
   // The existing vendor file is detected and explicitly left untouched.
   const untouched = result.plan.find((e) => e.rel === 'CLAUDE.md');
   assert.equal(untouched?.status, 'wont-modify');
});

test('init writes the onboarding brief in the workspace role, excluded from the index', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true, level: 'indexed', name: 'acme-context' });

   const brief = path.join(dir, '.leji', 'work', 'onboarding-brief.md');
   assert.ok(fs.existsSync(brief), 'brief is written');

   const { manifest } = loadManifest(dir);
   const result = writeIndex(dir, manifest!);
   const indexedPaths = result.index!.entries.map((e) => e.path);
   assert.ok(
      !indexedPaths.some((p) => p.includes('.leji')),
      'the transient brief never appears in the generated index',
   );
});

test('validate --content warns on a fresh scaffold but never errors', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   const result = validateLayer(dir, { content: true });

   const rules = result.findings.map((f) => f.rule);
   assert.ok(rules.includes('content-identity'), 'flags the generic identity');
   assert.ok(rules.includes('content-placeholder'), 'flags placeholder text');
   assert.ok(rules.includes('content-thin'), 'flags thin categories');
   // Content findings are warning-only; the layer remains error-free.
   assert.equal(result.findings.filter((f) => f.severity === 'error').length, 0);
});

test('validate without --content does not emit content findings', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   const result = validateLayer(dir);
   assert.ok(!result.findings.some((f) => f.rule.startsWith('content-')));
});

test('a populated layer passes the content lint clean', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   // Replace the placeholder scaffold with real, repo-specific content.
   fs.writeFileSync(
      path.join(dir, 'docs', 'boot-profile.md'),
      [
         '# Boot Profile',
         '',
         '## Identity',
         '',
         'Acme is a B2B invoicing platform in production since 2024.',
         '',
         '## Loading',
         '',
         '- docs/system/invariants.md: the rules every change lives with',
         '',
         '## Posture',
         '',
         '- Proceed without asking: doc fixes.',
         '- Stop and ask: settlement math.',
         '- Never: bypass the ledger.',
         '',
         '## Maintenance',
         '',
         'Append to docs/decisions when you change this layer.',
         '',
      ].join('\n'),
   );
   fs.writeFileSync(
      path.join(dir, 'docs', 'domain', 'glossary.md'),
      '---\nsummary: terms\n---\n\n# Glossary\n\n- Invoice: a request for payment.\n- Credit note: reduces an invoice.\n- Settlement: matching funds to invoices.\n',
   );
   fs.writeFileSync(
      path.join(dir, 'docs', 'system', 'invariants.md'),
      '---\nsummary: rules\n---\n\n# System Invariants\n\n- Money is integer minor units.\n- Invoices are immutable once sent.\n- The ledger is the source of truth.\n',
   );
   const result = validateLayer(dir, { content: true });
   assert.ok(
      !result.findings.some((f) => f.rule.startsWith('content-')),
      `expected no content findings, got: ${result.findings.map((f) => f.rule).join(', ')}`,
   );
});

test('detectHosts ranks confirmed > project-present > installed-likely (injected probes)', () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'codex config\n'); // codex: project-present
   const home = tmpdir();
   fs.mkdirSync(path.join(home, '.gemini')); // gemini: installed-likely
   const hosts = detectHosts({
      root: dir,
      homedir: home,
      platform: 'linux',
      hasBinary: (b) => b === 'claude', // claude: confirmed
   });
   assert.deepEqual(
      hosts.map((h) => h.id),
      ['claude-code', 'codex', 'gemini'],
   );
   assert.equal(hosts[0].strength, 'confirmed');
   assert.equal(hosts.find((h) => h.id === 'codex')?.strength, 'project-present');
   assert.equal(hosts.find((h) => h.id === 'gemini')?.strength, 'installed-likely');
});

// --- handoff offer (post-scaffold) ---

function host(id: string, name: string, onPath: boolean): never {
   return {
      id,
      name,
      strength: onPath ? 'confirmed' : 'project-present',
      onPath,
      inRepo: !onPath,
      userConfig: false,
      adapter: null,
   } as never;
}
const CLAUDE = host('claude-code', 'Claude Code', true);
const CODEX = host('codex', 'Codex', true);
const CURSOR = host('cursor', 'Cursor', true); // directory-style: no inline-prompt CLI
const manifestAt = (rootPath: string) => ({ rootPath }) as never;

/** A scripted handoff I/O: returns `answer` for every prompt, records launches.
 * `launchResult` overrides the spawn outcome (default: clean exit, status 0). */
type SpawnResult = { error?: Error; status?: number | null; signal?: NodeJS.Signals | null };

function fakeIo(answer: string | string[], launchResult?: SpawnResult, runResults?: SpawnResult[]) {
   const answers = Array.isArray(answer) ? [...answer] : [answer];
   const launches: { bin: string; promptArg: string }[] = [];
   const cwds: (string | undefined)[] = [];
   const questions: string[] = [];
   const runs: { bin: string; args: string[]; cwd?: string; quiet: boolean }[] = [];
   // Interleaved run/launch order, for asserting "register before launch".
   const events: string[] = [];
   let runIdx = 0;
   const io = {
      async readLine(q: string) {
         questions.push(q);
         // Sequenced answers (the last one repeats), so multi-prompt flows are scriptable.
         return answers.length > 1 ? (answers.shift() as string) : answers[0];
      },
      launch(bin: string, promptArg: string, cwd?: string) {
         launches.push({ bin, promptArg });
         cwds.push(cwd);
         events.push(`launch:${bin}`);
         return launchResult ?? { status: 0 };
      },
      run(bin: string, args: string[], cwd: string | undefined, opts: { quiet: boolean }) {
         runs.push({ bin, args, cwd, quiet: opts.quiet });
         events.push(`run:${bin}`);
         return runResults?.[runIdx++] ?? { status: 0 };
      },
   };
   return { io, launches, questions, cwds, runs, events };
}

const BRIEF_PROMPT = 'Read ./.leji/work/onboarding-brief.md and follow it.';

test('handoffOffer never fires non-interactively, even with a launchable host on PATH', async () => {
   const f = fakeIo('y');
   // interactive=false short-circuits before prompting or launching.
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE], false, f.io), false);
   assert.equal(f.questions.length, 0);
   assert.equal(f.launches.length, 0);
});

test('handoffOffer makes no offer when only directory-style hosts are present', async () => {
   const f = fakeIo('y');
   assert.equal(await handoffOffer(manifestAt('docs/'), [CURSOR], true, f.io), false);
   assert.equal(f.questions.length, 0, 'no prompt is shown');
   assert.equal(f.launches.length, 0);
});

test('handoffOffer ignores prompt-capable hosts that are not on PATH', async () => {
   const f = fakeIo('y');
   assert.equal(await handoffOffer(manifestAt('docs/'), [host('codex', 'Codex', false)], true, f.io), false);
   assert.equal(f.launches.length, 0);
});

test('handoffOffer (single host) launches on an empty answer (Y default)', async () => {
   const f = fakeIo('');
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE], true, f.io), true);
   assert.deepEqual(f.launches, [{ bin: 'claude', promptArg: BRIEF_PROMPT }]);
});

test('handoffOffer (single host) launches on y / yes', async () => {
   for (const ans of ['y', 'yes', 'Y', 'YES']) {
      const f = fakeIo(ans);
      assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE], true, f.io), true, ans);
      assert.equal(f.launches.length, 1, ans);
   }
});

test('handoffOffer (single host) declines on n, returning false without launching', async () => {
   const f = fakeIo('n');
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE], true, f.io), false);
   assert.equal(f.launches.length, 0);
});

test('handoffOffer (multiple hosts) selects by number', async () => {
   const f = fakeIo('2');
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE, CODEX], true, f.io), true);
   assert.deepEqual(f.launches, [{ bin: 'codex', promptArg: BRIEF_PROMPT }]);
});

test('handoffOffer (multiple hosts) skips on an empty answer (no accidental launch)', async () => {
   // Launching an agent is a side effect, so the multi-host menu requires an
   // explicit number; pressing Enter falls back to the printed instructions.
   const f = fakeIo('');
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE, CODEX], true, f.io), false);
   assert.equal(f.launches.length, 0);
});

test('handoffOffer (multiple hosts) skips on n', async () => {
   const f = fakeIo('n');
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE, CODEX], true, f.io), false);
   assert.equal(f.launches.length, 0);
});

test('handoffOffer (multiple hosts) skips on an out-of-range / junk answer, never launching agent 1', async () => {
   // An answer the user did not actually choose must not start the first agent.
   for (const ans of ['9', 'banana', '0', '-1']) {
      const f = fakeIo(ans);
      assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE, CODEX], true, f.io), false, ans);
      assert.equal(f.launches.length, 0, ans);
   }
});

test('handoffOffer returns false when the agent cannot be started (spawn error)', async () => {
   const f = fakeIo('y', { error: new Error('spawn claude ENOENT') });
   // Chosen and attempted, but the launch failed: caller falls back to instructions.
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE], true, f.io), false);
   assert.equal(f.launches.length, 1, 'a launch was attempted');
});

test('handoffOffer returns false when the agent exits non-zero', async () => {
   const f = fakeIo('y', { status: 1 });
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE], true, f.io), false);
   assert.equal(f.launches.length, 1);
});

test('handoffOffer returns false when the agent is killed by a signal', async () => {
   const f = fakeIo('y', { status: null, signal: 'SIGINT' });
   assert.equal(await handoffOffer(manifestAt('docs/'), [CLAUDE], true, f.io), false);
});

test('handoffOffer names the root-level workspace whatever the layer root is', async () => {
   // The onboarding workspace is one tree at the repository root, so the prompt is
   // the same for a layer rooted anywhere: it never carries a rootPath prefix.
   const f = fakeIo('y');
   assert.equal(await handoffOffer(manifestAt('context/'), [CLAUDE], true, f.io), true);
   assert.deepEqual(f.launches, [{ bin: 'claude', promptArg: BRIEF_PROMPT }]);
});

// --- enterLayer (leji start) ---

const BOOT_PROMPT = "Read ./docs/boot-profile.md, follow it, and tell me when you're ready.";

/** A minimal real layer dir with a boot profile, for enterLayer's existence check. */
function bootLayer(): { dir: string; manifest: never } {
   const dir = tmpdir();
   fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs', 'boot-profile.md'), '# boot\n');
   return { dir, manifest: { rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' } as never };
}

test('enterLayer launches a single detected agent directly (no prompt), from the layer root', async () => {
   const { dir, manifest } = bootLayer();
   const f = fakeIo('');
   const outcome = await enterLayer({ root: dir, manifest, detected: [CLAUDE], interactive: true, io: f.io });
   assert.equal(outcome, 'launched');
   assert.equal(f.questions.length, 0, 'a single host launches without asking');
   assert.deepEqual(f.launches, [{ bin: 'claude', promptArg: BOOT_PROMPT }]);
   assert.equal(f.cwds[0], path.resolve(dir), 'the agent is launched from the layer root');
});

test('enterLayer (multiple agents) asks, then launches the chosen one', async () => {
   const { dir, manifest } = bootLayer();
   const f = fakeIo('2');
   assert.equal(
      await enterLayer({ root: dir, manifest, detected: [CLAUDE, CODEX], interactive: true, io: f.io }),
      'launched',
   );
   assert.deepEqual(f.launches, [{ bin: 'codex', promptArg: BOOT_PROMPT }]);
});

test('enterLayer falls back (no launch) with no agent, non-interactive, or multi + non-interactive', async () => {
   const { dir, manifest } = bootLayer();
   assert.equal(
      await enterLayer({ root: dir, manifest, detected: [CURSOR], interactive: true, io: fakeIo('y').io }),
      'fallback',
   );
   assert.equal(
      await enterLayer({ root: dir, manifest, detected: [CLAUDE], interactive: false, io: fakeIo('y').io }),
      'fallback',
   );
   assert.equal(
      await enterLayer({ root: dir, manifest, detected: [CLAUDE, CODEX], interactive: false, io: fakeIo('2').io }),
      'fallback',
   );
});

test('enterLayer returns boot-missing when the boot profile is absent', async () => {
   const dir = tmpdir(); // no docs/boot-profile.md
   const manifest = { rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' } as never;
   assert.equal(
      await enterLayer({ root: dir, manifest, detected: [CLAUDE], interactive: true, io: fakeIo('y').io }),
      'boot-missing',
   );
});

test('enterLayer --agent forces a launchable host regardless of detection', async () => {
   const { dir, manifest } = bootLayer();
   const f = fakeIo('y');
   assert.equal(
      await enterLayer({ root: dir, manifest, detected: [], agent: 'codex', interactive: true, io: f.io }),
      'launched',
   );
   assert.deepEqual(f.launches, [{ bin: 'codex', promptArg: BOOT_PROMPT }]);
});

test('enterLayer --agent rejects a non-launchable host', async () => {
   const { dir, manifest } = bootLayer();
   await assert.rejects(
      () => enterLayer({ root: dir, manifest, detected: [], agent: 'gemini', interactive: true, io: fakeIo('y').io }),
      /launchable host/,
   );
});

test('enterLayer falls back when the launch fails', async () => {
   const { dir, manifest } = bootLayer();
   const f = fakeIo('', { status: 1 });
   assert.equal(await enterLayer({ root: dir, manifest, detected: [CLAUDE], interactive: true, io: f.io }), 'fallback');
   assert.equal(f.launches.length, 1, 'a launch was attempted');
});

test('init --agent no longer creates a vendor adapter and still validates clean', async () => {
   const dir = tmpdir();
   const res = await initLayer({ dir, yes: true, agent: 'claude-code' });
   assert.ok(!res.written.includes('CLAUDE.md'), 'init --agent must not create a vendor adapter');
   assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
   const { manifest } = loadManifest(dir);
   assert.ok(!manifest!.vendorAdapters);
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const v = validateLayer(dir);
   assert.equal(v.findings.filter((f) => f.severity === 'error').length, 0);
});

test('init --agent never overwrites an existing entrypoint', async () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'my own config\n');
   const res = await initLayer({ dir, yes: true, agent: 'claude-code' });
   assert.ok(!res.written.includes('CLAUDE.md'));
   assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'my own config\n');
   assert.ok(!loadManifest(dir).manifest!.vendorAdapters);
});

test('init --agent rejects a host it cannot launch and writes nothing', async () => {
   const dir = tmpdir();
   // --agent names the handoff host, so an unknown value is a usage error naming
   // the accepted set, the way --mode and --level reject theirs. It is checked
   // before any filesystem work, so the directory is left untouched.
   await assert.rejects(
      () => initLayer({ dir, yes: true, agent: 'frobnicate' }),
      /--agent must be a launchable host \(claude-code, codex\); got "frobnicate"/,
   );
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false);
});

test('init writes the portable AGENTS.md pointer by default and validates clean', async () => {
   const dir = tmpdir();
   const res = await initLayer({ dir, yes: true });
   assert.ok(res.written.includes('AGENTS.md'));
   assert.equal(
      fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'),
      'Read ./docs/boot-profile.md first. It is the canonical context entrypoint for this repository.\n',
   );
   // The pointer is the well-known portable adapter; no manifest declaration needed.
   assert.ok(!loadManifest(dir).manifest!.vendorAdapters);
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const v = validateLayer(dir);
   assert.equal(v.findings.filter((f) => f.severity === 'error').length, 0);
});

test('init --no-agents skips the portable AGENTS.md pointer', async () => {
   const dir = tmpdir();
   const res = await initLayer({ dir, yes: true, noAgents: true });
   assert.ok(!res.written.includes('AGENTS.md'));
   assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
});

test('init never touches an existing AGENTS.md (stays leave-as-is)', async () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'my own instructions\n');
   const res = await initLayer({ dir, yes: true });
   assert.ok(!res.written.includes('AGENTS.md'));
   assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'my own instructions\n');
   assert.equal(res.plan.find((e) => e.rel === 'AGENTS.md')?.status, 'wont-modify');
});

test('adopt writes the portable AGENTS.md pointer only when absent', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.writeFileSync(path.join(dir, 'docs', 'README.md'), '# Docs\n');
   gitCommitAll(dir);
   const res = await adoptLayer({ dir, yes: true });
   assert.ok(res.written.includes('AGENTS.md'));
   assert.equal(
      fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'),
      'Read ./docs/boot-profile.md first. It is the canonical context entrypoint for this repository.\n',
   );
});

test('adopt --no-agents skips the pointer; an existing AGENTS.md keeps the migrate flow', async () => {
   const skipDir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: skipDir });
   const skipped = await adoptLayer({ dir: skipDir, yes: true, noAgents: true });
   assert.ok(!skipped.written.includes('AGENTS.md'));
   assert.equal(fs.existsSync(path.join(skipDir, 'AGENTS.md')), false);

   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Team instructions here.\n');
   gitCommitAll(dir);
   const res = await adoptLayer({ dir, yes: true });
   // Present file: content migrated, original untouched, no pointer overwrite.
   assert.ok(!res.written.includes('AGENTS.md'));
   assert.deepEqual(res.migrated, ['AGENTS.md']);
   assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'Team instructions here.\n');
});

test('adopt reuses an existing docs root and migrates vendor content (draft)', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.writeFileSync(path.join(dir, 'docs', 'README.md'), '# Docs\n');
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Always run tests. Use 3-space indent.\n');
   gitCommitAll(dir);

   const res = await adoptLayer({ dir, yes: true });
   assert.equal(res.detectedRoot, 'docs/');
   assert.deepEqual(res.migrated, ['CLAUDE.md']);
   assert.equal(res.draft, true, 'a non-redirecting vendor file makes it a draft');

   // Original is untouched; content migrated into a Leji-owned governance doc.
   assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'Always run tests. Use 3-space indent.\n');
   const imported = path.join(dir, 'docs', 'governance', 'imported-claude.md');
   assert.ok(fs.existsSync(imported), 'migrated file exists with a single .md extension');
   assert.match(fs.readFileSync(imported, 'utf8'), /Always run tests/);
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'decisions', '0002-adopt-existing-agent-context.md')));

   // Draft is honest: the non-redirecting entrypoint makes validate error.
   const v = validateLayer(dir);
   assert.ok(v.findings.some((f) => f.rule === 'vendor-adapter-redirect' && f.severity === 'error'));
});

test('adopt --wire-adapters converts the entrypoint and validates clean core', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Always run tests.\n');
   gitCommitAll(dir);

   const res = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.equal(res.draft, false);
   assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /docs\/boot-profile\.md/);
   assert.deepEqual(loadManifest(dir).manifest!.vendorAdapters, ['CLAUDE.md']);
   const v = validateLayer(dir);
   assert.equal(v.findings.filter((f) => f.severity === 'error').length, 0);
});

test('adopt --dry-run shows convert vs leave-as-is and writes nothing', async () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x\n');
   const res = await adoptLayer({ dir, yes: true, dryRun: true, wireAdapters: true });
   assert.deepEqual(res.written, []);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false);
   assert.equal(res.plan.find((e) => e.rel === 'CLAUDE.md')?.status, 'overwrite');
});

test('adopt refuses when a layer already exists', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   await assert.rejects(() => adoptLayer({ dir, yes: true }), /already has a Leji layer/);
});

test('agent wires a named reviewer into an existing layer that validates clean', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   await initLayer({ dir, yes: true, agent: 'claude-code' });
   const res = addAgent(dir, loadManifest(dir).manifest!, { host: 'codex', name: 'reviewer' });
   assert.deepEqual(
      { profileCreated: res.profileCreated, manifestChanged: res.manifestChanged },
      { profileCreated: true, manifestChanged: true },
   );
   assert.equal(res.hostId, 'codex');
   const { manifest } = loadManifest(dir);
   // The agent's binding; addAgent creates no vendor adapter. The AGENTS.md on
   // disk is init's portable pointer (default-on), not addAgent's work.
   assert.equal(manifest!.agents?.reviewer, 'docs/agents/reviewer.md');
   assert.ok(!manifest!.vendorAdapters);
   assert.equal(
      fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'),
      'Read ./docs/boot-profile.md first. It is the canonical context entrypoint for this repository.\n',
   );
   const reviewer = fs.readFileSync(path.join(dir, 'docs', 'agents', 'reviewer.md'), 'utf8');
   assert.match(reviewer, /^id: reviewer$/m);
   assert.match(reviewer, /^role: reviewer$/m);
   assert.match(reviewer, /^host: codex$/m);
   const v = validateLayer(dir);
   assert.equal(v.findings.filter((f) => f.severity === 'error').length, 0);
});

test('agent with no --host binds a host-agnostic resident agent (no vendor file)', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   await initLayer({ dir, yes: true });
   const res = addAgent(dir, loadManifest(dir).manifest!, { name: 'reviewer' });
   assert.deepEqual(
      { profileCreated: res.profileCreated, manifestChanged: res.manifestChanged },
      { profileCreated: true, manifestChanged: true },
   );
   assert.equal(res.hostId, undefined);
   const { manifest } = loadManifest(dir);
   assert.equal(manifest!.agents?.reviewer, 'docs/agents/reviewer.md');
   assert.ok(!manifest!.vendorAdapters);
   const reviewer = fs.readFileSync(path.join(dir, 'docs', 'agents', 'reviewer.md'), 'utf8');
   assert.doesNotMatch(reviewer, /^host:/m, 'resident agent must not pin a host');
   assert.ok(!reviewer.includes('(host '), 'resident agent prose must not mention a host');
   assert.match(reviewer, /^id: reviewer$/m);
   assert.match(reviewer, /^role: reviewer$/m);
});

test('agent is idempotent: a second run with the same args changes nothing', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   const m = loadManifest(dir).manifest!;
   addAgent(dir, m, { host: 'codex', name: 'reviewer' });
   const after = fs.readFileSync(path.join(dir, 'leji.json'), 'utf8');
   const res2 = addAgent(dir, m, { host: 'codex', name: 'reviewer' });
   assert.deepEqual(
      {
         profileCreated: res2.profileCreated,
         manifestChanged: res2.manifestChanged,
      },
      { profileCreated: false, manifestChanged: false },
   );
   assert.equal(fs.readFileSync(path.join(dir, 'leji.json'), 'utf8'), after);
});

test('agent appends a second binding without disturbing the first', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   await initLayer({ dir, yes: true });
   addAgent(dir, loadManifest(dir).manifest!, { host: 'codex', name: 'reviewer' });
   addAgent(dir, loadManifest(dir).manifest!, { host: 'claude-code', name: 'thought-partner', role: 'advisor' });
   const { manifest } = loadManifest(dir);
   assert.equal(manifest!.agents?.reviewer, 'docs/agents/reviewer.md');
   assert.equal(manifest!.agents?.['thought-partner'], 'docs/agents/thought-partner.md');
   const profile = fs.readFileSync(path.join(dir, 'docs', 'agents', 'thought-partner.md'), 'utf8');
   assert.match(profile, /^role: advisor$/m);
   const v = validateLayer(dir);
   assert.equal(v.findings.filter((f) => f.severity === 'error').length, 0);
});

test('agent rejects an unknown host and a non-kebab name', async () => {
   const dir = tmpdir();
   const m = (await initLayer({ dir, yes: true })).manifest;
   assert.throws(() => addAgent(dir, m, { host: 'frobnicate', name: 'reviewer' }), /unknown host/);
   assert.throws(() => addAgent(dir, m, { host: 'codex', name: 'Bad Name' }), /lowercase letters/);
});

// --- dirty-tree guard on init / adopt ---

function gitInit(dir: string): void {
   execFileSync('git', ['init', '-q'], { cwd: dir });
}
function gitCommitAll(dir: string): void {
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'seed'], { cwd: dir });
}

test('ci --hooks: the stale-index message is literal text, not a command the hook runs', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   await initLayer({ dir, yes: true });
   gitCommitAll(dir);
   ensureLocalHook(dir);
   // Nothing is declared here, so the generated hook runs the plain `leji` on PATH —
   // which makes that PATH this test's to supply. A stub of our own, AHEAD of
   // everything else, so the hook reaches it and never whatever the machine running
   // the suite happens to have installed (a runner has nothing; a maintainer's box
   // has a global copy, and the test would silently be measuring that one). The stub
   // names this Node and this build absolutely: it cannot assume a PATH either.
   const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
   const binDir = path.join(dir, 'node_modules', '.bin');
   fs.mkdirSync(binDir, { recursive: true });
   fs.writeFileSync(path.join(binDir, 'leji'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, {
      mode: 0o755,
   });
   // Stale the stored index, the exact condition the message describes.
   const indexAbs = path.join(dir, 'docs', 'context-index.json');
   const before = fs.readFileSync(indexAbs, 'utf8');
   fs.writeFileSync(
      path.join(dir, 'docs', 'domain', 'extra.md'),
      '---\nsummary: An extra domain doc.\n---\n\n# Extra\n',
   );

   const run = spawnSync('sh', [path.join('.git', 'hooks', 'pre-commit')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
   });
   assert.equal(run.status, 1, 'the hook rejects the commit');
   // The backticks reach the message as literal characters; a double-quoted echo
   // would have run `leji index` and spliced its stdout in here instead.
   assert.ok(
      run.stderr.includes('leji: stored index is stale; run `leji index` and stage the result.'),
      `message was not literal: ${run.stderr}`,
   );
   assert.equal(fs.readFileSync(indexAbs, 'utf8'), before, 'the hook regenerated a governed artifact');
});

test('init refuses on a dirty git working tree and writes nothing', async () => {
   const dir = tmpdir();
   gitInit(dir);
   fs.writeFileSync(path.join(dir, 'NOTES.md'), 'wip\n'); // untracked => dirty
   await assert.rejects(() => initLayer({ dir, yes: true }), /uncommitted changes/);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false, 'nothing written on refusal');
});

test('init proceeds on a clean committed git tree', async () => {
   const dir = tmpdir();
   gitInit(dir);
   fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
   gitCommitAll(dir);
   const res = await initLayer({ dir, yes: true });
   assert.ok(res.written.includes('leji.json'));
});

test('init --dry-run is allowed on a dirty git tree', async () => {
   const dir = tmpdir();
   gitInit(dir);
   fs.writeFileSync(path.join(dir, 'NOTES.md'), 'wip\n');
   const res = await initLayer({ dir, yes: true, dryRun: true });
   assert.equal(res.dryRun, true);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false);
});

test('init is allowed in a non-git directory (no undo net required to bootstrap)', async () => {
   const dir = tmpdir(); // not a git repo
   const res = await initLayer({ dir, yes: true });
   assert.ok(res.written.includes('leji.json'));
});

test('adopt refuses on a dirty git working tree', async () => {
   const dir = tmpdir();
   gitInit(dir);
   fs.writeFileSync(path.join(dir, 'NOTES.md'), 'wip\n');
   await assert.rejects(() => adoptLayer({ dir, yes: true }), /uncommitted changes/);
});

test('conformance --explain guides toward the next level', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true }); // core, not indexed
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const { conformanceReport, renderExplain } = await import('../dist/index.js');
   const explain = renderExplain(conformanceReport(dir));
   assert.match(explain, /To reach "indexed"/);
   assert.match(explain, /validate --content/);
});

test('init --agent creates no vendor adapter and validates clean', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   // --agent selects the handoff host and nothing else: no vendor entrypoint file,
   // no `vendorAdapters` manifest key. Only the portable AGENTS.md pointer is written.
   const res = await initLayer({ dir, yes: true, agent: 'claude-code' });
   assert.ok(!res.written.includes('CLAUDE.md'), 'init --agent creates no vendor adapter');
   assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
   assert.ok(!loadManifest(dir).manifest!.vendorAdapters);
   assert.equal(validateLayer(dir).findings.filter((f) => f.severity === 'error').length, 0);
});

test('init does not write a CI workflow (that is `leji ci`)', async () => {
   const dir = tmpdir();
   const res = await initLayer({ dir, yes: true });
   assert.ok(!res.written.includes('.github/workflows/leji.yml'), 'init no longer creates CI; use leji ci');
   assert.equal(fs.existsSync(path.join(dir, '.github', 'workflows', 'leji.yml')), false);
});

test('adopt --wire-adapters migrates mixed redirect+instructions before overwriting', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   // A vendor file that mentions the boot path AND carries real instructions,
   // including an instruction sharing the SAME line as the boot-path reference.
   fs.writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      'Read docs/boot-profile.md first. Never deploy on Fridays.\nAlways run the full test suite before committing.\n',
   );
   gitCommitAll(dir);
   const res = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.ok(res.migrated.includes('CLAUDE.md'), 'mixed file is migrated, not silently overwritten');
   const imported = fs.readFileSync(path.join(dir, 'docs', 'governance', 'imported-claude.md'), 'utf8');
   assert.match(imported, /Never deploy on Fridays/, 'same-line instructions are preserved');
   assert.match(imported, /Always run the full test suite/, 'multi-line instructions are preserved');
   assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /docs\/boot-profile\.md/);
});

test('adopt --yes then the printed adopt --wire-adapters reaches a clean layer', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Claude instructions\n\nNever deploy on Fridays.\n');
   gitCommitAll(dir);

   const adopted = await adoptLayer({ dir, yes: true });
   assert.equal(adopted.draft, true, 'a non-redirecting vendor file leaves an adoption draft');
   assert.match(enteringAdopted(adopted), /leji adopt --wire-adapters/, 'the draft prints the finishing command');

   // The command it printed has to run against the layer it just created.
   const wired = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.equal(wired.wiredOnly, true);
   assert.deepEqual(wired.wired, ['CLAUDE.md']);
   // The content was archived on the first pass, so wiring re-archives nothing.
   assert.deepEqual(wired.migrated, []);
   assert.equal(fs.existsSync(path.join(dir, 'docs', 'governance', 'imported-claude-2.md')), false);
   assert.equal(
      fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'),
      'Read ./docs/boot-profile.md first. It is the canonical context entrypoint for this repository.\n',
   );
   assert.equal(validateLayer(dir).findings.filter((f) => f.severity === 'error').length, 0);

   // Idempotent: everything already redirects, so there is nothing left to wire.
   const again = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.deepEqual(again.wired, []);
   assert.deepEqual(again.written, []);
   assert.match(enteringAdopted(again), /already redirects to the boot profile/);
});

test('adopt --wire-adapters archives a vendor file edited since adoption before overwriting it', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'original instructions\n');
   gitCommitAll(dir);
   await adoptLayer({ dir, yes: true });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'hand-written rules added after adoption\n');

   const wired = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.deepEqual(wired.migrated, ['CLAUDE.md'], 'the newer content is archived, never dropped');
   const archived = fs.readFileSync(path.join(dir, 'docs', 'governance', 'imported-claude-2.md'), 'utf8');
   assert.match(archived, /hand-written rules added after adoption/);
   assert.match(fs.readFileSync(path.join(dir, 'docs', 'governance', 'imported-claude.md'), 'utf8'), /original/);
   assert.equal(validateLayer(dir).findings.filter((f) => f.severity === 'error').length, 0);
});

test('adopt refuses an existing layer unless --wire-adapters asked for the wiring', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
   gitCommitAll(dir);
   await adoptLayer({ dir, yes: true });
   await assert.rejects(() => adoptLayer({ dir, yes: true }), /already has a Leji layer/);
});

test('init refuses to write through a symlinked context root that escapes the dir', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   // The context root `docs/` is a symlink to a real directory outside `dir`.
   fs.symlinkSync(outside, path.join(dir, 'docs'), 'dir');

   await assert.rejects(() => initLayer({ dir, yes: true }), /escapes the target/);

   // Nothing leaked into the outside directory through the escaping symlink.
   assert.deepEqual(fs.readdirSync(outside), [], 'no files written outside the target');
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('adopt --wire-adapters refuses to overwrite a symlinked-outside vendor file', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const secretPath = path.join(outside, 'secret.txt');
   fs.writeFileSync(secretPath, 'OUTSIDE SECRET CONTENT\n');
   // CLAUDE.md is a symlink pointing at a file outside the repository.
   fs.symlinkSync(secretPath, path.join(dir, 'CLAUDE.md'));
   gitCommitAll(dir);

   await adoptLayer({ dir, yes: true, wireAdapters: true });

   // The outside file is untouched and CLAUDE.md still points out (not overwritten).
   assert.equal(fs.readFileSync(secretPath, 'utf8'), 'OUTSIDE SECRET CONTENT\n');
   assert.ok(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink(), 'the symlink was not replaced');
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('adopt does not migrate a symlinked-outside vendor file', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const secretPath = path.join(outside, 'secret.txt');
   fs.writeFileSync(secretPath, 'TOP SECRET DO NOT MIGRATE\n');
   fs.symlinkSync(secretPath, path.join(dir, 'CLAUDE.md'));
   gitCommitAll(dir);

   const res = await adoptLayer({ dir, yes: true });

   assert.ok(!res.migrated.includes('CLAUDE.md'), 'an escaping symlink is treated as absent');
   const importedDir = path.join(dir, 'docs', 'governance');
   if (fs.existsSync(importedDir)) {
      for (const f of fs.readdirSync(importedDir)) {
         if (f.startsWith('imported-')) {
            assert.ok(
               !fs.readFileSync(path.join(importedDir, f), 'utf8').includes('TOP SECRET'),
               'the outside secret was never read into an imported doc',
            );
         }
      }
   }
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('migrationDoc fences migrated content so raw HTML is shown verbatim', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Instructions.\n<script>alert(1)</script>\n');
   gitCommitAll(dir);

   await adoptLayer({ dir, yes: true });

   const imported = fs.readFileSync(path.join(dir, 'docs', 'governance', 'imported-claude.md'), 'utf8');
   assert.match(imported, /```/, 'the migrated content is wrapped in a fenced code block');
   // The script text is present, inside the fence (not as a bare rendered line).
   const fenceMatch = imported.match(/(`{3,})\n([\s\S]*?)\n\1/);
   assert.ok(fenceMatch, 'a fenced code block delimits the imported content');
   assert.ok(fenceMatch![2].includes('<script>alert(1)</script>'), 'the raw script lives inside the fence');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('adopt does not re-migrate a file that is already the canonical redirect', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const { adapterContent } = await import('../dist/index.js');
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), adapterContent('docs/boot-profile.md'));
   gitCommitAll(dir);
   const res = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.ok(!res.migrated.includes('CLAUDE.md'), 'an existing canonical redirect is left alone, not archived');
});

// --- render-function unit coverage (these were only exercised via CLI dispatch) ---

test('renderWritePlan labels every status and summarizes counts', async () => {
   const { renderWritePlan } = await import('../dist/index.js');
   const out = renderWritePlan([
      { rel: 'leji.json', status: 'create' },
      { rel: 'docs/boot-profile.md', status: 'skip-exists' },
      { rel: 'CLAUDE.md', status: 'overwrite', note: 'convert' },
      { rel: 'AGENTS.md', status: 'wont-modify', note: 'read-only' },
   ]);
   assert.match(out, /create .*leji\.json/);
   assert.match(out, /skip .*docs\/boot-profile\.md/);
   assert.match(out, /overwrite .*CLAUDE\.md/);
   assert.match(out, /Will NOT modify/);
   assert.match(out, /AGENTS\.md/);
   assert.match(out, /1 to create, 1 already present.*1 to convert/);
});

test('renderDetect handles the no-hosts case and the ranked case', async () => {
   const { renderDetect, detectEcosystem } = await import('../dist/index.js');
   // A root with no manifest: the ecosystem line is present in both shapes and
   // says so, without changing what the host list reports.
   const ecosystem = detectEcosystem(tmpdir());
   assert.match(renderDetect({ hosts: [], ecosystem }), /No coding-agent hosts detected/);
   assert.match(renderDetect({ hosts: [], ecosystem }), /Ecosystem: none detected/);
   const ranked = renderDetect({
      ecosystem,
      hosts: [
         {
            id: 'claude-code',
            name: 'Claude Code',
            strength: 'confirmed',
            onPath: true,
            inRepo: false,
            userConfig: false,
            adapter: 'CLAUDE.md',
         },
         {
            id: 'cursor',
            name: 'Cursor',
            strength: 'project-present',
            onPath: false,
            inRepo: true,
            userConfig: false,
            adapter: '.cursor/rules/leji.md',
         },
      ],
   });
   assert.match(ranked, /confirmed.*Claude Code.*binary on PATH.*CLAUDE\.md/);
   assert.match(ranked, /Ecosystem: none detected/);
   assert.match(ranked, /leji init --agent/);
});

test('renderExplain covers the federated (top) and all-pass branches', async () => {
   const { renderExplain } = await import('../dist/index.js');
   const top = renderExplain({
      claimedLevel: 'federated',
      verifiedLevel: 'federated',
      items: [],
      findings: [],
   });
   assert.match(top, /top conformance level/);
   // verified core, all indexed items pass -> "set conformance.claimedLevel"
   const allPass = renderExplain({
      claimedLevel: 'core',
      verifiedLevel: 'core',
      items: [
         { id: 'index-current', level: 'indexed', description: 'index', status: 'pass' },
         { id: 'changelog', level: 'indexed', description: 'changelog', status: 'pass' },
      ],
      findings: [],
   });
   assert.match(allPass, /all "indexed" checks already pass/);
});

test('validate --content thin-category boundary: 2 bullets warns, 3 does not', async () => {
   const two = tmpdir();
   await initLayer({ dir: two, yes: true });
   fs.writeFileSync(
      path.join(two, 'docs', 'domain', 'glossary.md'),
      '# Glossary\n\n- Real term one.\n- Real term two.\n',
   );
   assert.ok(
      validateLayer(two, { content: true }).findings.some(
         (f) => f.rule === 'content-thin' && f.path === 'docs/context/domain.md',
      ),
      'two concrete bullets is still thin',
   );

   const three = tmpdir();
   await initLayer({ dir: three, yes: true });
   fs.writeFileSync(path.join(three, 'docs', 'domain', 'glossary.md'), '# Glossary\n\n- One.\n- Two.\n- Three.\n');
   assert.ok(
      !validateLayer(three, { content: true }).findings.some(
         (f) => f.rule === 'content-thin' && f.path === 'docs/context/domain.md',
      ),
      'three concrete bullets clears the thin threshold',
   );
});

test('validate --content flags an angle-bracket placeholder, not just TODO', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   fs.writeFileSync(
      path.join(dir, 'docs', 'system', 'invariants.md'),
      '# Invariants\n\n- <describe an invariant here>\n',
   );
   const placeholders = validateLayer(dir, { content: true }).findings.filter((f) => f.rule === 'content-placeholder');
   assert.ok(placeholders.some((f) => f.path === 'docs/system/invariants.md'));
});

test('detectHosts requires an executable bit on POSIX (non-executable file is not confirmed)', () => {
   const root = tmpdir();
   const binDir = tmpdir();
   fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 }); // executable
   fs.writeFileSync(path.join(binDir, 'codex'), 'plain text\n', { mode: 0o644 }); // NOT executable
   const home = tmpdir();
   const hosts = detectHosts({ root, env: { PATH: binDir }, homedir: home, platform: 'linux' });
   const claude = hosts.find((h) => h.id === 'claude-code');
   const codex = hosts.find((h) => h.id === 'codex');
   assert.equal(claude?.onPath, true, 'executable claude is confirmed on PATH');
   // codex has no executable on PATH and no repo/user signal, so it is absent.
   assert.equal(codex, undefined, 'a non-executable file named codex is not a confirmed host');
});

test('validate --content flags unconfirmed inferences and proposed decisions', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   // An agent-drafted, owner-unconfirmed invariant marker.
   fs.writeFileSync(
      path.join(dir, 'docs', 'system', 'invariants.md'),
      '# System Invariants\n\n- TODO(confirm-invariant): money is integer minor units\n',
   );
   // An agent-proposed decision, not yet owner-accepted.
   fs.writeFileSync(
      path.join(dir, 'docs', 'decisions', '0002-proposed.md'),
      '---\nid: use-postgres\ntitle: Use Postgres\nstatus: proposed\ndate: 2026-06-18\n---\n\n# Use Postgres\n\n## Context\nx\n## Decision\ny\n## Consequences\nz\n',
   );
   const result = validateLayer(dir, { content: true });
   const unconfirmed = result.findings.filter((f) => f.rule === 'content-unconfirmed');
   assert.ok(
      unconfirmed.some((f) => f.path === 'docs/system/invariants.md'),
      'flags the TODO(confirm-…) marker',
   );
   assert.ok(
      unconfirmed.some((f) => /proposed/.test(f.message)),
      'flags the status: proposed decision',
   );
   // Warning-only: an unconfirmed layer is not an error.
   assert.equal(result.findings.filter((f) => f.severity === 'error').length, 0);
   // The TODO(confirm-…) marker must NOT also trip the plain content-placeholder rule.
   assert.ok(!result.findings.some((f) => f.rule === 'content-placeholder' && f.path === 'docs/system/invariants.md'));
});

test('adopt is collision-aware: existing context/ and agents/ resolve to safe alternates', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
   // Pre-existing content occupying the default scaffold paths.
   fs.mkdirSync(path.join(dir, 'docs', 'context'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs', 'context', 'existing.md'), '# Pre-existing context dir\n');
   fs.mkdirSync(path.join(dir, 'docs', 'agents'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs', 'agents', 'existing.md'), '# Pre-existing agents dir\n');
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });

   await adoptLayer({ dir, yes: true });
   const { manifest } = loadManifest(dir);

   // The index dir resolved to a non-colliding alternate, recorded via the category paths.
   const domainIndex = manifest!.categories.domain!.indexes[0];
   assert.ok(!domainIndex.startsWith('docs/context/'), `index dir avoided the collision: ${domainIndex}`);
   assert.match(domainIndex, /^docs\/(leji-context|context-layer)\//);
   // The agents dir resolved to an alternate, recorded in the manifest machine block.
   assert.ok(
      manifest!.machine?.agentProfilesPath && manifest!.machine.agentProfilesPath !== 'docs/agents/',
      'agents dir resolved to a recorded alternate',
   );
   // The pre-existing content was left untouched.
   assert.equal(
      fs.readFileSync(path.join(dir, 'docs', 'context', 'existing.md'), 'utf8'),
      '# Pre-existing context dir\n',
   );
   // The adopted layer validates clean.
   assert.equal(validateLayer(dir).findings.filter((f) => f.severity === 'error').length, 0, 'adopted layer is clean');
});

test('adopt --wire-adapters never loses vendor content when the migration name collides', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Original agent rules: always run tests.\n');
   // A pre-existing file already occupies the default migration-doc name.
   fs.mkdirSync(path.join(dir, 'docs', 'governance'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs', 'governance', 'imported-claude.md'), '# Unrelated pre-existing file\n');
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });

   await adoptLayer({ dir, yes: true, wireAdapters: true });

   // The pre-existing file is untouched.
   assert.equal(
      fs.readFileSync(path.join(dir, 'docs', 'governance', 'imported-claude.md'), 'utf8'),
      '# Unrelated pre-existing file\n',
   );
   // The original CLAUDE.md content was migrated to a collision-free name, not lost.
   const alt = path.join(dir, 'docs', 'governance', 'imported-claude-2.md');
   assert.ok(fs.existsSync(alt), 'migration doc resolved to a collision-free alternate');
   assert.match(fs.readFileSync(alt, 'utf8'), /always run tests/);
   // CLAUDE.md was converted to a redirect, which is safe only because its content survived.
   assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /docs\/boot-profile\.md/);
});

test('adopt --wire-adapters: a dangling archive candidate is occupied, never written through', async () => {
   // `existsSync` follows symlinks, so a dangling candidate reads as a free name and the
   // archive would be created at the link's missing destination. The candidate is judged
   // by the verified read instead: a standing entry this run cannot verify is occupied.
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'original instructions\n');
   gitCommitAll(dir);
   await adoptLayer({ dir, yes: true });

   const candidate = path.join(dir, 'docs', 'governance', 'imported-claude.md');
   fs.rmSync(candidate);
   fs.symlinkSync('never-created.md', candidate);
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'hand-written rules added after adoption\n');

   const wired = await adoptLayer({ dir, yes: true, wireAdapters: true });

   assert.deepEqual(wired.migrated, ['CLAUDE.md'], 'the newer content is still archived');
   assert.equal(
      fs.existsSync(path.join(dir, 'docs', 'governance', 'never-created.md')),
      false,
      "the dangling link's destination is never created",
   );
   assert.ok(fs.lstatSync(candidate).isSymbolicLink(), 'the planted link is left exactly as it was');
   const alt = path.join(dir, 'docs', 'governance', 'imported-claude-2.md');
   assert.match(fs.readFileSync(alt, 'utf8'), /hand-written rules added after adoption/, 'the next name is used');
});

test('adopt --wire-adapters: an archive candidate resolving outside the repository is occupied', async () => {
   const dir = tmpdir();
   const outsideFile = path.join(tmpdir(), 'outside.md');
   fs.writeFileSync(outsideFile, '# Outside the repository\n');
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'original instructions\n');
   gitCommitAll(dir);
   await adoptLayer({ dir, yes: true });

   const candidate = path.join(dir, 'docs', 'governance', 'imported-claude.md');
   fs.rmSync(candidate);
   fs.symlinkSync(outsideFile, candidate);
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'hand-written rules added after adoption\n');

   await adoptLayer({ dir, yes: true, wireAdapters: true });

   assert.equal(fs.readFileSync(outsideFile, 'utf8'), '# Outside the repository\n', 'the outside file is untouched');
   const alt = path.join(dir, 'docs', 'governance', 'imported-claude-2.md');
   assert.match(fs.readFileSync(alt, 'utf8'), /hand-written rules added after adoption/, 'the next name is used');
});

test('init: a dangling symlink at a scaffold target is refused, never written through', async () => {
   // `existsSync` follows symlinks, so a dangling target reads as absent and the
   // guarded write lands at the link's destination — inside the root, but under a
   // name init never planned. The verified read refuses the standing entry instead.
   const dir = tmpdir();
   fs.mkdirSync(path.join(dir, 'docs'));
   const target = path.join(dir, 'docs', 'boot-profile.md');
   fs.symlinkSync('never-created.md', target);

   await assert.rejects(() => initLayer({ dir, yes: true }), /escapes the target/);

   assert.equal(
      fs.existsSync(path.join(dir, 'docs', 'never-created.md')),
      false,
      "the dangling link's destination is never created",
   );
   assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the planted link is left exactly as it was');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('init: a scaffold target symlinked outside the repository is refused, not skipped', async () => {
   // A pathname check sees the link's outside target and reads the name as taken, so
   // init would quietly skip the file it owns. The verified read judges where the
   // entry resolves: outside the root is the same hard refusal a write to it is.
   const dir = tmpdir();
   const outside = tmpdir();
   const outsideFile = path.join(outside, 'boot-profile.md');
   fs.writeFileSync(outsideFile, '# Outside the repository\n');
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.symlinkSync(outsideFile, path.join(dir, 'docs', 'boot-profile.md'));

   await assert.rejects(() => initLayer({ dir, yes: true }), /escapes the target/);

   assert.equal(fs.readFileSync(outsideFile, 'utf8'), '# Outside the repository\n', 'the outside file is untouched');
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('adopt: a dangling migration-doc name is occupied, never written through', async () => {
   // The disambiguation loop picks the archive's name. A dangling candidate read by
   // pathname is a free name, and the migrated content would land at the link's
   // missing destination; the verified read makes any standing entry occupied.
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'original instructions\n');
   fs.mkdirSync(path.join(dir, 'docs', 'governance'), { recursive: true });
   const candidate = path.join(dir, 'docs', 'governance', 'imported-claude.md');
   fs.symlinkSync('never-created.md', candidate);
   gitCommitAll(dir);

   const res = await adoptLayer({ dir, yes: true });

   assert.deepEqual(res.migrated, ['CLAUDE.md'], 'the vendor content is still migrated');
   assert.equal(
      fs.existsSync(path.join(dir, 'docs', 'governance', 'never-created.md')),
      false,
      "the dangling link's destination is never created",
   );
   assert.ok(fs.lstatSync(candidate).isSymbolicLink(), 'the planted link is left exactly as it was');
   const alt = path.join(dir, 'docs', 'governance', 'imported-claude-2.md');
   assert.match(fs.readFileSync(alt, 'utf8'), /original instructions/, 'the next name is used');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('adopt: a migration-doc name resolving outside the repository is occupied', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'original instructions\n');
   fs.mkdirSync(path.join(dir, 'docs', 'governance'), { recursive: true });
   const candidate = path.join(dir, 'docs', 'governance', 'imported-claude.md');
   fs.symlinkSync(path.join(outside, 'never-created.md'), candidate);
   gitCommitAll(dir);

   const res = await adoptLayer({ dir, yes: true });

   assert.deepEqual(res.migrated, ['CLAUDE.md'], 'the vendor content is still migrated');
   assert.deepEqual(fs.readdirSync(outside), [], 'nothing is written outside the repository');
   const alt = path.join(dir, 'docs', 'governance', 'imported-claude-2.md');
   assert.match(fs.readFileSync(alt, 'utf8'), /original instructions/, 'the next name is used');
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('adopt: a dangling scaffold name is occupied, and the alternate name is scaffolded', async () => {
   // The scaffold names were picked with `existsSync`, which follows symlinks: a dangling
   // boot-profile link read as a free name, and the scaffold would have been written at
   // the link's missing destination. The verified read makes any standing entry occupied,
   // so the alternate name is taken exactly as it is for an ordinary existing file.
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.writeFileSync(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
   const link = path.join(dir, 'docs', 'boot-profile.md');
   fs.symlinkSync('never-created.md', link);
   gitCommitAll(dir);

   const res = await adoptLayer({ dir, yes: true });

   assert.equal(res.manifest.bootProfilePath, 'docs/leji-boot-profile.md', 'the alternate name is scaffolded');
   assert.equal(
      fs.existsSync(path.join(dir, 'docs', 'never-created.md')),
      false,
      "the dangling link's destination is never created",
   );
   assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the planted link is left exactly as it was');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('adopt: a scaffold name resolving outside the repository is occupied', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   const outsideFile = path.join(outside, 'boot-profile.md');
   fs.writeFileSync(outsideFile, '# Outside the repository\n');
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.writeFileSync(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
   fs.symlinkSync(outsideFile, path.join(dir, 'docs', 'boot-profile.md'));
   gitCommitAll(dir);

   const res = await adoptLayer({ dir, yes: true });

   assert.equal(res.manifest.bootProfilePath, 'docs/leji-boot-profile.md', 'the alternate name is scaffolded');
   assert.equal(fs.readFileSync(outsideFile, 'utf8'), '# Outside the repository\n', 'the outside file is untouched');
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('leji agent: a dangling profile name refuses the command, writing neither half', async () => {
   // `isFile` follows symlinks, so a dangling profile link read as absent and the profile
   // was written at the link's destination. Both halves are judged before either is
   // written, so a refused profile leaves the manifest binding unwritten too.
   const dir = tmpdir();
   await initLayer({ dir, yes: true, name: 'demo' });
   const { manifest } = loadManifest(dir);
   const link = path.join(dir, 'docs', 'agents', 'reviewer.md');
   fs.mkdirSync(path.dirname(link), { recursive: true });
   fs.symlinkSync('never-created.md', link);
   const before = fs.readFileSync(path.join(dir, 'leji.json'), 'utf8');

   assert.throws(() => addAgent(dir, manifest!, { host: 'codex', name: 'reviewer' }), /escapes the target/);

   assert.equal(
      fs.existsSync(path.join(dir, 'docs', 'agents', 'never-created.md')),
      false,
      "the dangling link's destination is never created",
   );
   assert.equal(fs.readFileSync(path.join(dir, 'leji.json'), 'utf8'), before, 'the manifest is not rewritten');
   assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the planted link is left exactly as it was');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('leji agent: a profile name resolving outside the repository refuses, writing neither half', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   const outsideFile = path.join(outside, 'reviewer.md');
   fs.writeFileSync(outsideFile, '# Outside the repository\n');
   await initLayer({ dir, yes: true, name: 'demo' });
   const { manifest } = loadManifest(dir);
   fs.mkdirSync(path.join(dir, 'docs', 'agents'), { recursive: true });
   fs.symlinkSync(outsideFile, path.join(dir, 'docs', 'agents', 'reviewer.md'));
   const before = fs.readFileSync(path.join(dir, 'leji.json'), 'utf8');

   assert.throws(() => addAgent(dir, manifest!, { host: 'codex', name: 'reviewer' }), /escapes the target/);

   assert.equal(fs.readFileSync(outsideFile, 'utf8'), '# Outside the repository\n', 'the outside file is untouched');
   assert.equal(fs.readFileSync(path.join(dir, 'leji.json'), 'utf8'), before, 'the manifest is not rewritten');
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

const BROKEN_DOT_ROOT_PATHS =
   /\.boot-profile\.md|\.agents\/|\.governance\/|\.domain\/|\.decisions\/|\.context\/|\.\.leji\//;

test('leji agent: a reviewer profile under a "." root has repo-root requiredRead (not .boot-profile.md / .agents/)', () => {
   const dir = tmpdir();
   const manifestObj = {
      leji: '1.0',
      name: 'dotroot',
      rootPath: '.',
      bootProfilePath: 'boot-profile.md',
      categories: {
         domain: { indexes: ['context/domain.md'] },
         decisions: { indexes: ['context/decisions.md'] },
      },
      owners: { primary: { name: 'Owner' } },
   };
   fs.writeFileSync(path.join(dir, 'leji.json'), JSON.stringify(manifestObj, null, 2) + '\n');
   const { manifest } = loadManifest(dir);
   addAgent(dir, manifest!, { host: 'codex', name: 'reviewer' });
   const profile = fs.readFileSync(path.join(dir, 'agents', 'reviewer.md'), 'utf8');
   assert.doesNotMatch(profile, BROKEN_DOT_ROOT_PATHS, 'requiredRead has no hidden .boot-profile.md / .agents/');
   assert.match(
      profile,
      /requiredRead:\n {2}- boot-profile\.md\n {2}- agents\/core\.md/,
      'requiredRead uses correct repo-root paths',
   );
});

test('adopt summary under a "." root references governance/ and .leji/, never .governance/ or ..leji/', () => {
   // adopt detects a docs/ root in practice; this exercises the "." root path of the
   // governance/brief references in the user-visible summary directly.
   const summary = enteringAdopted({
      manifest: { rootPath: '.' },
      migrated: ['CLAUDE.md'],
      draft: false,
   } as Parameters<typeof enteringAdopted>[0]);
   assert.doesNotMatch(summary, BROKEN_DOT_ROOT_PATHS, 'no .governance/ or ..leji/ in the summary');
   assert.match(summary, /into governance\//, 'migrated into governance/');
   assert.match(summary, /\.leji\/work\/onboarding-brief\.md/, 'brief path is .leji/work/onboarding-brief.md');
});

// --- MCP install offer (pre-handoff) ---

const CLAUDE_MCP_ADD = ['mcp', 'add', 'leji', '--scope', 'project', '--', 'npx', '-y', '@leji-org/mcp'];
const CODEX_MCP_ADD = ['mcp', 'add', 'leji', '--', 'npx', '-y', '@leji-org/mcp'];
const MCP_CHECK = ['mcp', 'get', 'leji'];
// A presence check that reports "absent" (exit 1) so the offer fires; the register
// then reports clean (exit 0).
const ABSENT_THEN_OK: SpawnResult[] = [{ status: 1 }, { status: 0 }];

test('offerMcpInstall never fires non-interactively', async () => {
   const f = fakeIo('y', undefined, ABSENT_THEN_OK);
   await offerMcpInstall({ root: '/repo', detected: [CLAUDE], interactive: false, io: f.io });
   assert.equal(f.questions.length, 0);
   assert.equal(f.runs.length, 0);
});

test('offerMcpInstall makes no offer without a launchable host', async () => {
   const f = fakeIo('y', undefined, ABSENT_THEN_OK);
   await offerMcpInstall({ root: '/repo', detected: [CURSOR], interactive: true, io: f.io });
   assert.equal(f.questions.length, 0);
   assert.equal(f.runs.length, 0);
});

test('offerMcpInstall registers on accept, anchored at the layer root', async () => {
   const f = fakeIo('', undefined, ABSENT_THEN_OK); // empty answer = Y default
   await offerMcpInstall({ root: '/repo', detected: [CLAUDE], interactive: true, io: f.io });
   assert.equal(f.questions.length, 1);
   // First run is the quiet presence check; second is the register, both at the root.
   assert.deepEqual(f.runs[0], { bin: 'claude', args: MCP_CHECK, cwd: '/repo', quiet: true });
   assert.deepEqual(f.runs[1], { bin: 'claude', args: CLAUDE_MCP_ADD, cwd: '/repo', quiet: false });
});

test('offerMcpInstall skips (no prompt, no register) when already registered', async () => {
   const f = fakeIo('y', undefined, [{ status: 0 }]); // check reports present
   await offerMcpInstall({ root: '/repo', detected: [CLAUDE], interactive: true, io: f.io });
   assert.equal(f.questions.length, 0, 'no nag when present');
   assert.equal(f.runs.length, 1, 'only the presence check ran');
   assert.equal(f.runs[0].quiet, true);
});

test('offerMcpInstall declines on n: checks, prompts, but does not register', async () => {
   const f = fakeIo('n', undefined, ABSENT_THEN_OK);
   await offerMcpInstall({ root: '/repo', detected: [CLAUDE], interactive: true, io: f.io });
   assert.equal(f.questions.length, 1);
   assert.equal(f.runs.length, 1, 'only the presence check ran; no register');
});

test('offerMcpInstall with several hosts asks the pick once, then registers for the pick', async () => {
   const f = fakeIo(['2', 'y'], undefined, ABSENT_THEN_OK);
   const outcome = await offerMcpInstall({ root: '/repo', detected: [CLAUDE, CODEX], interactive: true, io: f.io });
   assert.match(f.questions[0], /Which agent\?/, 'the host pick comes before the MCP question');
   assert.equal(f.runs[1].bin, 'codex', 'registers for the picked host, not the top-ranked one');
   assert.deepEqual(f.runs[1].args, CODEX_MCP_ADD);
   assert.deepEqual(outcome, { next: 'launch', host: { id: 'codex', bin: 'codex', name: 'Codex' } });
});

test('offerMcpInstall returns skip when the pick is declined: no MCP prompt, no runs', async () => {
   const f = fakeIo([''], undefined, ABSENT_THEN_OK);
   const outcome = await offerMcpInstall({ root: '/repo', detected: [CLAUDE, CODEX], interactive: true, io: f.io });
   assert.deepEqual(outcome, { next: 'skip' });
   assert.equal(f.questions.length, 1, 'only the pick was asked');
   assert.equal(f.runs.length, 0, 'no check or register for a declined pick');
});

test('offerMcpInstall single host returns default: the handoff keeps its own confirm', async () => {
   const f = fakeIo('y', undefined, ABSENT_THEN_OK);
   const outcome = await offerMcpInstall({ root: '/repo', detected: [CLAUDE], interactive: true, io: f.io });
   assert.deepEqual(outcome, { next: 'default' });
});

test('handoffOffer launches the MCP-picked host without re-asking', async () => {
   const f = fakeIo('never-read');
   const launched = await handoffOffer(manifestAt('docs/'), [CLAUDE, CODEX], true, f.io, undefined, '/repo', {
      next: 'launch',
      host: { id: 'codex', bin: 'codex', name: 'Codex' },
   });
   assert.equal(launched, true);
   assert.equal(f.questions.length, 0, 'no second pick, no confirm');
   assert.equal(f.launches[0].bin, 'codex');
});

test('handoffOffer honors a skipped MCP pick: no prompt, no launch', async () => {
   const f = fakeIo('never-read');
   const launched = await handoffOffer(manifestAt('docs/'), [CLAUDE, CODEX], true, f.io, undefined, '/repo', {
      next: 'skip',
   });
   assert.equal(launched, false);
   assert.equal(f.questions.length, 0);
   assert.equal(f.launches.length, 0);
});

test('offer + handoff compose: the register targets the host that launches, in that order', async () => {
   const f = fakeIo(['2', 'y'], undefined, ABSENT_THEN_OK);
   const outcome = await offerMcpInstall({ root: '/repo', detected: [CLAUDE, CODEX], interactive: true, io: f.io });
   await handoffOffer(manifestAt('docs/'), [CLAUDE, CODEX], true, f.io, undefined, '/repo', outcome);
   // check, register, launch: all codex, register strictly before the launch.
   assert.deepEqual(f.events, ['run:codex', 'run:codex', 'launch:codex']);
});

test('offerMcpInstall honors --agent, using that host’s register command', async () => {
   const f = fakeIo('y', undefined, ABSENT_THEN_OK);
   // Codex not even detected; --agent forces it, and its argv omits --scope project.
   await offerMcpInstall({ root: '/repo', detected: [CLAUDE], interactive: true, io: f.io, agent: 'codex' });
   assert.equal(f.runs[1].bin, 'codex');
   assert.deepEqual(f.runs[1].args, CODEX_MCP_ADD);
});

test('offerMcpInstall never throws when the register fails', async () => {
   const f = fakeIo('y', undefined, [{ status: 1 }, { error: new Error('spawn claude ENOENT') }]);
   await offerMcpInstall({ root: '/repo', detected: [CLAUDE], interactive: true, io: f.io });
   assert.equal(f.runs.length, 2, 'check then attempted register');
});

// --- working mode (solo / team) ---

/** Every file under dir (repo-relative POSIX), sorted, with contents. */
function fileTree(dir: string): Map<string, string> {
   const out = new Map<string, string>();
   const walk = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
         if (entry.name === '.git') continue;
         const childRel = rel ? `${rel}/${entry.name}` : entry.name;
         if (entry.isDirectory()) walk(childRel);
         else out.set(childRel, fs.readFileSync(path.join(dir, childRel), 'utf8'));
      }
   };
   walk('');
   return out;
}

test('init --mode solo scaffolds the identity and writing-style starters', async () => {
   const dir = tmpdir();
   const result = await initLayer({ dir, yes: true, mode: 'solo' });

   assert.equal(result.mode, 'solo');
   assert.ok(result.written.includes('docs/domain/identity.md'));
   assert.ok(result.written.includes('docs/practice/writing-style.md'));
   assert.ok(fs.readFileSync(path.join(dir, 'docs/domain/identity.md'), 'utf8').includes('## Source basis'));
   assert.ok(fs.readFileSync(path.join(dir, 'docs/practice/writing-style.md'), 'utf8').includes('## Source basis'));

   const { manifest } = loadManifest(dir);
   // Solo forces domain + practice; canonical category order in the manifest.
   assert.deepEqual(Object.keys(manifest!.categories), ['domain', 'system', 'practice', 'decisions']);
});

test('solo boot profile routes identity and writing work by task, never preloaded', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true, mode: 'solo' });
   const boot = fs.readFileSync(path.join(dir, 'docs/boot-profile.md'), 'utf8');

   const unconditional = boot.slice(0, boot.indexOf('Load by task type'));
   const routed = boot.slice(boot.indexOf('Load by task type'));
   assert.ok(routed.includes('`docs/domain/identity.md`'), 'identity routed by task');
   assert.ok(routed.includes('`docs/practice/writing-style.md`'), 'writing style routed by task');
   assert.ok(!unconditional.includes('identity.md'), 'identity never in the unconditional set');
   assert.ok(!unconditional.includes('writing-style.md'), 'writing style never in the unconditional set');
});

test('solo brief is mode-stamped and carries the interview and artifact rules', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true, mode: 'solo' });
   const brief = fs.readFileSync(path.join(dir, '.leji/work/onboarding-brief.md'), 'utf8');

   assert.ok(brief.includes('**Working mode:** solo'));
   assert.ok(brief.includes('.leji/work/onboarding-inputs/'), 'drop folder sits in the workspace role');
   assert.ok(brief.includes('untrusted data'), 'artifact consent rules present');
   assert.ok(!brief.includes('<mode>'), 'no unreplaced mode marker');
   assert.ok(!brief.includes('<root>/'), 'no unreplaced root marker');
});

test('omitted mode and explicit --mode team are byte-identical, with no solo starters', async () => {
   const a = tmpdir();
   const b = tmpdir();
   await initLayer({ dir: a, yes: true, name: 'acme-context' });
   const result = await initLayer({ dir: b, yes: true, name: 'acme-context', mode: 'team' });

   assert.equal(result.mode, 'team');
   assert.deepEqual([...fileTree(a).keys()], [...fileTree(b).keys()]);
   // The scaffold now writes a context index at every level, and its `generatedAt`
   // is wall-clock: two runs a millisecond apart differ there and nowhere else.
   // Null it the way the cross-SDK parity harness does, so this stays a byte
   // comparison of everything the two modes actually control.
   const stable = (rel: string, content: string): string =>
      rel.endsWith('context-index.json') ? content.replace(/("generatedAt": ")[^"]*"/, '$1<GENERATED_AT>"') : content;
   for (const [rel, content] of fileTree(a)) {
      assert.equal(
         stable(rel, content),
         stable(rel, fileTree(b).get(rel) as string),
         `${rel} differs between omitted and explicit team`,
      );
   }
   assert.ok(!fs.existsSync(path.join(a, 'docs/domain/identity.md')), 'team scaffolds no identity starter');
   const brief = fs.readFileSync(path.join(a, '.leji/work/onboarding-brief.md'), 'utf8');
   assert.ok(brief.includes('**Working mode:** team'), 'team brief carries a concrete stamp');
});

test('an invalid mode fails before any filesystem mutation', async () => {
   const dir = tmpdir();
   await assert.rejects(
      // Direct SDK callers can pass arbitrary strings; validation happens pre-write.
      initLayer({ dir, yes: true, mode: 'squad' as 'solo' }),
      /--mode must be solo or team/,
   );
   assert.equal(fs.readdirSync(dir).length, 0, 'nothing written');
});

test('init --mode solo --dry-run writes nothing and plans both starters', async () => {
   const dir = tmpdir();
   const result = await initLayer({ dir, yes: true, mode: 'solo', dryRun: true });

   assert.equal(result.dryRun, true);
   assert.equal(result.mode, 'solo');
   assert.deepEqual(result.written, []);
   assert.equal(fs.readdirSync(dir).length, 0, 'dry-run touches nothing');
   const creates = result.plan.filter((e) => e.status === 'create').map((e) => e.rel);
   assert.ok(creates.includes('docs/domain/identity.md'));
   assert.ok(creates.includes('docs/practice/writing-style.md'));
});

test('indexed solo init seeds the changelog with the starters and no dot-paths', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true, mode: 'solo', level: 'indexed' });
   const changelog = JSON.parse(fs.readFileSync(path.join(dir, 'docs/context-changelog.json'), 'utf8'));
   const paths: string[] = changelog.entries[0].paths;

   assert.ok(paths.includes('docs/domain/identity.md'));
   assert.ok(paths.includes('docs/practice/writing-style.md'));
   assert.ok(
      !paths.some((p: string) => p.split('/').some((seg: string) => seg.startsWith('.'))),
      'the transient brief and other dot-paths never seed the machine changelog',
   );
});

test('adopt --mode solo scaffolds the starters and maps practice', async () => {
   const dir = tmpdir();
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.writeFileSync(path.join(dir, 'docs/notes.md'), '# Notes\n');
   const result = await adoptLayer({ dir, yes: true, mode: 'solo' });

   assert.equal(result.mode, 'solo');
   assert.ok(result.written.includes('docs/domain/identity.md'));
   assert.ok(result.written.includes('docs/practice/writing-style.md'));
   const { manifest } = loadManifest(dir);
   assert.deepEqual(Object.keys(manifest!.categories), ['domain', 'system', 'practice', 'decisions']);
});

test('adopt --mode solo never overwrites an existing identity or writing-style doc', async () => {
   const dir = tmpdir();
   fs.mkdirSync(path.join(dir, 'docs/domain'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs/domain/identity.md'), '# Mine already\n');
   const result = await adoptLayer({ dir, yes: true, mode: 'solo' });

   assert.equal(fs.readFileSync(path.join(dir, 'docs/domain/identity.md'), 'utf8'), '# Mine already\n');
   assert.ok(!result.written.includes('docs/domain/identity.md'), 'existing file is skipped, not written');
   const planned = result.plan.find((e) => e.rel === 'docs/domain/identity.md');
   assert.equal(planned?.status, 'skip-exists');
});

test('adopt --mode solo --dry-run writes nothing and plans the starters', async () => {
   const dir = tmpdir();
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.writeFileSync(path.join(dir, 'docs/notes.md'), '# Notes\n');
   const result = await adoptLayer({ dir, yes: true, mode: 'solo', dryRun: true });

   assert.equal(result.dryRun, true);
   assert.deepEqual(result.written, []);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false);
   const creates = result.plan.filter((e) => e.status === 'create').map((e) => e.rel);
   assert.ok(creates.includes('docs/domain/identity.md'));
   assert.ok(creates.includes('docs/practice/writing-style.md'));
});

test('init refuses while files under .leji/ are tracked by git, leaving the tree untouched', async () => {
   const dir = tmpdir();
   const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
   git('init', '-q');
   git('config', 'user.name', 'T');
   git('config', 'user.email', 't@example.com');
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   fs.writeFileSync(path.join(dir, '.leji/stale.md'), 'tracked artifact\n');
   git('add', '-A');
   git('commit', '-qm', 'seed');

   await assert.rejects(initLayer({ dir, yes: true, mode: 'solo' }), /tracked by git/);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false, 'no scaffold written');
   assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false, 'not even the ignore file is written');
});

test('approval guard: installs idempotently and preserves existing settings', () => {
   const dir = tmpdir();
   fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
   fs.writeFileSync(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify(
         {
            existing: true,
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
         },
         null,
         2,
      ),
   );
   assert.equal(ensureApprovalGuard(dir, 'docs/'), 'installed');
   assert.equal(ensureApprovalGuard(dir, 'docs/'), 'unchanged');
   const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
   assert.equal(settings.existing, true, 'unrelated settings preserved');
   const matchers = settings.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher);
   assert.deepEqual(matchers, ['Bash', 'AskUserQuestion']);
   assert.ok(fs.existsSync(path.join(dir, '.leji', 'work', 'hooks', 'approval-guard.mjs')));
});

test('approval guard: blocks until written and printed, inert after onboarding', () => {
   const dir = tmpdir();
   ensureApprovalGuard(dir, 'docs/');
   const lejiDir = path.join(dir, '.leji', 'work');
   const script = path.join(lejiDir, 'hooks', 'approval-guard.mjs');
   fs.writeFileSync(path.join(lejiDir, 'onboarding-brief.md'), 'brief');
   const run = (transcript: string): number =>
      spawnSync('node', [script], {
         input: JSON.stringify({ transcript_path: transcript }),
         env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      }).status ?? -1;
   assert.equal(run('/nonexistent'), 2, 'no proposal: blocked');
   fs.writeFileSync(path.join(lejiDir, 'proposal.md'), '# Proposal for approval\n\nbody\n');
   const t1 = path.join(dir, 't1.jsonl');
   fs.writeFileSync(
      t1,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'about to ask' }] } }) + '\n',
   );
   assert.equal(run(t1), 2, 'written but not printed: blocked');
   const t2 = path.join(dir, 't2.jsonl');
   fs.writeFileSync(
      t2,
      JSON.stringify({
         type: 'assistant',
         message: { content: [{ type: 'text', text: '# Proposal for approval\nbody' }] },
      }) + '\n',
   );
   assert.equal(run(t2), 0, 'written and printed: allowed');
   fs.rmSync(path.join(lejiDir, 'onboarding-brief.md'));
   assert.equal(run('/nonexistent'), 0, 'brief gone: guard inert');
});
