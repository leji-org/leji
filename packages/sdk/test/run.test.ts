import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');
const fixture = (name: string) => path.join(repoRoot, 'fixtures', name);

interface Captured {
   code: number;
   out: string;
   err: string;
}

/** Run the CLI in-process (the same entry create-leji uses), capturing output. */
async function runInProcess(argv: string[]): Promise<Captured> {
   const outLines: string[] = [];
   const errLines: string[] = [];
   const origLog = console.log;
   const origError = console.error;
   console.log = (...args: unknown[]) => outLines.push(args.join(' '));
   console.error = (...args: unknown[]) => errLines.push(args.join(' '));
   try {
      const code = await run(argv);
      return { code, out: outLines.join('\n'), err: errLines.join('\n') };
   } finally {
      console.log = origLog;
      console.error = origError;
   }
}

test('run version', async () => {
   const r = await runInProcess(['version']);
   assert.equal(r.code, 0);
   assert.match(r.out, /^\d+\.\d+\.\d+$/);
});

test('run usage paths: no command, help, unknown command, bad flag values', async () => {
   assert.equal((await runInProcess([])).code, 2);
   assert.equal((await runInProcess(['help'])).code, 0);
   assert.equal((await runInProcess(['frobnicate'])).code, 2);
   assert.equal((await runInProcess(['validate', '--root'])).code, 2);
   assert.equal((await runInProcess(['init', '--level', 'galactic'])).code, 2);
   assert.equal((await runInProcess(['changelog', 'frobnicate'])).code, 2);
});

test('run validate json on a failing fixture', async () => {
   const r = await runInProcess(['validate', '--root', fixture('invalid-bad-decision'), '--json']);
   assert.equal(r.code, 1);
   const payload = JSON.parse(r.out);
   assert.equal(payload.summary.errors, 2);
});

test('run validate on a missing manifest', async () => {
   const r = await runInProcess(['validate', '--root', fixture('invalid-no-manifest')]);
   assert.equal(r.code, 1);
   assert.match(r.out, /manifest-missing/);
});

test('run index and index --check against a temp copy', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const gen = await runInProcess(['index', '--root', dir, '--json']);
   assert.equal(gen.code, 0);
   assert.equal(JSON.parse(gen.out).entries, 3);
   const check = await runInProcess(['index', '--check', '--root', dir, '--json']);
   assert.equal(check.code, 0);
   assert.equal(JSON.parse(check.out).stale, false);
});

test('run index against a missing manifest', async () => {
   const r = await runInProcess(['index', '--root', fixture('invalid-no-manifest')]);
   assert.equal(r.code, 1);
});

test('run changelog check without a declared changelog path', async () => {
   const r = await runInProcess(['changelog', 'check', '--root', fixture('valid-minimal-core'), '--json']);
   assert.equal(r.code, 1);
   const payload = JSON.parse(r.out);
   assert.ok(payload.findings.some((f: { rule: string }) => f.rule === 'changelog-required'));
});

test('run index on a core layer with no machine.indexPath writes the default and reports it', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-coreidx-'));
   fs.cpSync(fixture('valid-minimal-core'), dir, { recursive: true });
   const r = await runInProcess(['index', '--root', dir, '--json']);
   assert.equal(r.code, 0, r.out + r.err);
   const payload = JSON.parse(r.out);
   assert.equal(payload.written, 'docs/context-index.json');
   assert.ok(!payload.findings.some((f: { message: string }) => /not declared|no machine/.test(f.message)));
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'context-index.json')), 'default index written');
});

test('run changelog check on a core layer resolves the default changelog path (no "not declared")', async () => {
   const r = await runInProcess(['changelog', 'check', '--root', fixture('valid-minimal-core'), '--json']);
   const payload = JSON.parse(r.out);
   // The default path resolves; the file is simply absent, so the finding is the
   // missing-file changelog-required, never a "not declared" error.
   for (const f of payload.findings as { message: string }[]) {
      assert.ok(!/not declared|no machine/.test(f.message), `no "not declared" message: ${f.message}`);
   }
   assert.ok(
      payload.findings.some(
         (f: { rule: string; message: string }) =>
            f.rule === 'changelog-required' && /docs\/context-changelog\.json does not exist/.test(f.message),
      ),
   );
});

test('run changelog compact without --keep or --before exits 2', async () => {
   const r = await runInProcess(['changelog', 'compact', '--root', exampleDir]);
   assert.equal(r.code, 2);
   assert.match(r.err, /changelog compact requires --keep or --before/);
});

test('run changelog compact --keep folds the oldest and reports counts', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-compact-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const r = await runInProcess(['changelog', 'compact', '--keep', '1', '--root', dir, '--json']);
   assert.equal(r.code, 0, r.out + r.err);
   const payload = JSON.parse(r.out);
   assert.equal(payload.folded, 1); // example has 2 entries; keep newest 1
   assert.equal(payload.kept, 2); // 1 survivor + the compaction entry
   const log = JSON.parse(fs.readFileSync(path.join(dir, 'docs', 'context-changelog.json'), 'utf8'));
   assert.equal(log.entries[log.entries.length - 1].type, 'compaction');
});

test('run changelog check on the example layer', async () => {
   const r = await runInProcess(['changelog', 'check', '--root', exampleDir]);
   assert.equal(r.code, 0);
});

test('run freshness human output and strict', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-fresh-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const invariants = path.join(dir, 'docs', 'system', 'invariants.md');
   fs.writeFileSync(
      invariants,
      fs.readFileSync(invariants, 'utf8').replace('reviewAfter: 2026-12-10', 'reviewAfter: 2020-01-01'),
   );
   const lax = await runInProcess(['freshness', '--root', dir]);
   assert.equal(lax.code, 0);
   assert.match(lax.out, /freshness-expired/);
   const strict = await runInProcess(['freshness', '--root', dir, '--strict']);
   assert.equal(strict.code, 1);
});

test('run conformance human output lists checklist items', async () => {
   const r = await runInProcess(['conformance', '--root', exampleDir]);
   assert.equal(r.code, 0);
   assert.match(r.out, /\[core\]/);
   assert.match(r.out, /manual/);
});

test('run conformance against a missing manifest', async () => {
   const r = await runInProcess(['conformance', '--root', fixture('invalid-no-manifest'), '--json']);
   assert.equal(r.code, 1);
   const payload = JSON.parse(r.out);
   assert.equal(payload.claimedLevel, 'none');
   assert.equal(payload.verifiedLevel, 'none');
});

test('run init --yes then validate through the dispatcher', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-init-'));
   const init = await runInProcess(['init', '--dir', dir, '--yes', '--name', 'demo-context']);
   assert.equal(init.code, 0);
   assert.match(init.out, /Wrote 7 files/);
   const again = await runInProcess(['init', '--dir', dir, '--yes']);
   assert.equal(again.code, 2);
   assert.match(again.err, /refuses to overwrite/);
});

test('conformance marks failing core items', async () => {
   const missing = await runInProcess(['conformance', '--root', fixture('invalid-missing-boot-profile'), '--json']);
   assert.equal(missing.code, 1);
   const payload = JSON.parse(missing.out);
   const boot = payload.items.find((i: { id: string }) => i.id === 'boot-profile');
   assert.equal(boot.status, 'fail');
   assert.equal(payload.verifiedLevel, 'none');

   const vendor = await runInProcess(['conformance', '--root', fixture('invalid-vendor-no-redirect'), '--json']);
   const item = JSON.parse(vendor.out).items.find((i: { id: string }) => i.id === 'vendor-redirects');
   assert.equal(item.status, 'fail');
});

test('run docs generates the viewer and prints the serve hint', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-docs-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const r = await runInProcess(['docs', '--root', dir]);
   assert.equal(r.code, 0);
   assert.match(r.out, /serve locally: leji docs --serve/);
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'index.html')));
   assert.ok(fs.existsSync(path.join(dir, 'docs', '_sidebar.md')));
});

test('run docs against a missing manifest', async () => {
   const r = await runInProcess(['docs', '--root', fixture('invalid-no-manifest')]);
   assert.equal(r.code, 1);
   assert.match(r.out, /manifest-missing/);
});

test('run docs --serve binds a server, serves the viewer, then exits on signal', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-serve-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const { execFile } = await import('node:child_process');
   const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
   const child = execFile('node', [cliPath, 'docs', '--serve', '--port', '0', '--root', dir]);
   try {
      // Wait for the "serving http://127.0.0.1:<port>/..." line to learn the port.
      const port = await new Promise<number>((resolve, reject) => {
         const timer = setTimeout(() => reject(new Error('timed out waiting for serve line')), 5000);
         child.stdout!.on('data', (chunk: Buffer) => {
            const m = /serving http:\/\/127\.0\.0\.1:(\d+)\//.exec(chunk.toString());
            if (m) {
               clearTimeout(timer);
               resolve(Number(m[1]));
            }
         });
      });
      const page = await fetch(`http://127.0.0.1:${port}/docs/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /stripFrontmatter/);
   } finally {
      // SIGINT closes the server, resolving the keep-alive promise so run() returns.
      child.kill('SIGINT');
   }
});

test('init interactive forces domain when both domain and system are declined', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-force-'));
   // name, description, root, owner name, owner contact, domain n, system n,
   // practice n, governance n, indexed n
   const answers = ['', '', '', 'Jo', '', 'n', 'n', 'n', 'n', 'n'];
   const { execFile } = await import('node:child_process');
   const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
   const result = await new Promise<{ code: number }>((resolve) => {
      const child = execFile('node', [cliPath, 'init', '--dir', dir], (error) => {
         resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0 });
      });
      child.stdin!.write(answers.join('\n') + '\n');
      child.stdin!.end();
   });
   assert.equal(result.code, 0);
   const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'leji.json'), 'utf8'));
   assert.ok(manifest.categories.domain, 'domain was forced in');
});
