// The filesystem-mutation invariant: only write-intent commands (init, adopt,
// index, docs) may touch the filesystem. Read/analysis commands, and any command
// invoked with a --help/--version meta-flag, must leave the working tree byte-for-
// byte unchanged. Regression guard for the bug where `leji adopt --help` ran adopt
// and scaffolded files instead of printing help.
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const cli = path.join(pkgRoot, 'dist', 'cli.js');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

interface CliResult {
   code: number;
   stdout: string;
   stderr: string;
}

// Run the CLI with its working directory set to dir, so a regressed write-intent
// command would scaffold into the snapshotted sandbox (default --root is ".").
function runCli(args: string[], cwd: string): Promise<CliResult> {
   return new Promise((resolve) => {
      execFile('node', [cli, ...args], { cwd }, (error, stdout, stderr) => {
         resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
   });
}

// A content snapshot of every file under dir (excluding .git): relpath -> sha256.
function snapshot(dir: string): [string, string][] {
   const out: [string, string][] = [];
   const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
         if (e.name === '.git') continue;
         const p = path.join(d, e.name);
         if (e.isDirectory()) walk(p);
         else out.push([path.relative(dir, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
      }
   };
   walk(dir);
   return out;
}

function sandboxWithLayer(): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-nowrite-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   return dir;
}

function sandboxEmpty(): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-empty-'));
   fs.writeFileSync(path.join(dir, 'README.md'), '# sandbox\n');
   return dir;
}

// Read/analysis commands: run against a real layer; nothing may change.
const READ_COMMANDS = [
   ['validate'],
   ['conformance'],
   ['freshness'],
   ['detect'],
   ['index', '--check'],
   ['changelog', 'check'],
];

for (const argv of READ_COMMANDS) {
   test(`read command "${argv.join(' ')}" does not modify the filesystem`, async () => {
      const dir = sandboxWithLayer();
      const before = snapshot(dir);
      await runCli(argv, dir);
      assert.deepEqual(snapshot(dir), before, `${argv.join(' ')} changed files`);
   });
}

// Every documented command with --help/--version must print and never write,
// including the write-intent commands. The sandbox is a populated dir where a
// regressed adopt/init would scaffold if the meta-flag were ignored.
const documented: string[] = JSON.parse(
   fs.readFileSync(path.join(repoRoot, 'packages', 'sdk', 'cli.json'), 'utf8'),
).commands.map((c: { name: string }) => c.name);

for (const name of documented) {
   for (const meta of ['--help', '--version']) {
      test(`"${name} ${meta}" prints, exits 0, and does not modify the filesystem`, async () => {
         const dir = sandboxEmpty();
         const before = snapshot(dir);
         const r = await runCli([...name.split(' '), meta], dir);
         assert.equal(r.code, 0, `${name} ${meta} exited ${r.code}: ${r.stderr}`);
         if (meta === '--help') assert.match(r.stdout, /Usage: leji/);
         else assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
         assert.deepEqual(snapshot(dir), before, `${name} ${meta} wrote files`);
      });
   }
}

// Positive control: a real write-intent run DOES change the tree, proving the
// snapshot detector above can actually see writes (so the no-write tests mean
// something).
test('init --yes writes files (snapshot detector is not blind)', async () => {
   const dir = sandboxEmpty();
   const before = snapshot(dir);
   const r = await runCli(['init', '--yes'], dir);
   assert.equal(r.code, 0, r.stderr);
   assert.notDeepEqual(snapshot(dir), before, 'init --yes should have written files');
});

// dry-run is analysis-intent: it computes the write plan but must not write.
for (const cmd of ['init', 'adopt']) {
   test(`${cmd} --dry-run does not modify the filesystem`, async () => {
      const dir = sandboxEmpty();
      const before = snapshot(dir);
      await runCli([cmd, '--dry-run', '--yes'], dir);
      assert.deepEqual(snapshot(dir), before, `${cmd} --dry-run wrote files`);
   });
}
