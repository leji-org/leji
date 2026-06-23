import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
   addAgent,
   adoptLayer,
   detectHosts,
   enterLayer,
   handoffOffer,
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
   assert.ok(creates.includes('docs/.leji/onboarding-brief.md'));
   // The existing vendor file is detected and explicitly left untouched.
   const untouched = result.plan.find((e) => e.rel === 'CLAUDE.md');
   assert.equal(untouched?.status, 'wont-modify');
});

test('init writes the onboarding brief under a dot-dir, excluded from the index', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true, level: 'indexed', name: 'acme-context' });

   const brief = path.join(dir, 'docs', '.leji', 'onboarding-brief.md');
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
function fakeIo(
   answer: string,
   launchResult?: { error?: Error; status?: number | null; signal?: NodeJS.Signals | null },
) {
   const launches: { bin: string; promptArg: string }[] = [];
   const cwds: (string | undefined)[] = [];
   const questions: string[] = [];
   const io = {
      async readLine(q: string) {
         questions.push(q);
         return answer;
      },
      launch(bin: string, promptArg: string, cwd?: string) {
         launches.push({ bin, promptArg });
         cwds.push(cwd);
         return launchResult ?? { status: 0 };
      },
   };
   return { io, launches, questions, cwds };
}

const BRIEF_PROMPT = 'Read ./docs/.leji/onboarding-brief.md and follow it.';

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

test('handoffOffer threads the layer root into the brief prompt', async () => {
   const f = fakeIo('y');
   assert.equal(await handoffOffer(manifestAt('context/'), [CLAUDE], true, f.io), true);
   assert.deepEqual(f.launches, [
      { bin: 'claude', promptArg: 'Read ./context/.leji/onboarding-brief.md and follow it.' },
   ]);
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

test('init --agent no longer errors on an unknown agent (adapter resolution is gone)', async () => {
   const dir = tmpdir();
   // init --agent no longer resolves a vendor adapter, so a bogus --agent no
   // longer errors from adapter resolution: the layer scaffolds with no vendor file.
   const res = await initLayer({ dir, yes: true, agent: 'frobnicate' });
   assert.ok(res.written.includes('leji.json'));
   assert.ok(!loadManifest(dir).manifest!.vendorAdapters);
   assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
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
   // The agent's binding; no vendor adapter is created.
   assert.equal(manifest!.agents?.reviewer, 'docs/agents/reviewer.md');
   assert.ok(!manifest!.vendorAdapters);
   assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
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

test('init --agent cursor no longer creates a directory-style adapter and validates clean', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const res = await initLayer({ dir, yes: true, agent: 'cursor' });
   assert.ok(!res.written.includes('.cursor/rules/leji.md'), 'init --agent no longer creates an adapter');
   assert.equal(fs.existsSync(path.join(dir, '.cursor', 'rules', 'leji.md')), false);
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
   const { renderDetect } = await import('../dist/index.js');
   assert.match(renderDetect([]), /No coding-agent hosts detected/);
   const ranked = renderDetect([
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
   ]);
   assert.match(ranked, /confirmed.*Claude Code.*binary on PATH.*CLAUDE\.md/);
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
         (f) => f.rule === 'content-thin' && f.path === 'docs/domain/',
      ),
      'two concrete bullets is still thin',
   );

   const three = tmpdir();
   await initLayer({ dir: three, yes: true });
   fs.writeFileSync(path.join(three, 'docs', 'domain', 'glossary.md'), '# Glossary\n\n- One.\n- Two.\n- Three.\n');
   assert.ok(
      !validateLayer(three, { content: true }).findings.some(
         (f) => f.rule === 'content-thin' && f.path === 'docs/domain/',
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
