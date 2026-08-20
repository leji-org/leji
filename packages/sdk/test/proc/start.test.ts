import { strict as assert } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// `leji start` end to end, through the real bin. Everything the command could reach
// outside the repository is a stub on a synthetic PATH: the CLI it probes, the agent
// hosts it detects, and the host commands it would run. Nothing real is launched or
// installed here, and the runs are non-interactive, so no prompt can fire either.

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(pkgRoot, 'dist', 'cli.js');

function tmpdir(prefix: string): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The real `git` binary, the one program these runs cannot stub: the hook check asks
 * git where hooks live. */
function gitBin(): string {
   try {
      return execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
   } catch {
      return '/usr/bin/git';
   }
}

/**
 * A directory of executable stubs, plus a link to the real git. It is the WHOLE PATH
 * of every run below, so what host detection finds is exactly what a case declares
 * and never whatever the machine running the suite happens to have installed.
 */
function stubs(spec: Record<string, string>): string {
   const dir = tmpdir('leji-start-stubs-');
   for (const [name, body] of Object.entries(spec)) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
   }
   fs.symlinkSync(gitBin(), path.join(dir, 'git'));
   return dir;
}

const VERSION_STUB = 'echo 1.4.0';

interface CliResult {
   code: number;
   stdout: string;
   stderr: string;
}

async function runStart(args: string[], cwd: string, env: Record<string, string>): Promise<CliResult> {
   return new Promise((resolve) => {
      execFile(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
         resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
   });
}

/** A committed layer in its own repository, with the environment `start` sees. */
function layer(opts: { declared?: boolean; hosts?: Record<string, string> } = {}): {
   dir: string;
   env: Record<string, string>;
} {
   const dir = tmpdir('leji-start-');
   const home = tmpdir('leji-start-home-');
   const bare = { PATH: stubs({}), HOME: home };
   execFileSync(process.execPath, [cli, 'init', '--yes', '--name', 'demo-context'], {
      cwd: dir,
      env: { ...process.env, ...bare },
      stdio: 'ignore',
   });
   if (opts.declared) {
      fs.writeFileSync(
         path.join(dir, 'package.json'),
         '{\n  "name": "demo",\n  "devDependencies": { "@leji-org/leji": "^1" }\n}\n',
      );
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
      // What the manager's own install would have produced. The probe executes this
      // file directly; no `npx`/`pnpm exec` stub exists, and none is needed.
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'leji'), `#!/bin/sh\n${VERSION_STUB}\n`, { mode: 0o755 });
   }
   execFileSync('git', ['init', '-q'], { cwd: dir, env: { ...process.env, ...bare } });
   const stubDir = stubs({ leji: VERSION_STUB, ...(opts.hosts ?? {}) });
   return { dir, env: { PATH: stubDir, HOME: home } };
}

test('start prints the Setup block before the entry instructions, and launches nothing', async () => {
   const { dir, env } = layer({ declared: true });
   const r = await runStart(['start'], dir, env);
   assert.equal(r.code, 0, r.stderr);
   const setup = r.stdout.indexOf('Setup for this clone');
   const entry = r.stdout.indexOf('No coding agent was launched.');
   assert.ok(setup >= 0, r.stdout);
   assert.ok(entry > setup, 'the block prints above the entry instructions');
   assert.ok(!r.stdout.includes('Starting '), 'a non-interactive run never launches a host');
   assert.match(r.stdout, /^ {2}ok {4}Leji CLI {4}1\.4\.0 \(node_modules\/\.bin\/leji\)$/m);
   assert.match(r.stdout, /^ {2}n\/a {3}MCP server {2}no coding agent detected$/m);
   assert.match(r.stdout, /^ {2}you {3}Git hook {4}none yet \(per clone\)$/m);
   assert.match(r.stdout, /^ {8}\$ leji ci --hooks$/m, 'the fix is printed as an exact command');
   assert.match(r.stdout, /^ {2}1 fix for you\. The agent starts either way\.$/m);
   assert.equal(r.stdout.includes('\x1b'), false, 'a piped run carries no escape');
});

test('start on a repository that declares nothing reports a shared gap, still exit 0', async () => {
   const { dir, env } = layer();
   fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "demo" }\n');
   const r = await runStart(['start'], dir, env);
   assert.equal(r.code, 0, r.stderr);
   assert.match(r.stdout, /^ {2}team {2}Leji CLI {4}not declared/m);
   assert.match(r.stdout, /^ {8}\$ npm i -D @leji-org\/leji$/m);
});

test('start --json emits one report-only document and never launches', async () => {
   const { dir, env } = layer({ declared: true, hosts: { claude: 'exit 1' } });
   const r = await runStart(['start', '--json'], dir, env);
   assert.equal(r.code, 0, r.stderr);
   const doc = JSON.parse(r.stdout) as {
      command: string;
      ok: boolean;
      ready: boolean;
      checks: { id: string; status: string; detail: string; fix: string[] | null }[];
      ecosystem: { selected: { manager: string } | null };
   };
   assert.deepEqual(Object.keys(doc), ['command', 'ok', 'ready', 'checks', 'ecosystem']);
   assert.equal(doc.command, 'start');
   assert.equal(doc.ok, true);
   assert.equal(doc.ready, false, 'the hook is missing');
   assert.deepEqual(
      doc.checks.map((c) => c.id),
      ['cli', 'mcp', 'mcp-shared', 'hook'],
   );
   for (const c of doc.checks) assert.deepEqual(Object.keys(c), ['id', 'status', 'detail', 'fix']);
   assert.equal(doc.checks[0].status, 'ok');
   // The one detected host is Claude Code (its stub is on PATH); `claude mcp get`
   // exits 1, so the personal fix is the user-scope registration.
   assert.equal(doc.checks[1].status, 'missing');
   assert.deepEqual(doc.checks[1].fix, ['claude mcp add leji --scope user -- npx -y @leji-org/mcp']);
   assert.equal(doc.checks[2].status, 'shared-gap');
   assert.equal(doc.checks[3].status, 'missing');
   assert.equal(doc.ecosystem.selected?.manager, 'npm');
   assert.ok(!r.stdout.includes('Setup for this clone'), 'no human block in a document mode');
});

test('start --json reports ready once the personal gaps are closed', async () => {
   const { dir, env } = layer({ declared: true, hosts: { claude: 'exit 0' } });
   fs.writeFileSync(path.join(dir, '.mcp.json'), '{ "mcpServers": {} }\n');
   execFileSync(process.execPath, [cli, 'ci', '--hooks'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: 'ignore',
   });
   const r = await runStart(['start', '--json'], dir, env);
   assert.equal(r.code, 0, r.stderr);
   const doc = JSON.parse(r.stdout) as { ready: boolean; checks: { status: string }[] };
   assert.equal(doc.ready, true);
   assert.deepEqual(
      doc.checks.map((c) => c.status),
      ['ok', 'ok', 'ok', 'ok'],
   );
});

test('start --json with several hosts and no --agent leaves the MCP row unresolved', async () => {
   const { dir, env } = layer({ declared: true, hosts: { claude: 'exit 1', codex: 'exit 1' } });
   const r = await runStart(['start', '--json'], dir, env);
   assert.equal(r.code, 0, r.stderr);
   const doc = JSON.parse(r.stdout) as { checks: { id: string; status: string; fix: string[] | null }[] };
   const mcp = doc.checks.find((c) => c.id === 'mcp');
   assert.equal(mcp?.status, 'unresolved');
   assert.deepEqual(mcp?.fix, ['leji start --agent <name>']);
   assert.equal(doc.checks.find((c) => c.id === 'mcp-shared')?.status, 'n/a');
});

test('start --agent claude-code --json answers for the named host', async () => {
   const { dir, env } = layer({ declared: true, hosts: { claude: 'exit 1', codex: 'exit 1' } });
   const r = await runStart(['start', '--agent', 'claude-code', '--json'], dir, env);
   assert.equal(r.code, 0, r.stderr);
   const doc = JSON.parse(r.stdout) as { checks: { id: string; status: string }[] };
   assert.equal(doc.checks.find((c) => c.id === 'mcp')?.status, 'missing');
   assert.equal(doc.checks.find((c) => c.id === 'mcp-shared')?.status, 'shared-gap');
});

test('start --agent bogus --json is a usage error, before any document is written', async () => {
   const { dir, env } = layer({ declared: true });
   const r = await runStart(['start', '--agent', 'bogus', '--json'], dir, env);
   assert.equal(r.code, 2);
   assert.match(r.stderr, /--agent must be a launchable host/);
   assert.equal(r.stdout.trim(), '', 'no document is emitted for a rejected argument');
});

test('start --json on a missing boot profile is the boot-missing document, exit 1', async () => {
   const { dir, env } = layer({ declared: true });
   fs.rmSync(path.join(dir, 'docs', 'boot-profile.md'));
   const r = await runStart(['start', '--json'], dir, env);
   assert.equal(r.code, 1);
   const doc = JSON.parse(r.stdout) as Record<string, unknown>;
   assert.deepEqual(Object.keys(doc), ['command', 'ok', 'ready', 'error', 'checks', 'ecosystem']);
   assert.equal(doc.ok, false);
   assert.equal(doc.ready, false);
   assert.equal(doc.error, 'boot-missing');
   assert.deepEqual(doc.checks, [], 'nothing was checked, so nothing is claimed');
});

test('start on a repository with no leji.json is the findings envelope, exit 1', async () => {
   const dir = tmpdir('leji-start-bare-');
   const r = await runStart(['start', '--json'], dir, { PATH: stubs({}), HOME: tmpdir('leji-start-home-') });
   assert.equal(r.code, 1);
   const doc = JSON.parse(r.stdout) as { command: string; ok: boolean; findings: unknown[] };
   assert.equal(doc.command, 'start');
   assert.equal(doc.ok, false);
   assert.ok(Array.isArray(doc.findings));
});
