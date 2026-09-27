import { strict as assert } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../../dist/index.js';

// `leji doctor` end to end: the report `leji start` prints before it launches, as a
// command of its own. The central cases run both commands on the same inputs (the
// same context layer, the same stub PATH, a non-TTY so start launches nothing) and
// compare what they print. Everything outside the repository is a stub, as in
// start.test.ts.

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

/** A directory of executable stubs plus a link to the real git: the WHOLE PATH of
 * every run below, so detection finds exactly what a case declares. */
function stubs(spec: Record<string, string>): string {
   const dir = tmpdir('leji-doctor-stubs-');
   for (const [name, body] of Object.entries(spec)) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
   }
   fs.symlinkSync(gitBin(), path.join(dir, 'git'));
   return dir;
}

const VERSION_STUB = 'echo 1.4.0';
const LAUNCH_SENTENCE = ' The agent starts either way.';

interface CliResult {
   code: number;
   stdout: string;
   stderr: string;
}

async function runLeji(args: string[], cwd: string, env: Record<string, string>): Promise<CliResult> {
   return new Promise((resolve) => {
      execFile(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
         resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
   });
}

/**
 * A committed context layer in its own repository, built as start.test.ts builds it:
 * `leji init --yes` plus `git init`. `declared` adds an npm declaration of the CLI
 * and the bin shim its install would have produced, which is what makes the `cli`
 * row `ok`: the probe executes that shim directly and it answers 1.4.0. `shim`
 * replaces the shim's body (a case that records the probe).
 */
function layer(opts: { declared?: boolean; hosts?: Record<string, string>; shim?: string } = {}): {
   dir: string;
   env: Record<string, string>;
} {
   const dir = tmpdir('leji-doctor-');
   const home = tmpdir('leji-doctor-home-');
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
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'leji'), `#!/bin/sh\n${opts.shim ?? VERSION_STUB}\n`, { mode: 0o755 });
   }
   execFileSync('git', ['init', '-q'], { cwd: dir, env: { ...process.env, ...bare } });
   const stubDir = stubs({ leji: VERSION_STUB, ...(opts.hosts ?? {}) });
   return { dir, env: { PATH: stubDir, HOME: home } };
}

/** The ready state start.test.ts uses: the CLI declared and answering, the host
 * reporting the server registered, `.mcp.json` present, and the clone hook installed. */
function readyLayer(): { dir: string; env: Record<string, string> } {
   const l = layer({ declared: true, hosts: { claude: 'exit 0' } });
   fs.writeFileSync(path.join(l.dir, '.mcp.json'), '{ "mcpServers": {} }\n');
   execFileSync(process.execPath, [cli, 'ci', '--hooks'], {
      cwd: l.dir,
      env: { ...process.env, ...l.env },
      stdio: 'ignore',
   });
   return l;
}

/** Start's output above its launch line: the Setup block, as start printed it. */
function aboveLaunch(stdout: string): string {
   const cut = stdout.indexOf('No coding agent was launched.');
   assert.ok(cut > 0, `start printed its entry instructions: ${stdout}`);
   return stdout.slice(0, cut).trimEnd() + '\n';
}

/** Doctor's block equals start's, line for line, except the closing line, which is
 * start's with the agent sentence removed. */
function assertSameBlock(doctor: string, start: string): void {
   const d = doctor.split('\n');
   const s = aboveLaunch(start).split('\n');
   assert.equal(d.length, s.length, `same number of lines:\n${doctor}\n---\n${start}`);
   const closing = d.length - 2; // the last element is the empty string after the final newline
   assert.deepEqual(d.slice(0, closing), s.slice(0, closing), 'every line above the closing line is identical');
   assert.ok(s[closing].endsWith(LAUNCH_SENTENCE), `start's closing line carries the sentence: ${s[closing]}`);
   assert.equal(d[closing], s[closing].slice(0, -LAUNCH_SENTENCE.length), 'the closing line drops only the sentence');
   assert.equal(d[closing + 1], '');
}

// --- doctor against start, on identical inputs ---------------------------------------

test('doctor prints the block start prints above its launch line, except the closing line', async () => {
   // One host reporting the server unregistered, no `.mcp.json`, no hook: a fix for this
   // user and one for a maintainer, so the closing line has both counts.
   const { dir, env } = layer({ declared: true, hosts: { claude: 'exit 1' } });
   const start = await runLeji(['start'], dir, env);
   const doctor = await runLeji(['doctor'], dir, env);
   assert.equal(start.code, 0, start.stderr);
   assert.equal(doctor.code, 1, 'the clone is not ready');
   assertSameBlock(doctor.stdout, start.stdout);
   assert.match(doctor.stdout, /^ {2}2 fixes for you, 1 for a maintainer\.$/m);
});

test('doctor --json is start --json apart from `command`', async () => {
   const { dir, env } = layer({ declared: true, hosts: { claude: 'exit 1' } });
   const start = await runLeji(['start', '--json'], dir, env);
   const doctor = await runLeji(['doctor', '--json'], dir, env);
   assert.equal(start.code, 0, start.stderr);
   assert.equal(doctor.code, 1, 'the exit status agrees with `ready`');
   assert.equal(doctor.stdout, start.stdout.replace('"command": "start"', '"command": "doctor"'));
   const doc = JSON.parse(doctor.stdout) as { command: string; ok: boolean; ready: boolean };
   assert.equal(doc.command, 'doctor');
   assert.equal(doc.ok, true, 'the report was produced');
   assert.equal(doc.ready, false);
});

test("with several hosts and no --agent, both comparisons hold and the unresolved fix is start's", async () => {
   const { dir, env } = layer({ declared: true, hosts: { claude: 'exit 1', codex: 'exit 1' } });
   const start = await runLeji(['start'], dir, env);
   const doctor = await runLeji(['doctor'], dir, env);
   assert.equal(doctor.code, 1);
   assertSameBlock(doctor.stdout, start.stdout);
   assert.match(doctor.stdout, /^ {8}\$ leji start --agent <name>$/m);

   const startJson = await runLeji(['start', '--json'], dir, env);
   const doctorJson = await runLeji(['doctor', '--json'], dir, env);
   assert.equal(doctorJson.stdout, startJson.stdout.replace('"command": "start"', '"command": "doctor"'));
   const doc = JSON.parse(doctorJson.stdout) as { checks: { id: string; status: string; fix: string[] | null }[] };
   const mcp = doc.checks.find((c) => c.id === 'mcp');
   assert.equal(mcp?.status, 'unresolved');
   assert.deepEqual(mcp?.fix, ['leji start --agent <name>']);
});

// --- what doctor does on its own ------------------------------------------------------

test('doctor offers nothing and launches nothing', async () => {
   const { dir, env } = layer({ declared: true, hosts: { claude: 'exit 1' } });
   const r = await runLeji(['doctor'], dir, env);
   assert.ok(r.stdout.includes('Setup for this clone'), r.stdout);
   assert.ok(!r.stdout.includes('No coding agent was launched.'), 'no entry instructions');
   assert.ok(!r.stdout.includes('Starting '), 'no launch');
   assert.ok(!r.stdout.includes('Register the Leji MCP server'), 'no MCP offer');
   assert.ok(!r.stdout.includes('Install the pre-commit hook'), 'no hook offer');
   assert.ok(!r.stdout.includes('either way'), 'no promise about an agent');
});

test('doctor exits 1 on a fresh clone with no hook, in both modes', async () => {
   const { dir, env } = layer({ declared: true });
   const human = await runLeji(['doctor'], dir, env);
   assert.equal(human.code, 1, human.stderr);
   assert.match(human.stdout, /^ {2}you {3}Git hook {4}none yet \(per clone\)$/m);
   assert.match(human.stdout, /^ {2}1 fix for you\.$/m);
   const json = await runLeji(['doctor', '--json'], dir, env);
   assert.equal(json.code, 1);
   assert.equal((JSON.parse(json.stdout) as { ready: boolean }).ready, false);
});

test('doctor exits 0 on a ready clone, in both modes', async () => {
   const { dir, env } = readyLayer();
   const json = await runLeji(['doctor', '--json'], dir, env);
   assert.equal(json.code, 0, json.stderr);
   const doc = JSON.parse(json.stdout) as { ready: boolean; checks: { id: string; status: string; detail: string }[] };
   assert.equal(doc.ready, true);
   assert.deepEqual(
      doc.checks.map((c) => c.status),
      ['ok', 'ok', 'ok', 'ok'],
   );
   // The `cli` row is `ok` because the declared CLI resolves in this context layer: the probe
   // runs the installed shim, not whatever `leji` the machine has.
   assert.equal(doc.checks[0].detail, '1.4.0 (node_modules/.bin/leji)');
   const human = await runLeji(['doctor'], dir, env);
   assert.equal(human.code, 0, human.stderr);
   assert.match(human.stdout, /^ {2}Setup complete\.$/m);
});

test('doctor --agent bogus is a usage error in both modes, before any output', async () => {
   const { dir, env } = layer({ declared: true });
   for (const args of [
      ['doctor', '--agent', 'bogus'],
      ['doctor', '--agent', 'bogus', '--json'],
   ]) {
      const r = await runLeji(args, dir, env);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.stderr, /--agent must be a launchable host/);
      assert.equal(r.stdout.trim(), '', 'nothing is reported for a rejected argument');
   }
});

test('doctor on a missing boot profile exits 1 in both modes', async () => {
   const { dir, env } = layer({ declared: true });
   fs.rmSync(path.join(dir, 'docs', 'boot-profile.md'));
   const json = await runLeji(['doctor', '--json'], dir, env);
   assert.equal(json.code, 1);
   const doc = JSON.parse(json.stdout) as Record<string, unknown>;
   assert.deepEqual(Object.keys(doc), ['command', 'ok', 'ready', 'error', 'checks', 'ecosystem']);
   assert.equal(doc.command, 'doctor');
   assert.equal(doc.ok, false);
   assert.equal(doc.ready, false);
   assert.equal(doc.error, 'boot-missing');
   assert.deepEqual(doc.checks, []);
   const human = await runLeji(['doctor'], dir, env);
   assert.equal(human.code, 1);
   assert.match(human.stderr, /boot profile docs\/boot-profile\.md is missing or invalid; run leji validate/);
   assert.equal(human.stdout, '', 'no block for a context layer with nothing to enter');
});

test('doctor on a repository with no leji.json is the findings envelope, exit 1', async () => {
   const dir = tmpdir('leji-doctor-bare-');
   const r = await runLeji(['doctor', '--json'], dir, { PATH: stubs({}), HOME: tmpdir('leji-doctor-home-') });
   assert.equal(r.code, 1);
   const doc = JSON.parse(r.stdout) as { command: string; ok: boolean; findings: unknown[] };
   assert.equal(doc.command, 'doctor');
   assert.equal(doc.ok, false);
   assert.ok(Array.isArray(doc.findings));
});

test('doctor rejects undeclared flags, --yes included, with exit 2', async () => {
   const { dir, env } = layer({ declared: true });
   for (const flag of ['--yes', '-y', '--dry-run', '--strict', '--', '--frobnicate']) {
      const r = await runLeji(['doctor', flag], dir, env);
      assert.equal(r.code, 2, `${flag}: ${r.stdout}${r.stderr}`);
      assert.ok(!r.stdout.includes('Setup for this clone'), `${flag} runs nothing`);
   }
});

// --- a terminal: never a prompt, never a write ----------------------------------------

/** A snapshot of every file under dir, `.git` included (the clone hook lives there):
 * relpath -> sha256. */
function snapshot(dir: string): [string, string][] {
   const out: [string, string][] = [];
   const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
         const p = path.join(d, e.name);
         if (e.isDirectory()) walk(p);
         else out.push([path.relative(dir, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
      }
   };
   walk(dir);
   return out;
}

/** How every question the CLI asks ends: `<question> [<default>]: `. */
const PROMPT = /\[[^\]\n]*\]: /;

/**
 * Run doctor in process with stdin reporting a terminal: the one input `start` reads
 * to decide it may prompt, offer, and launch. PATH and HOME are the case's for the
 * duration. Everything the command writes to stdout is captured, `process.stdout.write`
 * included, which is where a prompt's question would go.
 */
async function runOnTerminal(args: string[], env: Record<string, string>): Promise<CliResult> {
   const out: string[] = [];
   const err: string[] = [];
   const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
   const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
   const log = console.log;
   const error = console.error;
   const write = process.stdout.write;
   console.log = (...a: unknown[]) => void out.push(a.map(String).join(' ') + '\n');
   console.error = (...a: unknown[]) => void err.push(a.map(String).join(' ') + '\n');
   process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      // The CLI writes text; the test runner's own reports are binary and pass through.
      if (typeof chunk !== 'string')
         return (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
      out.push(chunk);
      // A question is answered with Enter (its default), so a regression that asks
      // one fails on the assertions below instead of waiting on input forever.
      if (PROMPT.test(chunk)) setImmediate(() => process.stdin.push('\n'));
      return true;
   }) as typeof process.stdout.write;
   Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
   Object.assign(process.env, env);
   try {
      const code = await run(args);
      return { code, stdout: out.join(''), stderr: err.join('') };
   } finally {
      console.log = log;
      console.error = error;
      process.stdout.write = write;
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (saved.PATH === undefined) delete process.env.PATH;
      else process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
   }
}

/** Stub bodies that append their own argv to `log` before answering. */
function recording(log: string, name: string, then: string): string {
   return `echo "${name} $*" >> '${log}'\n${then}`;
}

test('on a terminal with two hosts and no --agent, doctor prompts for nothing', async () => {
   const log = path.join(tmpdir('leji-doctor-log-'), 'calls');
   const { dir, env } = layer({
      declared: true,
      shim: recording(log, 'shim', VERSION_STUB),
      hosts: { claude: recording(log, 'claude', 'exit 1'), codex: recording(log, 'codex', 'exit 1') },
   });
   const r = await runOnTerminal(['doctor', '--root', dir], env);
   assert.equal(r.code, 1, r.stderr);
   // A host prompt would print its question and then resolve a host; neither happened.
   assert.doesNotMatch(r.stdout, PROMPT, 'no prompt was printed');
   assert.match(r.stdout, /^ {2}you {3}MCP server {2}pick one: Claude Code, Codex$/m);
   // The only subprocess a stub saw is the version probe: no host was picked, so no
   // registration was queried, and nothing was registered or launched.
   assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['shim --version']);
});

test('on a terminal with one host, doctor queries and offers nothing more, and writes nothing', async () => {
   // The state where `start` on a terminal offers both personal fixes: the host
   // registration and the clone hook.
   const log = path.join(tmpdir('leji-doctor-log-'), 'calls');
   const { dir, env } = layer({
      declared: true,
      shim: recording(log, 'shim', VERSION_STUB),
      hosts: { claude: recording(log, 'claude', 'exit 1') },
   });
   const before = snapshot(dir);
   const r = await runOnTerminal(['doctor', '--root', dir], env);
   assert.equal(r.code, 1, r.stderr);
   assert.doesNotMatch(r.stdout, PROMPT, 'no offer was printed');
   assert.match(r.stdout, /^ {2}you {3}MCP server {2}not registered for Claude Code$/m);
   // The version probe and the host's registration query, and nothing else: no
   // `claude mcp add`, and no launch.
   assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['shim --version', 'claude mcp get leji']);
   assert.deepEqual(snapshot(dir), before, 'the tree, .git included, is byte-identical');
});
