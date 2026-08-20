import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pickDocsRoot } from '@leji-org/leji';
import { DOCS_CANDIDATES, KNOWN_VENDOR_FILES, classifyTarget } from '@leji-org/leji/internal/create';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const bin = path.join(pkgRoot, 'index.js');
const lejiCli = path.join(repoRoot, 'packages', 'sdk', 'dist', 'cli.js');

// One sandbox for the whole file: every case gets its own directory inside it, and
// nothing the router or the delegated command does escapes it.
const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'create-leji-'));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

let seq = 0;
/** A fresh target directory, populated by `files` (a trailing `/` means a directory). */
function fixture(files = []) {
   const dir = path.join(sandbox, `case-${seq++}`);
   fs.mkdirSync(dir, { recursive: true });
   for (const rel of files) {
      const abs = path.join(dir, rel);
      if (rel.endsWith('/')) fs.mkdirSync(abs, { recursive: true });
      else {
         fs.mkdirSync(path.dirname(abs), { recursive: true });
         fs.writeFileSync(abs, '# fixture\n');
      }
   }
   return dir;
}

function exec(file, args, cwd) {
   return new Promise((resolve) => {
      execFile('node', [file, ...args], { cwd }, (error, stdout, stderr) => {
         resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      });
   });
}

const create = (args, cwd = sandbox) => exec(bin, args, cwd);
const leji = (args, cwd = sandbox) => exec(lejiCli, args, cwd);

/** The delegated command name, read out of the scaffold JSON document. */
const routed = (result) => JSON.parse(result.stdout).command;

const DRY = ['--yes', '--dry-run', '--json'];

describe('routing', () => {
   test('an empty directory is a new repository', async () => {
      const r = await create([fixture(), ...DRY]);
      assert.equal(r.code, 0);
      assert.equal(routed(r), 'init');
      assert.match(r.stderr, /^create-leji: new repository → leji init$/m);
   });

   test('a directory that does not exist yet is a new repository', async () => {
      const r = await create([path.join(fixture(), 'my-app'), ...DRY]);
      assert.equal(r.code, 0);
      assert.equal(routed(r), 'init');
   });

   for (const entry of ['docs/', 'Docs/', 'CLAUDE.md', '.cursor/rules', '.github/copilot-instructions.md']) {
      test(`${entry} makes it an existing repository`, async () => {
         const r = await create([fixture([entry]), ...DRY]);
         assert.equal(r.code, 0);
         assert.equal(routed(r), 'adopt');
         assert.match(r.stderr, /^create-leji: existing repository → leji adopt$/m);
      });
   }

   test('only the selected target is inspected, never its parent', async () => {
      const monorepo = fixture(['docs/', 'packages/app/']);
      const r = await create([path.join(monorepo, 'packages', 'app'), ...DRY]);
      assert.equal(routed(r), 'init');
   });

   test('a symlinked target is classified through its real path', async () => {
      const real = fixture(['docs/']);
      const link = path.join(sandbox, `link-${seq++}`);
      fs.symlinkSync(real, link);
      assert.equal(routed(await create([link, ...DRY])), 'adopt');
   });

   test('the target is the current directory when no directory is given', async () => {
      const r = await create(DRY, fixture(['CLAUDE.md']));
      assert.equal(routed(r), 'adopt');
   });
});

describe('a repository that already has a layer', () => {
   test('human mode names the next command on stderr and exits 0', async () => {
      const r = await create([fixture(['leji.json'])]);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /^create-leji: this repository already has a Leji layer; next: leji start$/m);
   });

   test('--json says the same thing on stdout and exits 0', async () => {
      const r = await create([fixture(['leji.json']), '--json']);
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), {
         command: 'create-leji',
         ok: true,
         route: 'exists',
         next: ['leji', 'start'],
      });
   });
});

describe('refusals', () => {
   test(
      'a target that cannot be listed refuses, and no command runs',
      { skip: os.platform() === 'win32' || process.getuid?.() === 0 },
      async () => {
         const dir = fixture();
         fs.chmodSync(dir, 0o000);
         try {
            const r = await create([dir, ...DRY]);
            assert.equal(r.code, 2);
            assert.equal(r.stdout, '');
            assert.match(r.stderr, /^create-leji: cannot read /m);
         } finally {
            fs.chmodSync(dir, 0o755);
         }
      },
   );

   test('a dangling symlink is unreadable, not missing', async () => {
      const link = path.join(sandbox, `dangling-${seq++}`);
      fs.symlinkSync(path.join(sandbox, 'nowhere'), link);
      const r = await create([link, ...DRY]);
      assert.equal(r.code, 2);
      assert.equal(r.stdout, '');
   });

   test('a file where a directory was named is unreadable', async () => {
      const file = path.join(fixture(['README.md']), 'README.md');
      assert.equal((await create([file, ...DRY])).code, 2);
   });

   test('--init and --adopt together refuse', async () => {
      const r = await create(['--init', '--adopt', ...DRY]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /cannot be combined/);
   });

   test('a directory given twice refuses', async () => {
      const r = await create(['app', '--dir', 'other', ...DRY]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /give the directory once/);
   });

   test('a second directory refuses', async () => {
      const r = await create(['app', 'other', ...DRY]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /unexpected argument other/);
   });
});

describe('argv', () => {
   test('--init forces init on a repository that would have been adopted', async () => {
      const r = await create([fixture(['docs/']), '--init', ...DRY]);
      assert.equal(routed(r), 'init');
      assert.match(r.stderr, /^create-leji: --init → leji init$/m);
   });

   test('--adopt forces adopt on a repository that would have been initialised', async () => {
      const r = await create([fixture(), '--adopt', ...DRY]);
      assert.equal(routed(r), 'adopt');
      assert.match(r.stderr, /^create-leji: --adopt → leji adopt$/m);
   });

   test('flags after the directory pass through in order', async () => {
      const r = await create([fixture(), '--yes', '--dry-run', '--json', '--name', 'acme-context']);
      assert.equal(r.code, 0);
      assert.equal(routed(r), 'init');
   });

   test('a --dir the caller wrote passes through untouched', async () => {
      const cwd = fixture();
      const target = path.join(sandbox, `dir-flag-${seq++}`);
      const r = await create(['--dir', target, '--yes'], cwd);
      assert.equal(r.code, 0);
      assert.ok(fs.existsSync(path.join(target, 'leji.json')), 'the layer is written under --dir');
      assert.ok(!fs.existsSync(path.join(cwd, 'leji.json')), 'and not in the current directory');
   });

   test('a --dir the caller wrote is the directory that gets classified', async () => {
      // The current directory already has a layer, so classifying it would have ended in
      // the no-op route: the init here can only come from reading the --dir value.
      const cwd = fixture(['leji.json']);
      const target = path.join(sandbox, `dir-target-${seq++}`);
      fs.mkdirSync(target);
      const r = await create(['--dir', target, ...DRY], cwd);
      assert.equal(r.code, 0);
      assert.equal(routed(r), 'init');
      assert.match(r.stderr, /^create-leji: new repository → leji init$/m);
   });

   test('the last --dir wins, the way leji parses it', async () => {
      const ignored = fixture(['docs/']); // would have routed to adopt
      const target = fixture();
      const r = await create(['--dir', ignored, '--dir', target, ...DRY]);
      assert.equal(r.code, 0);
      assert.equal(routed(r), 'init');
   });

   test('the equals spelling names the target too', async () => {
      // leji's parser expands `--dir=<v>` for its declared value flags, so the router
      // has to read that spelling as the target rather than route on the cwd.
      const docsRepo = fixture(['docs/']);
      const r = await create([`--dir=${docsRepo}`, ...DRY], fixture());
      assert.equal(r.code, 0);
      assert.equal(routed(r), 'adopt');
      assert.equal(routed(await create([`--root=${docsRepo}`, ...DRY], fixture())), 'adopt');
   });

   test('the last directory flag wins across both spellings', async () => {
      const ignored = fixture(['docs/']);
      const target = fixture();
      assert.equal(routed(await create(['--dir', ignored, `--dir=${target}`, ...DRY])), 'init');
      assert.equal(routed(await create([`--dir=${ignored}`, '--dir', target, ...DRY])), 'init');
   });

   test('a positional plus the equals spelling refuses', async () => {
      const r = await create(['app', '--dir=other', ...DRY]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /give the directory once/);
   });

   test('--root is the target when there is no --dir', async () => {
      // leji reads --root as the target when --dir is absent, so the router has to too:
      // the cwd here is empty and would have routed to init.
      const target = fixture(['docs/']);
      const r = await create(['--root', target, ...DRY], fixture());
      assert.equal(r.code, 0);
      assert.equal(routed(r), 'adopt');
   });

   for (const [label, args] of [
      ['no value', ['--dir']],
      ['a flag-shaped value', ['--root', '--yes']],
      ['an empty equals value', ['--dir=']],
      ['an empty equals value on --root', ['--root=']],
   ]) {
      test(`a directory flag with ${label} says nothing and lets leji refuse`, async () => {
         const r = await create(args, fixture());
         assert.equal(r.code, 2);
         assert.equal(r.stderr.includes('create-leji:'), false, 'the router adds no line of its own');
         assert.match(r.stderr, /requires a value/);
      });
   }

   test('--init before the directory still names the directory', async () => {
      const target = path.join(sandbox, `forced-init-${seq++}`);
      const r = await create(['--init', target, '--yes'], sandbox);
      assert.equal(r.code, 0);
      assert.ok(fs.existsSync(path.join(target, 'leji.json')), 'the layer is written under the directory');
      assert.ok(!fs.existsSync(path.join(sandbox, 'leji.json')), 'and not in the current directory');
   });

   test('--adopt before the directory still names the directory', async () => {
      const target = fixture(['docs/']);
      const r = await create(['--adopt', target, '--yes'], sandbox);
      assert.equal(r.code, 0);
      assert.ok(fs.existsSync(path.join(target, 'leji.json')), 'the layer is written under the directory');
      assert.ok(!fs.existsSync(path.join(sandbox, 'leji.json')), 'and not in the current directory');
   });

   test('--help prints the usage and runs nothing', async () => {
      const r = await create(['--help']);
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trimEnd().split('\n').length, 8);
      assert.match(r.stdout, /^Usage: create-leji \[dir\]/);
      assert.equal((await create(['-h'])).stdout, r.stdout);
   });

   test('the exit code is the delegated command, not the router', async () => {
      const dir = fixture(['leji.json']);
      const delegated = await leji(['init', '--dir', dir, '--yes']);
      const r = await create([dir, '--init', '--yes']);
      assert.equal(delegated.code, 2);
      assert.equal(r.code, delegated.code);
   });
});

describe('classify', () => {
   // The router and `leji adopt` read one list each, on the SDK's internal subpath, so
   // these drive the assertion from that data rather than restating it: every entry the
   // SDK recognizes has to route to adopt, or the two have drifted apart.
   test('every vendor entrypoint the SDK knows routes to adopt', () => {
      assert.ok(KNOWN_VENDOR_FILES.length > 0);
      for (const rel of KNOWN_VENDOR_FILES) {
         assert.equal(classifyTarget(fixture([rel])), 'adopt', rel);
      }
   });

   test('every docs root the SDK knows routes to adopt', () => {
      assert.ok(DOCS_CANDIDATES.length > 0);
      for (const rel of DOCS_CANDIDATES) {
         assert.equal(classifyTarget(fixture([rel])), 'adopt', rel);
         assert.equal(classifyTarget(fixture([rel.toUpperCase()])), 'adopt', rel.toUpperCase());
      }
   });

   test('pickDocsRoot takes the exact spelling first, then the lowest name', () => {
      assert.equal(pickDocsRoot(['src', 'docs']), 'docs/');
      assert.equal(pickDocsRoot(['Docs']), 'Docs/');
      assert.equal(pickDocsRoot(['DOCS', 'Docs']), 'DOCS/');
      assert.equal(pickDocsRoot(['docs', 'Docs']), 'docs/');
      assert.equal(pickDocsRoot(['doc', 'docs']), 'docs/');
      assert.equal(pickDocsRoot(['documentation', 'doc']), 'doc/');
      assert.equal(pickDocsRoot(['src', 'lib']), null);
   });

   test('classifyTarget names each state', () => {
      assert.equal(classifyTarget(path.join(sandbox, 'no-such-thing')), 'missing');
      assert.equal(classifyTarget(fixture()), 'init');
      assert.equal(classifyTarget(fixture(['docs/'])), 'adopt');
      assert.equal(classifyTarget(fixture(['GEMINI.md'])), 'adopt');
      assert.equal(classifyTarget(fixture(['leji.json'])), 'adopted');
      assert.equal(classifyTarget(fixture(['docs/', 'leji.json'])), 'adopted');
   });

   test('a docs entry that is a file is not a docs root', () => {
      assert.equal(classifyTarget(fixture(['docs'])), 'init');
   });

   test('a vendor entrypoint counts whether it is a file or a directory', () => {
      assert.equal(classifyTarget(fixture(['.cursor/rules'])), 'adopt');
      assert.equal(classifyTarget(fixture(['.cursor/rules/'])), 'adopt');
   });
});
