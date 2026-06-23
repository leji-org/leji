import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateViewer, loadManifest, run, serveViewer, validateManifestObject } from '../dist/index.js';
import type { Manifest } from '../dist/index.js';
import { contentFindings } from '../dist/commands/validate.js';
import { finding, sortFindings } from '../dist/lib/findings.js';
import { realpathWithin, walkMd } from '../dist/lib/fsx.js';
import { schemaErrors } from '../dist/lib/schemas.js';
import { gitLastModified, gitShowHead, gitToplevel } from '../dist/lib/git.js';
import { readJsonArtifact } from '../dist/lib/layer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

// realpath the tmp dir: on macOS /tmp is a symlink, which the git/realpath paths resolve.
const tmpdir = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const copyExample = (): string => {
   const d = tmpdir('leji-cov-');
   fs.cpSync(exampleDir, d, { recursive: true });
   return d;
};

// run() writes to the console; swallow it so the test log stays readable.
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
   const log = console.log;
   const err = console.error;
   console.log = () => {};
   console.error = () => {};
   try {
      return await fn();
   } finally {
      console.log = log;
      console.error = err;
   }
}

function gitInit(dir: string): string {
   const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
   g('init', '-q');
   g('config', 'user.email', 't@example.com');
   g('config', 'user.name', 'Test');
   return dir;
}

// --- lib/findings: sortFindings tiebreak chain (path -> rule -> message) ---
test('sortFindings: undefined path sorts first, then rule, then message', () => {
   const e = (rule: string, msg: string, p?: string) => finding(rule, 'error', msg, p);
   const sorted = sortFindings([
      e('b', 'm', 'z.ts'),
      e('a', 'm'), // undefined path -> ''
      e('a', 'bbb', 'a.ts'),
      e('a', 'aaa', 'a.ts'), // same path+rule -> message tiebreak
      e('a', 'aaa', 'a.ts'), // fully equal -> 0
   ]);
   assert.equal(sorted[0].path, undefined);
   assert.deepEqual(
      sorted.map((f) => `${f.path ?? ''}/${f.rule}/${f.message}`),
      ['/a/m', 'a.ts/a/aaa', 'a.ts/a/aaa', 'a.ts/a/bbb', 'z.ts/b/m'],
   );
});

// --- lib/fsx: realpathWithin error branches ---
test('realpathWithin: unresolvable root is false; non-existent target is allowed', () => {
   assert.equal(realpathWithin(path.join(os.tmpdir(), 'leji-no-such-root-zzz'), os.tmpdir()), false);
   const d = tmpdir('leji-rpw-');
   assert.equal(realpathWithin(d, path.join(d, 'missing')), true);
});

// --- lib/schemas: root-level violation label ---
test('schemaErrors labels a root-level violation as (root)', () => {
   const errs = schemaErrors('context-manifest', 'not-an-object');
   assert.ok(errs.length > 0);
   assert.ok(
      errs.some((e: string) => e.startsWith('(root)')),
      errs.join(' | '),
   );
});

// --- lib/git: lastModified / showHead across tracked, dirty, deleted, no-git ---
test('git helpers cover committed, untracked, dirty, deleted, and no-git states', () => {
   const dir = gitInit(tmpdir('leji-git-'));
   const file = path.join(dir, 'a.md');
   fs.writeFileSync(file, 'hello');
   assert.equal(gitLastModified(dir, 'a.md'), null); // untracked -> null
   execFileSync('git', ['-C', dir, 'add', 'a.md'], { stdio: 'ignore' });
   execFileSync('git', ['-C', dir, 'commit', '-qm', 'add'], { stdio: 'ignore' });
   assert.match(gitLastModified(dir, 'a.md') ?? '', /^\d{4}-\d{2}-\d{2}$/); // committed -> date
   assert.equal(gitShowHead(dir, 'a.md'), 'hello'); // HEAD blob content
   fs.writeFileSync(file, 'changed');
   assert.equal(gitLastModified(dir, 'a.md'), null); // dirty working tree -> null
   fs.rmSync(file);
   assert.equal(gitShowHead(dir, 'a.md'), null); // deleted on disk -> realpath throws -> null
   const nogit = tmpdir('leji-nogit-');
   assert.equal(gitShowHead(nogit, 'a.md'), null); // outside git -> null
   assert.equal(gitToplevel(nogit), null);
});

// --- lib/layer: readJsonArtifact rejects a root-escaping artifact ---
test('readJsonArtifact rejects an artifact that resolves outside the layer root', () => {
   const root = tmpdir('leji-artifact-');
   fs.symlinkSync('/etc/hosts', path.join(root, 'evil.json')); // resolves outside root
   const { data, finding: f } = readJsonArtifact(root, 'evil.json');
   assert.equal(data, null);
   assert.equal(f?.rule, 'artifact-parse');
   assert.match(f!.message, /outside the layer root/);
});

// --- index/run: flag parsing errors ---
test('run: malformed flags and missing values exit 2', async () => {
   const cases = [
      ['--port', 'x', 'validate'],
      ['--level', 'bad', 'init'],
      ['--root'],
      ['--dir'],
      ['--name'],
      ['--bad', 'validate'],
   ];
   for (const argv of cases) {
      assert.equal(await quiet(() => run(argv)), 2, argv.join(' '));
   }
});

// --- index/run: valid optional flags (success branches), attached to a no-op command ---
test('run: valid --name/--open/--check/--port parse without starting a server', async () => {
   // `version` ignores these flags, so the parse branches run but no viewer server starts.
   assert.equal(await quiet(() => run(['--name', 'acme', '--open', '--check', '--port', '0', 'version'])), 0);
});

test('run: rejects flags not declared for the command (exit 2), accepts declared ones', async () => {
   // Per-command flag surface from cli.json: globals everywhere, command flags only on their command.
   for (const argv of [
      ['validate', '--strict', '--root', exampleDir],
      ['validate', '--check', '--root', exampleDir],
      ['validate', '--open', '--root', exampleDir],
      ['conformance', '--strict', '--root', exampleDir],
      ['index', '--open', '--root', exampleDir],
   ]) {
      assert.equal(await quiet(() => run(argv)), 2, argv.join(' '));
   }
   // declared flags (and globals) are still accepted, not a usage error:
   assert.notEqual(await quiet(() => run(['index', '--check', '--root', exampleDir])), 2);
   assert.notEqual(await quiet(() => run(['changelog', 'check', '--strict', '--root', exampleDir])), 2);
});

// --- lib/fsx: walkMd excludes markdown reached through a root-escaping symlink ---
test('walkMd skips markdown behind symlinks that escape the root', () => {
   const outside = tmpdir('leji-out-');
   fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
   const root = tmpdir('leji-walk-');
   fs.mkdirSync(path.join(root, 'docs'));
   fs.writeFileSync(path.join(root, 'docs', 'real.md'), '# real');
   fs.symlinkSync(outside, path.join(root, 'docs', 'link')); // directory symlink escaping root
   fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'docs', 'linked.md')); // file symlink escaping root
   assert.deepEqual(walkMd(root, 'docs'), ['docs/real.md']);
});

// --- index/run: version, help, no command, unknown command ---
test('run: version/help/no-command/unknown dispatch', async () => {
   assert.equal(await quiet(() => run(['version'])), 0);
   assert.equal(await quiet(() => run(['--version'])), 0);
   assert.equal(await quiet(() => run(['help'])), 0);
   assert.equal(await quiet(() => run([])), 2);
   assert.equal(await quiet(() => run(['nope'])), 2);
});

// --- index/run: read commands (text + json) against the example layer ---
test('run: read commands against the example layer', async () => {
   for (const argv of [
      ['validate', '--root', exampleDir],
      ['conformance', '--root', exampleDir],
      ['freshness', '--root', exampleDir],
      ['index', '--check', '--root', exampleDir],
      ['changelog', 'check', '--root', exampleDir],
      ['validate', '--json', '--root', exampleDir],
      ['conformance', '--json', '--root', exampleDir],
      ['freshness', '--json', '--root', exampleDir],
   ]) {
      assert.equal(await quiet(() => run(argv)), 0, argv.join(' '));
   }
   assert.equal(await quiet(() => run(['changelog', '--root', exampleDir])), 2); // missing 'check'
   assert.equal(await quiet(() => run(['validate', '--root', path.join(os.tmpdir(), 'leji-none-xyz')])), 1); // no manifest
});

// --- index/run: write commands on a throwaway copy (docs + index) ---
test('run: viewer and index write dispatch on a temp copy', async () => {
   const copy = copyExample();
   assert.equal(await quiet(() => run(['viewer', '--root', copy])), 0);
   assert.equal(await quiet(() => run(['index', '--root', copy])), 0);
});

// --- index/run: agent command CLI path (usage error, human + json output, idempotent) ---
test('run: agent command writes a profile, binds it, and is idempotent', async () => {
   const copy = copyExample();
   // missing --name -> usage error
   assert.equal(await quiet(() => run(['agent', '--root', copy])), 2);
   // human output: a host-agnostic resident agent (role defaults to reviewer)
   assert.equal(await quiet(() => run(['agent', '--name', 'reviewer-a', '--root', copy])), 0);
   // json output, pinned to a host (exercises the roleHost host branch + json payload)
   assert.equal(
      await quiet(() => run(['agent', '--name', 'reviewer-b', '--host', 'codex', '--json', '--root', copy])),
      0,
   );
   // re-run the same agent -> "already present / already bound" branch
   assert.equal(await quiet(() => run(['agent', '--name', 'reviewer-a', '--root', copy])), 0);
   const m = JSON.parse(fs.readFileSync(path.join(copy, 'leji.json'), 'utf8'));
   assert.ok(m.agents['reviewer-a'] && m.agents['reviewer-b']);
});

// --- index/run: ci command dispatch, including the CircleCI manual branch ---
test('run: ci command covers provider dispatch, note, and the manual branch', async () => {
   // unknown provider -> usage error
   assert.equal(await quiet(() => run(['ci', '--provider', 'nope', '--root', copyExample()])), 2);
   // azure created, human -> prints the activation note
   assert.equal(await quiet(() => run(['ci', '--provider', 'azure', '--root', copyExample()])), 0);
   // azure created, json -> note carried in the json payload
   assert.equal(await quiet(() => run(['ci', '--provider', 'azure', '--json', '--root', copyExample()])), 0);
   // circleci with a pre-existing config -> manual: prints a snippet, leaves the file untouched
   const copy = copyExample();
   fs.mkdirSync(path.join(copy, '.circleci'), { recursive: true });
   fs.writeFileSync(path.join(copy, '.circleci', 'config.yml'), 'version: 2.1\n');
   assert.equal(await quiet(() => run(['ci', '--provider', 'circleci', '--root', copy])), 0);
   assert.equal(await quiet(() => run(['ci', '--provider', 'circleci', '--json', '--root', copy])), 0);
});

// --- index/run: detect --json and start's boot-missing branch ---
test('run: detect --json and start reports a missing boot profile', async () => {
   assert.equal(await quiet(() => run(['detect', '--json', '--root', copyExample()])), 0);
   const copy = copyExample();
   const { manifest } = loadManifest(copy);
   fs.rmSync(path.join(copy, manifest!.bootProfilePath)); // remove the boot profile so start can't enter
   // start is non-interactive here (no TTY under the test runner); a missing boot profile -> exit 1
   assert.equal(await quiet(() => run(['start', '--root', copy])), 1);
});

// --- commands/viewer: serveViewer security branches (400 / 404 / directory) ---
test('serveViewer answers 400 on bad encoding and 404 on dotfile segments', async () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const server = await serveViewer(dir, 0, manifest!.rootPath);
   const port = (server.address() as { port: number }).port;
   const status = (p: string): Promise<number> =>
      new Promise((res, rej) => {
         http
            .get({ host: '127.0.0.1', port, path: p }, (r) => {
               r.resume();
               res(r.statusCode ?? 0);
            })
            .on('error', rej);
      });
   const rootPath = manifest!.rootPath.replace(/\/+$/, '');
   try {
      assert.equal(await status('/%E0%A4%A'), 400); // malformed percent-encoding -> URIError -> 400
      assert.equal(await status('/.git/config'), 404); // VCS / dotfile segment -> 404
      assert.equal(await status('/'), 200); // viewer chrome served at the web root
      assert.equal(await status('/content/.leji/viewer/index.html'), 404); // .leji not reachable by direct URL
      // A symlink under the content dir that resolves outside the root -> 403.
      fs.symlinkSync('/etc/hosts', path.join(dir, rootPath, 'evil'));
      assert.equal(await status('/content/evil'), 403);
   } finally {
      server.close();
   }
});

// --- lib/manifest: loadManifest confines the leji.json read to the layer root ---
test('loadManifest rejects a leji.json that resolves outside the layer root', () => {
   const root = tmpdir('leji-manifest-escape-');
   fs.symlinkSync('/etc/hosts', path.join(root, 'leji.json')); // symlinked manifest escaping root
   const { manifest, findings } = loadManifest(root);
   assert.equal(manifest, null);
   assert.equal(findings[0]?.rule, 'manifest-parse');
   assert.match(findings[0]!.message, /outside the layer root/);
});

// --- lib/manifest: validateManifestObject validates an in-memory manifest ---
test('validateManifestObject accepts a well-formed manifest object', () => {
   const { manifest, findings } = validateManifestObject({
      leji: '1.0',
      name: 'inline',
      rootPath: 'docs/',
      bootProfilePath: 'docs/boot-profile.md',
      categories: { domain: { paths: ['docs/domain/'] }, decisions: { paths: ['docs/decisions/'] } },
      owners: { primary: { name: 'Inline Owner' } },
   });
   assert.notEqual(manifest, null);
   assert.deepEqual(findings, []);
});

test('validateManifestObject reports manifest-schema findings for a malformed object', () => {
   const { manifest, findings } = validateManifestObject({ leji: '1.0', name: 'inline' }); // missing required fields
   assert.equal(manifest, null);
   assert.ok(findings.some((f) => f.rule === 'manifest-schema'));
});

test('validateManifestObject reports an unsupported declared spec line', () => {
   const { manifest, findings } = validateManifestObject({ leji: '9.9', name: 'inline' });
   assert.equal(manifest, null);
   assert.equal(findings[0]?.rule, 'manifest-line');
});

// --- validate --content confines the boot-profile read ---
test('contentFindings skips a boot profile that resolves outside the layer root', () => {
   const root = tmpdir('leji-content-boot-');
   fs.symlinkSync('/etc/hosts', path.join(root, 'boot.md')); // boot symlink escaping root
   const manifest = {
      leji: '1.0',
      name: 'x',
      rootPath: '',
      bootProfilePath: 'boot.md',
      categories: {},
      owners: { primary: { name: 'owner' } },
   } as unknown as Manifest;
   // The escaping file must not be read, so it yields no content findings (and no throw).
   const out = contentFindings(root, manifest);
   assert.ok(!out.some((f) => f.path === 'boot.md'));
});
