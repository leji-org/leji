import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultHandoffIo } from '../dist/commands/init.js';
import { checkDocument, colorDecision } from '../dist/commands/preflight.js';
import {
   type Check,
   type PreflightResult,
   detectEcosystem,
   ensureLocalHook,
   hookStatus,
   offerPreflightFixes,
   renderPreflight,
   runPreflight,
} from '../dist/index.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const exampleDir = path.resolve(testDir, '..', '..', '..', 'examples', 'monorepo');

function tmpdir(prefix = 'leji-preflight-'): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The bin shim a Node package manager's install puts in the tree. The probe executes
 * this file directly, so every Node case that expects a version has to have it. */
function installNodeBin(dir: string): string {
   const binDir = path.join(dir, 'node_modules', '.bin');
   fs.mkdirSync(binDir, { recursive: true });
   const abs = path.join(binDir, 'leji');
   fs.writeFileSync(abs, '#!/bin/sh\necho 1.4.0\n', { mode: 0o755 });
   return abs;
}

/** A committed example layer in its own git repository: the shape every hook class
 * is derived from. */
function gitLayer(prefix: string): string {
   const dir = tmpdir(prefix);
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'seed'], { cwd: dir });
   return dir;
}

const MANIFEST = { leji: '1.0', bootProfilePath: 'docs/boot-profile.md' } as never;

const CLAUDE_HOST = { id: 'claude-code', bin: 'claude', name: 'Claude Code' };
const CODEX_HOST = { id: 'codex', bin: 'codex', name: 'Codex' };
const host = (id: string, name: string): never =>
   ({
      id,
      name,
      strength: 'confirmed',
      onPath: true,
      inRepo: false,
      userConfig: false,
      adapter: null,
   }) as never;
const DETECTED_CLAUDE = host('claude-code', 'Claude Code');
const DETECTED_CODEX = host('codex', 'Codex');
const DETECTED_CURSOR = host('cursor', 'Cursor');
const DETECTED_COPILOT = host('copilot', 'GitHub Copilot');

type RunResult = { error?: Error; status?: number | null; signal?: NodeJS.Signals | null; stdout?: string };
type RunOpts = {
   quiet: boolean;
   capture?: boolean;
   timeoutMs?: number;
   maxBytes?: number;
   env?: Record<string, string>;
};

/** A scripted IO: `results` answers each `run` in order (the last one repeats), and
 * every call is recorded so a probe's argv, cwd, and bounds can be asserted. */
function fakeIo(results: RunResult[] = [{ status: 0, stdout: '1.4.0\n' }], answers: string[] = ['y']) {
   const runs: { bin: string; args: string[]; cwd?: string; opts: RunOpts }[] = [];
   const questions: string[] = [];
   let i = 0;
   const io = {
      async readLine(q: string): Promise<string> {
         questions.push(q);
         return answers.length > 1 ? (answers.shift() as string) : answers[0];
      },
      launch(): RunResult {
         throw new Error('the preflight never launches');
      },
      run(bin: string, args: string[], cwd: string | undefined, opts: RunOpts): RunResult {
         runs.push({ bin, args, cwd, opts });
         const r = results[Math.min(i, results.length - 1)];
         i++;
         return r;
      },
   };
   return { io: io as never, runs, questions };
}

const byId = (checks: Check[], id: string): Check => {
   const c = checks.find((x) => x.id === id);
   assert.ok(c, `no ${id} check`);
   return c;
};

function preflight(dir: string, io: never, opts: { host?: unknown; detected?: unknown[] } = {}): PreflightResult {
   return runPreflight({
      root: dir,
      manifest: MANIFEST,
      host: (opts.host ?? null) as never,
      detected: (opts.detected ?? []) as never,
      report: detectEcosystem(dir),
      io,
   });
}

// --- hookStatus: one class per ownership -------------------------------------

test('hookStatus: an ordinary clone with no hook is personal and absent', () => {
   const dir = gitLayer('leji-preflight-hook-');
   const s = hookStatus(dir, ['leji']);
   assert.equal(s.ownership, 'personal');
   assert.equal(s.state, 'absent');
   assert.equal(s.path, '.git/hooks/pre-commit');
   assert.equal(s.managed, 'file');
});

test('hookStatus: leji-managed hook reads current; a foreign one reads foreign', () => {
   const dir = gitLayer('leji-preflight-hook-current-');
   ensureLocalHook(dir, ['leji']);
   assert.equal(hookStatus(dir, ['leji']).state, 'current');
   fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho mine\n');
   const foreign = hookStatus(dir, ['leji']);
   assert.equal(foreign.state, 'foreign');
   assert.equal(foreign.ownership, 'personal', 'still per clone, whoever wrote it');
});

test('hookStatus: husky is SHARED (committed), not personal', () => {
   const dir = gitLayer('leji-preflight-hook-husky-');
   execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
   const s = hookStatus(dir, ['leji']);
   assert.equal(s.ownership, 'shared');
   assert.equal(s.state, 'absent');
   assert.equal(s.path, '.husky/pre-commit');
   assert.equal(s.managed, 'block');
});

test('hookStatus: a core.hooksPath inside the worktree is shared', () => {
   const dir = gitLayer('leji-preflight-hook-githooks-');
   execFileSync('git', ['config', 'core.hooksPath', 'githooks'], { cwd: dir });
   const s = hookStatus(dir, ['leji']);
   assert.equal(s.ownership, 'shared');
   assert.equal(s.path, 'githooks/pre-commit');
});

test('hookStatus: a hooks path under $HOME is external and reported only', () => {
   const dir = gitLayer('leji-preflight-hook-global-');
   const outside = tmpdir('leji-preflight-globalhooks-');
   execFileSync('git', ['config', 'core.hooksPath', outside], { cwd: dir });
   const s = hookStatus(dir, ['leji']);
   assert.equal(s.ownership, 'external');
   const c = byId(preflight(dir, fakeIo().io).checks, 'hook');
   assert.equal(c.status, 'missing');
   assert.ok(c.fix && c.fix.join('\n').includes('leji pre-commit (managed)'), 'the snippet is the fix');
   assert.equal(fs.existsSync(path.join(outside, 'pre-commit')), false, 'nothing was written there');
});

test('hookStatus: a linked worktree resolves the shared hooks dir as personal', () => {
   const dir = tmpdir('leji-preflight-worktree-');
   const main = path.join(dir, 'main');
   fs.mkdirSync(main, { recursive: true });
   execFileSync('git', ['init', '-q'], { cwd: main });
   fs.cpSync(exampleDir, main, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: main });
   execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'seed'], { cwd: main });
   execFileSync('git', ['worktree', 'add', '-q', path.join(dir, 'wt')], { cwd: main });
   const wt = path.join(dir, 'wt');
   const s = hookStatus(wt, ['leji']);
   // The hooks git runs live in the COMMON dir, outside this worktree. It is still
   // per-clone state, but the writer refuses everything outside the repository root,
   // so it is reported rather than offered.
   assert.equal(s.ownership, 'outside-root');
   assert.equal(s.state, 'absent');
   const row = byId(preflight(wt, fakeIo().io).checks, 'hook');
   assert.equal(row.status, 'missing');
   assert.match(row.detail, /hooks dir is outside this worktree/);
   assert.ok(row.fix?.join('\n').includes('leji pre-commit (managed)'), 'the snippet is the fix');
});

test('a linked worktree is never offered the hook, and nothing is written for it', async () => {
   const dir = tmpdir('leji-preflight-worktree-offer-');
   const main = path.join(dir, 'main');
   fs.mkdirSync(main, { recursive: true });
   execFileSync('git', ['init', '-q'], { cwd: main });
   fs.cpSync(exampleDir, main, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: main });
   execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'seed'], { cwd: main });
   execFileSync('git', ['worktree', 'add', '-q', path.join(dir, 'wt')], { cwd: main });
   const wt = path.join(dir, 'wt');
   const f = fakeIo([{ status: 0, stdout: '1.4.0\n' }], ['y']);
   const result = preflight(wt, f.io);
   assert.equal(result.hook.ownership, 'outside-root');
   await offerPreflightFixes({ root: wt, host: null, result, runner: ['leji'], interactive: true, io: f.io });
   assert.equal(f.questions.length, 0, 'a target outside the worktree is never offered');
   assert.equal(fs.existsSync(path.join(main, '.git', 'hooks', 'pre-commit')), false);
});

test('hookStatus: a directory that is not a git repository answers no-git', () => {
   const s = hookStatus(tmpdir('leji-preflight-nogit-'), ['leji']);
   assert.equal(s.ownership, 'no-git');
   assert.equal(s.path, '');
});

// --- the version probe --------------------------------------------------------

test('cli: an undeclared repository is a SHARED gap carrying the declare command', () => {
   const dir = gitLayer('leji-preflight-cli-undeclared-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","packageManager":"pnpm@9.0.0"}\n');
   const { checks, ready } = preflight(dir, fakeIo([{ error: new Error('spawn leji ENOENT') }]).io);
   const cli = byId(checks, 'cli');
   assert.equal(cli.status, 'shared-gap');
   assert.deepEqual(cli.fix, ['pnpm add -D @leji-org/leji']);
   assert.equal(ready, false, 'a shared cli gap still leaves the clone unready');
});

test('cli: an undeclared repository names an ambient leji as your own install', () => {
   const dir = gitLayer('leji-preflight-cli-ambient-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}\n');
   const { checks } = preflight(dir, fakeIo([{ status: 0, stdout: '1.4.0\n' }]).io);
   const cli = byId(checks, 'cli');
   assert.equal(cli.status, 'shared-gap');
   assert.match(cli.detail, /not declared here \(PATH has your own 1\.4\.0\)/);
});

test('cli: a declared Node CLI is probed by executing the installed shim, never through a manager', () => {
   const dir = gitLayer('leji-preflight-cli-ok-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n');
   fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
   const binAbs = installNodeBin(dir);
   const f = fakeIo([{ status: 0, stdout: '1.4.0\n' }]);
   const { checks, ready } = preflight(dir, f.io);
   const cli = byId(checks, 'cli');
   assert.equal(cli.status, 'ok');
   assert.equal(cli.detail, '1.4.0 (node_modules/.bin/leji)');
   assert.equal(cli.fix, null);
   // The shim itself, by absolute path: no `pnpm exec`, no `npx`, no shell.
   assert.equal(f.runs[0].bin, binAbs);
   assert.deepEqual(f.runs[0].args, ['--version']);
   assert.equal(f.runs[0].cwd, path.resolve(dir), 'the probe runs in the repository root');
   assert.equal(f.runs[0].opts.capture, true);
   assert.equal(f.runs[0].opts.quiet, true);
   assert.equal(f.runs[0].opts.timeoutMs, 10000);
   assert.equal(f.runs[0].opts.maxBytes, 4096);
   // The environment REPLACES this process's: no inherited PATH, no HOME of the user's.
   const env = f.runs[0].opts.env as Record<string, string>;
   assert.ok(env, 'the probe passes an environment');
   assert.equal(env.PATH, path.dirname(process.execPath));
   assert.notEqual(env.HOME, process.env.HOME);
   for (const leaked of ['NODE_OPTIONS', 'npm_config_registry', 'LD_PRELOAD']) {
      assert.equal(env[leaked], undefined, `${leaked} must not reach the probe`);
   }
   // The clone still has no hook, so one ok row is not readiness.
   assert.equal(ready, false);
   assert.equal(byId(checks, 'hook').status, 'missing');
});

test('cli: a Node repository with no installed shim is missing, and no manager is ever run', () => {
   const dir = gitLayer('leji-preflight-cli-nobin-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n');
   fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
   const f = fakeIo([{ status: 0, stdout: '1.4.0\n' }]);
   const cli = byId(preflight(dir, f.io).checks, 'cli');
   assert.equal(cli.status, 'missing');
   assert.equal(cli.detail, 'not installed yet (node_modules/.bin/leji)');
   assert.deepEqual(cli.fix, ['npm install', 'npx --no-install @leji-org/leji --version']);
   // Nothing was executed at all: a missing shim is answered from the filesystem.
   assert.equal(f.runs.length, 0, 'no probe runs when the shim is absent');
});

test('cli: a shim resolving outside the repository is refused rather than executed', () => {
   const dir = gitLayer('leji-preflight-cli-escape-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n');
   fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
   const outside = tmpdir('leji-preflight-outside-');
   const target = path.join(outside, 'leji');
   fs.writeFileSync(target, '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });
   const binDir = path.join(dir, 'node_modules', '.bin');
   fs.mkdirSync(binDir, { recursive: true });
   fs.symlinkSync(target, path.join(binDir, 'leji'));
   const f = fakeIo([{ status: 0, stdout: '9.9.9\n' }]);
   const cli = byId(preflight(dir, f.io).checks, 'cli');
   assert.equal(cli.status, 'missing', 'a shim pointing out of the repository is not the declared CLI');
   assert.equal(f.runs.length, 0);
});

test('cli: uv probes with --no-sync and go probes with the offline, sanitized environment', () => {
   const uvDir = gitLayer('leji-preflight-cli-uv-');
   fs.writeFileSync(path.join(uvDir, 'pyproject.toml'), '[project]\nname = "app"\ndependencies = ["leji"]\n');
   fs.writeFileSync(path.join(uvDir, 'uv.lock'), 'version = 1\n');
   const uv = fakeIo([{ status: 0, stdout: '1.4.0\n' }]);
   preflight(uvDir, uv.io);
   assert.deepEqual(uv.runs[0].args, ['run', '--no-sync', 'leji', '--version'], 'uv never syncs to answer a probe');

   const goDir = gitLayer('leji-preflight-cli-go-');
   fs.writeFileSync(
      path.join(goDir, 'go.mod'),
      'module example.com/app\n\ngo 1.24\n\ntool github.com/leji-org/leji/packages/sdk-go/cmd/leji\n',
   );
   const go = fakeIo([{ status: 0, stdout: '1.4.0\n' }]);
   preflight(goDir, go.io);
   assert.deepEqual(go.runs[0].args, ['tool', 'leji', '--version']);
   const goEnv = go.runs[0].opts.env as Record<string, string>;
   assert.equal(goEnv.GOFLAGS, '-mod=readonly');
   assert.equal(goEnv.GOTOOLCHAIN, 'local');
   assert.equal(goEnv.GOPROXY, 'off');
   assert.equal(goEnv.GOWORK, 'off', 'a workspace file must not redirect the probe');
   // A manager has to be found on PATH, so PATH and HOME survive; nothing else does.
   assert.equal(goEnv.PATH, process.env.PATH);
   for (const leaked of ['NODE_OPTIONS', 'LD_PRELOAD', 'GOPRIVATE']) {
      assert.equal(goEnv[leaked], undefined, `${leaked} must not reach the probe`);
   }
});

test('cli: every probe failure fails CLOSED, with the manager install line', () => {
   const dir = gitLayer('leji-preflight-cli-closed-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n');
   fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
   installNodeBin(dir);
   const failures: RunResult[] = [
      { error: new Error('spawn npx ENOENT') }, // never started
      { error: new Error('ETIMEDOUT'), status: null, signal: 'SIGTERM' }, // timed out
      { status: 1, stdout: '' }, // ran, failed
      { status: 0, stdout: 'leji version one\n' }, // malformed
      { status: 0, stdout: '\n' }, // empty
   ];
   for (const outcome of failures) {
      const cli = byId(preflight(dir, fakeIo([outcome]).io).checks, 'cli');
      assert.equal(cli.status, 'missing', JSON.stringify(outcome));
      assert.deepEqual(cli.fix, ['npm install', 'npx --no-install @leji-org/leji --version']);
   }
});

test('cli: a resolved CLI below the spec line minimum is missing, not ok', () => {
   const dir = gitLayer('leji-preflight-cli-old-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n');
   installNodeBin(dir);
   const cli = byId(preflight(dir, fakeIo([{ status: 0, stdout: '0.9.3\n' }]).io).checks, 'cli');
   assert.equal(cli.status, 'missing');
   assert.match(cli.detail, /is below 1\.0\.0 for spec 1\.0/);
});

// --- MCP rows -----------------------------------------------------------------

test('mcp: registered for the selected host is ok; unregistered offers the USER scope', () => {
   const dir = gitLayer('leji-preflight-mcp-');
   const ok = preflight(dir, fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 0 }]).io, {
      host: CLAUDE_HOST,
      detected: [DETECTED_CLAUDE],
   });
   assert.equal(byId(ok.checks, 'mcp').status, 'ok');

   const missing = preflight(dir, fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 1 }]).io, {
      host: CLAUDE_HOST,
      detected: [DETECTED_CLAUDE],
   });
   const row = byId(missing.checks, 'mcp');
   assert.equal(row.status, 'missing');
   assert.deepEqual(row.fix, ['claude mcp add leji --scope user -- npx -y @leji-org/mcp']);
});

test('mcp: Codex registers at user level, its only scope', () => {
   const dir = gitLayer('leji-preflight-mcp-codex-');
   const { checks } = preflight(dir, fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 1 }]).io, {
      host: CODEX_HOST,
      detected: [DETECTED_CODEX],
   });
   assert.deepEqual(byId(checks, 'mcp').fix, ['codex mcp add leji -- npx -y @leji-org/mcp']);
   assert.equal(byId(checks, 'mcp-shared').status, 'n/a', 'Codex has no shared form');
});

test('mcp: several hosts and no pick is unresolved, naming them and the flag', () => {
   const dir = gitLayer('leji-preflight-mcp-unresolved-');
   const { checks } = preflight(dir, fakeIo().io, { detected: [DETECTED_CLAUDE, DETECTED_CODEX] });
   const row = byId(checks, 'mcp');
   assert.equal(row.status, 'unresolved');
   assert.match(row.detail, /Claude Code, Codex/);
   assert.deepEqual(row.fix, ['leji start --agent <name>']);
});

test('mcp: a host leji cannot register for gets the standard config and its path', () => {
   const dir = gitLayer('leji-preflight-mcp-other-');
   const { checks } = preflight(dir, fakeIo().io, { detected: [DETECTED_CURSOR] });
   const row = byId(checks, 'mcp');
   assert.equal(row.status, 'missing');
   assert.equal(row.fix?.[0], '.cursor/mcp.json (project scope)');
   assert.ok(row.fix?.join('\n').includes('"@leji-org/mcp"'));
});

test("mcp: the printed block takes the shape the host's own config file uses", () => {
   const dir = gitLayer('leji-preflight-mcp-shape-');
   // VS Code, which is how GitHub Copilot reads MCP servers, spells the map
   // `servers`; pasting the common `mcpServers` block into .vscode/mcp.json leaves
   // the editor with a file it ignores.
   const copilot = byId(preflight(dir, fakeIo().io, { detected: [DETECTED_COPILOT] }).checks, 'mcp');
   assert.equal(copilot.status, 'missing');
   assert.deepEqual(copilot.fix, [
      '.vscode/mcp.json (project scope)',
      '{',
      '  "servers": {',
      '    "leji": { "command": "npx", "args": ["-y", "@leji-org/mcp"] }',
      '  }',
      '}',
   ]);
   // Every other host Leji cannot register for takes the common shape.
   const cursor = byId(preflight(dir, fakeIo().io, { detected: [DETECTED_CURSOR] }).checks, 'mcp');
   assert.ok(cursor.fix?.includes('  "mcpServers": {'), cursor.fix?.join('\n'));
});

test('mcp: no detected host at all is skipped and never counts against ready', () => {
   const dir = gitLayer('leji-preflight-mcp-none-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n');
   installNodeBin(dir);
   ensureLocalHook(dir, ['leji']);
   const { checks, ready } = preflight(dir, fakeIo([{ status: 0, stdout: '1.4.0\n' }]).io);
   assert.equal(byId(checks, 'mcp').status, 'skipped');
   assert.equal(ready, true);
});

test('mcp-shared: a committed .mcp.json is ok, its absence a shared gap for a maintainer', () => {
   const dir = gitLayer('leji-preflight-mcp-shared-');
   const absent = preflight(dir, fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 0 }]).io, {
      host: CLAUDE_HOST,
      detected: [DETECTED_CLAUDE],
   });
   const gap = byId(absent.checks, 'mcp-shared');
   assert.equal(gap.status, 'shared-gap');
   assert.deepEqual(gap.fix, ['claude mcp add leji --scope project -- npx -y @leji-org/mcp']);
   assert.equal(absent.ready, false, 'ready is decided by cli, mcp and hook');

   fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{}}\n');
   const present = preflight(dir, fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 0 }]).io, {
      host: CLAUDE_HOST,
      detected: [DETECTED_CLAUDE],
   });
   assert.equal(byId(present.checks, 'mcp-shared').status, 'ok');
});

test('mcp-shared never decides ready on its own', () => {
   const dir = gitLayer('leji-preflight-ready-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n');
   installNodeBin(dir);
   ensureLocalHook(dir, ['npx', '--no-install', '@leji-org/leji']);
   const { checks, ready } = preflight(dir, fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 0 }]).io, {
      host: CLAUDE_HOST,
      detected: [DETECTED_CLAUDE],
   });
   assert.equal(byId(checks, 'mcp-shared').status, 'shared-gap');
   assert.equal(ready, true, 'cli, mcp and hook are all ok');
});

// --- the report ---------------------------------------------------------------

test('the checks are always the same four ids, in the same order', () => {
   const dir = gitLayer('leji-preflight-order-');
   const { checks } = preflight(dir, fakeIo().io, { host: CLAUDE_HOST, detected: [DETECTED_CLAUDE] });
   assert.deepEqual(
      checks.map((c) => c.id),
      ['cli', 'mcp', 'mcp-shared', 'hook'],
   );
   // Every check carries the render-only fix kind; the document projection drops it.
   for (const c of checks) assert.deepEqual(Object.keys(c), ['id', 'status', 'detail', 'fix', 'fixKind']);
});

test('the document projection publishes exactly the four keys, whatever the check carries', () => {
   const dir = gitLayer('leji-preflight-json-');
   const { checks } = preflight(dir, fakeIo().io, { host: CLAUDE_HOST, detected: [DETECTED_CLAUDE] });
   for (const c of checks) {
      const doc = checkDocument(c);
      assert.deepEqual(Object.keys(doc), ['id', 'status', 'detail', 'fix']);
      assert.deepEqual(doc, { id: c.id, status: c.status, detail: c.detail, fix: c.fix });
      assert.equal(JSON.stringify(doc).includes('fixKind'), false);
   }
});

// --- the Setup block ------------------------------------------------------------
// The three scenarios the layout was cut against, as exact bytes: every other SDK
// prints these same strings, so the render is pinned here rather than described.

/** A check exactly as the internal constructors build it. */
function checkRow(
   id: Check['id'],
   status: Check['status'],
   detail: string,
   fix: string[] | null = null,
   fixKind: 'command' | 'snippet' = 'command',
): Check {
   return { id, status, detail, fix, fixKind };
}

const MCP_USER = 'claude mcp add leji --scope user -- npx -y @leji-org/mcp';
const MCP_PROJECT = 'claude mcp add leji --scope project -- npx -y @leji-org/mcp';

/** Nothing is this clone's to fix: the CLI, the shared server and the hook are all the
 * repository's own state. */
const ALL_TEAM: Check[] = [
   checkRow('cli', 'shared-gap', 'not declared in this repository', ['npm i -D @leji-org/leji']),
   checkRow('mcp', 'ok', 'registered for Claude Code'),
   checkRow('mcp-shared', 'shared-gap', 'no .mcp.json committed', [MCP_PROJECT]),
   checkRow('hook', 'shared-gap', 'no leji block in .husky/pre-commit', ['leji ci --hooks']),
];

/** The CLI and the hook are the maintainer's; both MCP registrations are already there. */
const TEAM_CLI_AND_HOOK: Check[] = [
   checkRow('cli', 'shared-gap', 'not declared here (PATH has your own 1.4.0)', ['npm i -D @leji-org/leji']),
   checkRow('mcp', 'ok', 'registered for Claude Code'),
   checkRow('mcp-shared', 'ok', '.mcp.json committed'),
   checkRow('hook', 'shared-gap', 'no leji block in .husky/pre-commit', ['leji ci --hooks']),
];

/** One fix each: this user's own registration, and the one a maintainer commits. */
const PERSONAL_AND_TEAM_MCP: Check[] = [
   checkRow('cli', 'ok', '1.4.0 (node_modules/.bin/leji)'),
   checkRow('mcp', 'missing', 'not registered for Claude Code', [MCP_USER]),
   checkRow('mcp-shared', 'shared-gap', 'no .mcp.json committed', [MCP_PROJECT]),
   checkRow('hook', 'ok', 'runs leji checks before each commit: .git/hooks/pre-commit'),
];

const SCENARIOS: [string, Check[], string][] = [
   [
      'every gap belongs to a maintainer',
      ALL_TEAM,
      [
         'Setup for this clone',
         '',
         '  team  Leji CLI    not declared in this repository',
         '        $ npm i -D @leji-org/leji',
         '  ok    MCP server  registered for Claude Code',
         '  team  Team MCP    no .mcp.json committed',
         `        $ ${MCP_PROJECT}`,
         '  team  Git hook    no leji block in .husky/pre-commit',
         '        $ leji ci --hooks',
         '',
         '  3 fixes for a maintainer. The agent starts either way.',
      ].join('\n'),
   ],
   [
      "the CLI and the hook are a maintainer's, both MCP rows ok",
      TEAM_CLI_AND_HOOK,
      [
         'Setup for this clone',
         '',
         '  team  Leji CLI    not declared here (PATH has your own 1.4.0)',
         '        $ npm i -D @leji-org/leji',
         '  ok    MCP server  registered for Claude Code',
         '  ok    Team MCP    .mcp.json committed',
         '  team  Git hook    no leji block in .husky/pre-commit',
         '        $ leji ci --hooks',
         '',
         '  2 fixes for a maintainer. The agent starts either way.',
      ].join('\n'),
   ],
   [
      'one fix for this user and one for a maintainer',
      PERSONAL_AND_TEAM_MCP,
      [
         'Setup for this clone',
         '',
         '  ok    Leji CLI    1.4.0 (node_modules/.bin/leji)',
         '  you   MCP server  not registered for Claude Code',
         `        $ ${MCP_USER}`,
         '  team  Team MCP    no .mcp.json committed',
         `        $ ${MCP_PROJECT}`,
         '  ok    Git hook    runs leji checks before each commit: .git/hooks/pre-commit',
         '',
         '  1 fix for you, 1 for a maintainer. The agent starts either way.',
      ].join('\n'),
   ],
];

for (const [name, checks, expected] of SCENARIOS) {
   test(`renderPreflight: ${name}`, () => {
      const block = renderPreflight(checks);
      assert.equal(block, expected);
      assert.doesNotMatch(block, /[–—]/, 'no en or em dash reaches the terminal');
   });
}

test('no row of any scenario wraps at 80 columns', () => {
   for (const [name, checks] of SCENARIOS) {
      for (const l of renderPreflight(checks).split('\n')) {
         // Commands and snippets are exact and exempt: they are what a person pastes.
         if (l.startsWith('        ')) continue;
         assert.ok(l.length <= 80, `${name}: ${l.length} columns: ${l}`);
      }
   }
});

test('renderPreflight: a snippet fix is pasted as it stands, a command carries the prompt', () => {
   const snippet = renderPreflight([
      checkRow('hook', 'missing', 'add it yourself; hooks run from /etc/hooks', ['#!/bin/sh', 'leji ci'], 'snippet'),
   ]);
   assert.ok(snippet.includes('\n        #!/bin/sh\n        leji ci\n'), snippet);
   // A four-field check, the shape an older caller passes, still renders as a command.
   const legacy = renderPreflight([
      { id: 'hook', status: 'missing', detail: 'none yet (per clone)', fix: ['leji ci --hooks'] },
   ]);
   assert.ok(legacy.includes('\n        $ leji ci --hooks\n'), legacy);
});

test('renderPreflight: nothing owed is one closing line', () => {
   const block = renderPreflight([
      checkRow('cli', 'ok', '1.4.0 (node_modules/.bin/leji)'),
      checkRow('mcp', 'skipped', 'no coding agent detected'),
   ]);
   assert.equal(block.split('\n').pop(), '  Setup complete.');
});

// --- the color convention -------------------------------------------------------

test('color off is the default, and leaves not one escape byte', () => {
   for (const [, checks] of SCENARIOS) {
      assert.equal(renderPreflight(checks).includes('\x1b'), false);
      assert.equal(renderPreflight(checks, {}).includes('\x1b'), false);
      assert.equal(renderPreflight(checks, { color: false }).includes('\x1b'), false);
   }
});

test('color on wraps the status word only, and the columns do not move', () => {
   const block = renderPreflight(
      [
         checkRow('cli', 'ok', '1.4.0 (node_modules/.bin/leji)'),
         checkRow('mcp', 'missing', 'not registered for Claude Code'),
         checkRow('mcp-shared', 'shared-gap', 'no .mcp.json committed'),
         checkRow('hook', 'n/a', 'not a git repository'),
      ],
      { color: true },
   );
   assert.equal(
      block,
      [
         'Setup for this clone',
         '',
         '  \x1b[32mok\x1b[0m    Leji CLI    1.4.0 (node_modules/.bin/leji)',
         '  \x1b[33myou\x1b[0m   MCP server  not registered for Claude Code',
         '  \x1b[36mteam\x1b[0m  Team MCP    no .mcp.json committed',
         '  \x1b[2mn/a\x1b[0m   Git hook    not a git repository',
         '',
         '  1 fix for you, 1 for a maintainer. The agent starts either way.',
      ].join('\n'),
   );
});

test('colorDecision: a terminal that has not asked for plain text, and nothing else', () => {
   const cases: [boolean, NodeJS.ProcessEnv, boolean][] = [
      [true, {}, true],
      [false, {}, false],
      [true, { NO_COLOR: '1' }, false],
      [true, { NO_COLOR: '' }, false],
      [false, { NO_COLOR: '' }, false],
      [true, { TERM: 'dumb' }, false],
      [true, { TERM: 'xterm-256color' }, true],
      [false, { TERM: 'xterm-256color' }, false],
   ];
   for (const [isTTY, env, expected] of cases) {
      assert.equal(colorDecision(isTTY, env), expected, `${isTTY} ${JSON.stringify(env)}`);
   }
});

// --- the consented repairs ----------------------------------------------------

test('offerPreflightFixes writes nothing non-interactively, however many gaps there are', async () => {
   const dir = gitLayer('leji-preflight-offer-none-');
   const f = fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 1 }]);
   const result = preflight(dir, f.io, { host: CLAUDE_HOST, detected: [DETECTED_CLAUDE] });
   const before = f.runs.length;
   await offerPreflightFixes({
      root: dir,
      host: CLAUDE_HOST as never,
      result,
      runner: ['leji'],
      interactive: false,
      io: f.io,
   });
   assert.equal(f.questions.length, 0, 'nothing is asked');
   assert.equal(f.runs.length, before, 'nothing is run');
   assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), false);
});

test('offerPreflightFixes registers the personal MCP scope and installs the clone hook, in that order', async () => {
   const dir = gitLayer('leji-preflight-offer-yes-');
   const f = fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 1 }, { status: 0 }], ['y']);
   const result = preflight(dir, f.io, { host: CLAUDE_HOST, detected: [DETECTED_CLAUDE] });
   await offerPreflightFixes({
      root: dir,
      host: CLAUDE_HOST as never,
      result,
      runner: ['leji'],
      interactive: true,
      io: f.io,
   });
   assert.equal(f.questions.length, 2, 'the MCP registration, then the hook');
   assert.match(f.questions[0], /Register the Leji MCP server for Claude Code/);
   assert.match(f.questions[1], /Install the pre-commit hook/);
   const registration = f.runs[f.runs.length - 1];
   assert.deepEqual(registration.args, ['mcp', 'add', 'leji', '--scope', 'user', '--', 'npx', '-y', '@leji-org/mcp']);
   assert.ok(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), 'the clone hook was written');
});

test('offerPreflightFixes never offers a SHARED gap: a husky repo is reported only', async () => {
   const dir = gitLayer('leji-preflight-offer-shared-');
   execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
   const f = fakeIo([{ status: 0, stdout: '1.4.0\n' }], ['y']);
   const result = preflight(dir, f.io, { detected: [] });
   assert.equal(byId(result.checks, 'hook').status, 'shared-gap');
   await offerPreflightFixes({ root: dir, host: null, result, runner: ['leji'], interactive: true, io: f.io });
   assert.equal(f.questions.length, 0, 'a committed hook is a maintainer decision');
   assert.equal(fs.existsSync(path.join(dir, '.husky', 'pre-commit')), false);
});

test('offerPreflightFixes declines cleanly and writes nothing', async () => {
   const dir = gitLayer('leji-preflight-offer-no-');
   const f = fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 1 }], ['n']);
   const result = preflight(dir, f.io, { host: CLAUDE_HOST, detected: [DETECTED_CLAUDE] });
   await offerPreflightFixes({
      root: dir,
      host: CLAUDE_HOST as never,
      result,
      runner: ['leji'],
      interactive: true,
      io: f.io,
   });
   assert.equal(f.questions.length, 2);
   assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), false);
});

test('a second run of an all-ok clone reports ok and offers nothing', async () => {
   const dir = gitLayer('leji-preflight-idempotent-');
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app","devDependencies":{"@leji-org/leji":"^1"}}\n');
   fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{}}\n');
   installNodeBin(dir);
   ensureLocalHook(dir, ['npx', '--no-install', '@leji-org/leji']);
   const f = fakeIo([{ status: 0, stdout: '1.4.0\n' }, { status: 0 }], ['y']);
   const result = preflight(dir, f.io, { host: CLAUDE_HOST, detected: [DETECTED_CLAUDE] });
   assert.deepEqual(
      result.checks.map((c) => c.status),
      ['ok', 'ok', 'ok', 'ok'],
   );
   assert.equal(result.ready, true);
   await offerPreflightFixes({
      root: dir,
      host: CLAUDE_HOST as never,
      result,
      runner: ['leji'],
      interactive: true,
      io: f.io,
   });
   assert.equal(f.questions.length, 0);
});

// --- the capture bounds, against a real child ---------------------------------
// The probe's two guarantees are about THIS process: nothing of its environment
// reaches the child, and nothing the child prints can grow past the cap or outlast
// the deadline. Both are exercised against real programs, not fakes.

const CAPTURE_CANARY = 'LEJI_PROBE_CANARY';

/** An executable `/bin/sh` stub, and its path. */
function captureStub(dir: string, name: string, body: string): string {
   const abs = path.join(dir, name);
   fs.writeFileSync(abs, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
   return abs;
}

const capture = (bin: string, cwd: string, maxBytes: number, env?: Record<string, string>, timeoutMs = 10_000) =>
   defaultHandoffIo().run(bin, [], cwd, { quiet: true, capture: true, timeoutMs, maxBytes, env });

/**
 * The deadline a run that must NOT reach it is given: generous enough that a loaded
 * runner cannot trip it, so finishing early can only mean the cap cut the child off.
 */
const OVERFLOW_TIMEOUT_MS = 30_000;
/**
 * The bound a terminated run has to finish inside: far below the deadline above, and
 * far above anything scheduling delay on a busy machine can add. What it proves is
 * which mechanism ended the run, not how fast the machine is.
 */
const PROMPT_MS = 15_000;
/**
 * How long a stub holds stdout open after it has said its piece: longer than every
 * deadline in this file, so a run that ended early ended because leji ended it and
 * not because the child happened to exit.
 */
const STUB_HOLD = 'sleep 60';

test('capture replaces the environment rather than extending it', () => {
   const dir = tmpdir('leji-capture-env-');
   const stub = captureStub(dir, 'echo-canary', `printf '%s' "\${${CAPTURE_CANARY}:-}"`);
   const before = process.env[CAPTURE_CANARY];
   process.env[CAPTURE_CANARY] = 'leaked';
   try {
      const res = capture(stub, dir, 4096, { PATH: '/usr/bin:/bin' });
      assert.equal(res.error, undefined);
      assert.equal(res.stdout, '', `the parent's ${CAPTURE_CANARY} reached the probe`);
      // The positive control: what the caller names IS present, so the empty result
      // above is replacement rather than a stub that cannot see any environment.
      const kept = capture(stub, dir, 4096, { PATH: '/usr/bin:/bin', [CAPTURE_CANARY]: 'named' });
      assert.equal(kept.stdout, 'named');
   } finally {
      if (before === undefined) delete process.env[CAPTURE_CANARY];
      else process.env[CAPTURE_CANARY] = before;
   }
});

test('capture kills a child that streams past the cap, well inside the timeout', () => {
   const dir = tmpdir('leji-capture-cap-');
   // 1 MiB in 1 KiB writes, far past the cap, then a slow tail: a run that did not cut
   // the child off at the cap would still be waiting when the deadline arrives.
   const stub = captureStub(
      dir,
      'flood',
      `i=0\nwhile [ $i -lt 1024 ]; do printf '%1024s' ''; i=$((i+1)); done\n${STUB_HOLD}`,
   );
   const started = Date.now();
   const res = capture(stub, dir, 4096, { PATH: '/usr/bin:/bin' }, OVERFLOW_TIMEOUT_MS);
   const elapsed = Date.now() - started;
   assert.ok(res.error, 'passing the cap is an error');
   // The child printed a megabyte; what is held is a bounded fraction of it. The
   // runtime stops after the READ that crossed the cap, where the other two SDKs
   // refuse the write that would cross it, so the bound here is the cap plus at most
   // one pipe read rather than the cap exactly. Either way the overflow bytes are
   // never parsed: a capped run is a failed probe.
   assert.ok((res.stdout ?? '').length < 64 * 1024, `held ${(res.stdout ?? '').length} bytes`);
   assert.ok(
      elapsed < PROMPT_MS,
      `the cap did not cut the child off: ${elapsed}ms, against a ${OVERFLOW_TIMEOUT_MS}ms deadline`,
   );
});

test('capture ends a sparse overflow promptly', () => {
   // One byte past the cap, then a child that holds stdout open and does nothing. The
   // overflow has to be decided from that single byte, not from a full buffer or from
   // EOF, or the run would sit until the deadline.
   const dir = tmpdir('leji-capture-sparse-');
   const cap = 64;
   const stub = captureStub(dir, 'trickle', `printf '%${cap + 1}s' ''\n${STUB_HOLD}`);
   const started = Date.now();
   const res = capture(stub, dir, cap, { PATH: '/usr/bin:/bin' }, OVERFLOW_TIMEOUT_MS);
   const elapsed = Date.now() - started;
   // What Node actually does here: ENOBUFS, the child terminated by signal, and the
   // bytes it had already read kept. It stops at the read that crossed the cap, so the
   // held output is bounded by the cap plus at most one read rather than by the cap
   // exactly; the run is a failed probe either way and those bytes are never parsed.
   assert.equal((res.error as NodeJS.ErrnoException | undefined)?.code, 'ENOBUFS');
   assert.notEqual(res.signal, null, 'the child is terminated, not left running');
   assert.ok((res.stdout ?? '').length <= cap + 4096, `held ${(res.stdout ?? '').length} bytes`);
   assert.ok(
      elapsed < PROMPT_MS,
      `a sparse overflow waited for the deadline: ${elapsed}ms, against a ${OVERFLOW_TIMEOUT_MS}ms deadline`,
   );
});

test('capture cap boundary: exactly the cap is not overflow, one past it is', () => {
   const dir = tmpdir('leji-capture-boundary-');
   const cap = 64;
   for (const [size, capped] of [
      [cap - 1, false],
      [cap, false],
      [cap + 1, true],
   ] as const) {
      const stub = captureStub(dir, `size-${size}`, `printf '%${size}s' ''`);
      const res = capture(stub, dir, cap, { PATH: '/usr/bin:/bin' });
      assert.equal(Boolean(res.error), capped, `${size} bytes: error=${res.error?.message}`);
      if (!capped) assert.equal((res.stdout ?? '').length, size, `${size} bytes held`);
   }
});

test('capture times out a child that never finishes', () => {
   const dir = tmpdir('leji-capture-timeout-');
   const stub = captureStub(dir, 'hang', STUB_HOLD);
   const started = Date.now();
   const res = capture(stub, dir, 4096, { PATH: '/usr/bin:/bin' }, 500);
   const elapsed = Date.now() - started;
   assert.ok(res.error || res.signal != null, 'the deadline ends the run');
   // Here the deadline IS the mechanism under test; the bound only has to separate it
   // from the child's own 60s, with room for a loaded runner.
   assert.ok(elapsed < PROMPT_MS, `the timeout did not end the run (${elapsed}ms)`);
});
