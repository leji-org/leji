import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { run } from '../../dist/index.js';

const execFileAsync = promisify(execFile);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const cli = path.join(pkgRoot, 'dist', 'cli.js');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

interface CliResult {
   code: number;
   stdout: string;
   stderr: string;
}

// Subprocess runner: reserved for the few smoke tests that must exercise the real
// bin (process exit-code wiring, stdin-driven prompts).
async function runCliProc(args: string[], opts: { input?: string; cwd?: string } = {}): Promise<CliResult> {
   return new Promise((resolve) => {
      const child = execFile('node', [cli, ...args], { cwd: opts.cwd ?? repoRoot }, (error, stdout, stderr) => {
         resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
      if (opts.input !== undefined) {
         child.stdin!.write(opts.input);
         child.stdin!.end();
      }
   });
}

// In-process runner: same result shape, but calls run() directly and captures
// console output, with no node cold-start (so it does not contend under the
// concurrent suite). cli.js is just `process.exit(await run(argv))`, so the exit
// code and console output match the bin for every command that needs neither a
// real process exit nor stdin.
async function runCli(args: string[]): Promise<CliResult> {
   const outLines: string[] = [];
   const errLines: string[] = [];
   const origLog = console.log;
   const origError = console.error;
   console.log = (...a: unknown[]) => {
      outLines.push(a.join(' '));
   };
   console.error = (...a: unknown[]) => {
      errLines.push(a.join(' '));
   };
   try {
      const code = await run(args);
      return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
   } finally {
      console.log = origLog;
      console.error = origError;
   }
}

test('cli --version prints the SDK version', async () => {
   const result = await runCliProc(['--version']);
   assert.equal(result.code, 0);
   assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('cli with no command shows usage and exits 2', async () => {
   const result = await runCliProc([]);
   assert.equal(result.code, 2);
   assert.match(result.stdout, /Usage: leji/);
});

test('cli help exits 0', async () => {
   const result = await runCli(['help']);
   assert.equal(result.code, 0);
});

test('cli unknown command exits 2', async () => {
   const result = await runCli(['frobnicate']);
   assert.equal(result.code, 2);
   assert.match(result.stderr, /unknown command/);
});

test('cli unknown flag exits 2', async () => {
   const result = await runCli(['validate', '--frobnicate']);
   assert.equal(result.code, 2);
   assert.match(result.stderr, /unknown option/);
});

test('cli validate --json emits the stable findings shape', async () => {
   const result = await runCli([
      'validate',
      '--root',
      path.join(repoRoot, 'fixtures', 'invalid-bad-decision'),
      '--json',
   ]);
   assert.equal(result.code, 1);
   const payload = JSON.parse(result.stdout);
   assert.equal(payload.command, 'validate');
   assert.equal(payload.ok, false);
   assert.equal(payload.summary.errors, 2);
   for (const f of payload.findings) {
      assert.ok(f.rule && f.severity && f.message, 'finding carries rule/severity/message');
   }
});

test('cli validate flags a non-git layer with git-required', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-cli-git-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const result = await runCli(['validate', '--root', dir, '--json']);
   const payload = JSON.parse(result.stdout);
   assert.ok(
      payload.findings.some((f: { rule: string }) => f.rule === 'git-required'),
      'git-required finding present for a non-git working copy',
   );
});

test('cli index --check --json reports staleness', async () => {
   const result = await runCli([
      'index',
      '--check',
      '--root',
      path.join(repoRoot, 'fixtures', 'invalid-stale-index'),
      '--json',
   ]);
   assert.equal(result.code, 1);
   assert.equal(JSON.parse(result.stdout).stale, true);
});

test('cli changelog without subcommand exits 2', async () => {
   const result = await runCli(['changelog']);
   assert.equal(result.code, 2);
});

test('cli changelog check --strict makes unverifiable an error', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-cli-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const lax = await runCli(['changelog', 'check', '--root', dir]);
   assert.equal(lax.code, 0);
   assert.match(lax.stdout, /changelog-unverifiable/);
   const strict = await runCli(['changelog', 'check', '--root', dir, '--strict']);
   assert.equal(strict.code, 1);
});

test('cli freshness --json carries expired and upcoming lists', async () => {
   const result = await runCli(['freshness', '--root', exampleDir, '--json']);
   assert.equal(result.code, 0);
   const payload = JSON.parse(result.stdout);
   assert.equal(payload.declared, 1);
   assert.deepEqual(payload.expired, []);
   assert.deepEqual(payload.upcoming, []);
});

test('cli conformance --json carries the checklist items', async () => {
   const result = await runCli(['conformance', '--root', exampleDir, '--json']);
   assert.equal(result.code, 0);
   const payload = JSON.parse(result.stdout);
   assert.equal(payload.claimedLevel, 'indexed');
   assert.equal(payload.verifiedLevel, 'indexed');
   const ids = payload.items.map((i: { id: string }) => i.id);
   for (const id of [
      'manifest-valid',
      'boot-profile',
      'categories',
      'owner',
      'vendor-redirects',
      'index-current',
      'changelog',
      'review-gate',
      'agent-profiles',
      'ci-validates',
      'freshness-declared',
      'consumed-externally',
      'stale-pin-reporting',
      'sibling-mounts',
   ]) {
      assert.ok(ids.includes(id), `checklist item ${id} present`);
   }
});

test('cli init interactive prompts drive the bootstrap', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-cli-init-'));
   // name, description, root, owner name, owner contact,
   // domain? system? practice? governance?, indexed?
   const answers = ['acme-context', 'Acme layer.', 'context/', 'Jo', 'jo@acme.example', 'y', 'n', 'n', 'n', 'y'];
   const result = await runCliProc(['init', '--dir', dir], { input: answers.join('\n') + '\n' });
   assert.equal(result.code, 0, result.stderr);
   const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'leji.json'), 'utf8'));
   assert.equal(manifest.name, 'acme-context');
   assert.equal(manifest.rootPath, 'context/');
   assert.equal(manifest.conformance.claimedLevel, 'indexed');
   assert.deepEqual(Object.keys(manifest.categories), ['domain', 'decisions']);
   assert.ok(fs.existsSync(path.join(dir, 'context', 'context-index.json')));
   const validate = await runCli(['validate', '--root', dir]);
   assert.equal(validate.code, 0, validate.stdout);
});

test('cli init refusal surfaces as exit 2', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-cli-init2-'));
   await runCli(['init', '--dir', dir, '--yes']);
   const again = await runCli(['init', '--dir', dir, '--yes']);
   assert.equal(again.code, 2);
   assert.match(again.stderr, /refuses to overwrite/);
});

test('cli index generate writes and reports entries', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-cli-idx-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const result = await runCli(['index', '--root', dir, '--json']);
   assert.equal(result.code, 0);
   const payload = JSON.parse(result.stdout);
   assert.equal(payload.written, 'docs/context-index.json');
   assert.equal(payload.entries, 3);
});

test('cli.json documents exactly the commands the CLI accepts', async () => {
   const cli = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'sdk', 'cli.json'), 'utf8'));
   const documented: string[] = cli.commands.map((c: { name: string }) => c.name).sort();
   // Every documented command is accepted (not an "unknown command" usage
   // error). Each runs against a fresh empty dir so init bootstraps cleanly
   // while the read commands report a missing manifest, never a usage error.
   for (const name of documented) {
      const argv = name.split(' '); // e.g. "changelog check" -> ["changelog","check"]
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-cmd-'));
      const extra =
         name === 'init'
            ? ['--yes']
            : name === 'changelog compact'
              ? ['--keep', '1']
              : name === 'agent'
                ? ['--host', 'codex', '--name', 'reviewer']
                : name === 'mounts locate'
                  ? ['some-mount']
                  : [];
      const result = await runCli([...argv, '--root', dir, ...extra]);
      assert.ok(!/unknown command/.test(result.stderr), `"${name}" should be a known command`);
      assert.notEqual(result.code, 2, `"${name}" should not be a usage error`);
   }
   // A bogus command is rejected, proving the check above is meaningful.
   const bogus = await runCli(['frobnicate']);
   assert.equal(bogus.code, 2);
   // The documented set matches the canonical command list.
   assert.deepEqual(documented, [
      'adopt',
      'agent',
      'changelog check',
      'changelog compact',
      'ci',
      'conformance',
      'detect',
      'freshness',
      'index',
      'init',
      'mounts hydrate',
      'mounts locate',
      'mounts status',
      'route',
      'start',
      'status',
      'validate',
      'view',
      'viewer',
      'viewer build',
      'viewer serve',
   ]);
});

test('cli --help renders from cli.json (commands and the reference link)', async () => {
   const help = await runCli(['--help']);
   assert.equal(help.code, 0);
   const cli = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'sdk', 'cli.json'), 'utf8'));
   for (const c of cli.commands) {
      assert.ok(help.stdout.includes(c.name), `help lists ${c.name}`);
   }
   assert.match(help.stdout, /leji\.org\/cli/);
});

test('cli --help is the trimmed top level: globals only, no per-command flags, points to per-command help', async () => {
   const help = await runCli(['--help']);
   assert.equal(help.code, 0);
   // The flattened per-command options are gone from the top level (this is the
   // bulk of the old length). Spot-check command-specific flags are absent.
   for (const flag of ['--wire-adapters', '--content', '--keep <n>', '--provider <name>']) {
      assert.ok(!help.stdout.includes(flag), `top-level help should not list ${flag}`);
   }
   // ...but the global options and the pointer to per-command help are present.
   assert.match(help.stdout, /--root <dir>/);
   assert.match(help.stdout, /Run `leji <command> --help`/);
});

test('cli <command> --help renders that command: usage, its flags, and examples', async () => {
   const help = await runCli(['adopt', '--help']);
   assert.equal(help.code, 0);
   assert.match(help.stdout, /^leji adopt: /);
   assert.match(help.stdout, /Usage: leji adopt /);
   assert.match(help.stdout, /--wire-adapters/); // command-specific flag
   assert.match(help.stdout, /--root <dir>/); // globals included
   assert.match(help.stdout, /Examples:/);
   assert.match(help.stdout, /leji\.org\/cli/);
});

test('cli <two-word command> --help resolves the subcommand', async () => {
   const help = await runCli(['changelog', 'compact', '--help']);
   assert.equal(help.code, 0);
   assert.match(help.stdout, /^leji changelog compact: /);
   assert.match(help.stdout, /Usage: leji changelog compact /);
   assert.match(help.stdout, /--keep <n>/);
});
