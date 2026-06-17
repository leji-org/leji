import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateDocs, loadManifest, run, serveDocs } from '../dist/index.js';
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
test('run: valid --name/--serve/--check/--port parse without starting a server', async () => {
   // `version` ignores these flags, so the parse branches run but no docs server starts.
   assert.equal(await quiet(() => run(['--name', 'acme', '--serve', '--check', '--port', '0', 'version'])), 0);
});

test('run: rejects flags not declared for the command (exit 2), accepts declared ones', async () => {
   // Per-command flag surface from cli.json: globals everywhere, command flags only on their command.
   for (const argv of [
      ['validate', '--strict', '--root', exampleDir],
      ['validate', '--check', '--root', exampleDir],
      ['validate', '--serve', '--root', exampleDir],
      ['conformance', '--strict', '--root', exampleDir],
      ['index', '--serve', '--root', exampleDir],
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
test('run: docs and index write dispatch on a temp copy', async () => {
   const copy = copyExample();
   assert.equal(await quiet(() => run(['docs', '--root', copy])), 0);
   assert.equal(await quiet(() => run(['index', '--root', copy])), 0);
});

// --- commands/docs: serveDocs security branches (400 / 404 / directory) ---
test('serveDocs answers 400 on bad encoding and 404 on dotfile segments', async () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   generateDocs(dir, manifest!);
   const server = await serveDocs(dir, 0);
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
      assert.equal(await status('/' + rootPath), 301); // directory w/o trailing slash -> 301 (relative-asset fix)
      assert.equal(await status('/' + rootPath + '/'), 200); // trailing slash -> index.html body
      // A symlink that passes the lexical check but resolves outside the root -> 403.
      fs.symlinkSync('/etc/hosts', path.join(dir, rootPath, 'evil'));
      assert.equal(await status('/' + rootPath + '/evil'), 403);
   } finally {
      server.close();
   }
});
