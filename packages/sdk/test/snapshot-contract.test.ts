import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { snapshotTree } from './helpers/snapshot.ts';

// The shared fixture is the byte contract for the snapshot helper, and these goldens
// are the frozen bytes the Go and Python ports assert against too. The walked payload
// is `payload/`; the seeds and the goldens live beside it, outside the walk, so a
// golden never has to contain its own digest.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixtureDir = path.join(repoRoot, 'fixtures', 'snapshot-contract');

interface Seed {
   from: string;
   to: string;
}

interface Declaration {
   seeds: Seed[];
   runtime: { directories: string[]; symlinks: { at: string; to: string }[] };
   goldens: Record<string, { file: string; walk: string; repoRoot: string }>;
}

const declaration = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'leji-test.json'), 'utf8')) as Declaration;

/** Copy a committed seed's CONTENTS into `to`, which this harness creates. Regular
 * files and directories only, exactly as the seed convention fixes it
 * (`fixtures/README.md`): a symlink anywhere inside a seed is a harness error. */
function copySeed(from: string, to: string): void {
   fs.mkdirSync(to, { recursive: true });
   for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      assert.ok(!entry.isSymbolicLink(), `seed carries a symlink: ${src}`);
      if (entry.isDirectory()) copySeed(src, dest);
      else {
         assert.ok(entry.isFile(), `seed carries a non-regular file: ${src}`);
         fs.copyFileSync(src, dest);
      }
   }
}

/** A working copy of the fixture with everything the declaration says a walk must
 * find: the declared seeds materialized as real `.git` directories, then the entries
 * git cannot track (an empty directory, a symlink) created here. */
function materialize(): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-snapshot-'));
   fs.cpSync(fixtureDir, dir, { recursive: true });
   for (const seed of declaration.seeds) {
      const toAbs = path.join(dir, ...seed.to.split('/'));
      assert.ok(!fs.existsSync(toAbs), `seed target already exists: ${seed.to}`);
      copySeed(path.join(dir, ...seed.from.split('/')), toAbs);
   }
   for (const rel of declaration.runtime.directories) {
      fs.mkdirSync(path.join(dir, ...rel.split('/')), { recursive: true });
   }
   for (const link of declaration.runtime.symlinks) {
      fs.symlinkSync(link.to, path.join(dir, ...link.at.split('/')));
   }
   return dir;
}

/** The frozen bytes of one golden, as the lines a walk must produce. */
function golden(name: string): string[] {
   const text = fs.readFileSync(path.join(fixtureDir, declaration.goldens[name].file), 'utf8');
   assert.ok(text.endsWith('\n'), `${name}: a golden ends with a newline`);
   return text.slice(0, -1).split('\n');
}

test('the whole-repository walk: the repository .git is excluded and every nested one is content', () => {
   const dir = materialize();
   try {
      const payload = path.join(dir, 'payload');
      const lines = snapshotTree(payload, { repoRoot: payload });
      assert.deepEqual(lines, golden('repo'), 'the walk is the frozen golden, line for line');

      // What the golden says, said again as claims, so a re-baked golden that lost one
      // of them fails here rather than passing quietly.
      assert.ok(
         !lines.some((line) => line === '.git/\tdir' || line.startsWith('.git/')),
         'the repository .git is absent from the snapshot',
      );
      assert.ok(lines.includes('pkg/.git/\tdir'), 'the nested .git is an entry of its own');
      assert.ok(
         lines.some((line) => line.startsWith('pkg/.git/HEAD\tsha256:')),
         'and its contents are digested like any other file',
      );
      assert.ok(lines.includes('empty/\tdir'), 'an empty directory is recorded, so its creation is detectable');
      assert.ok(lines.includes('link\tnon-regular'), 'a symlink is marked, never followed');

      // The ordering is bytewise over UTF-8, not over UTF-16 code units. The two
      // non-ASCII payload entries are the vector that separates them: `ｚ` (EF BD 9A)
      // sorts before `😀` (F0 9F 98 80) by bytes and after it by code units, so this
      // golden is only reachable one way.
      const wide = lines.findIndex((line) => line.startsWith('ｚ.txt\t'));
      const grin = lines.findIndex((line) => line.startsWith('😀.txt\t'));
      assert.ok(wide >= 0 && grin >= 0, 'both non-ASCII entries are recorded');
      assert.ok(wide < grin, 'the wide latin z precedes the emoji, which is UTF-8 byte order');
      assert.notDeepEqual([...lines].sort(), lines, 'and a UTF-16 code-unit sort would order them the other way');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('repoRoot defaults to the walked directory, which is the whole-repository call', () => {
   const dir = materialize();
   try {
      const payload = path.join(dir, 'payload');
      assert.deepEqual(snapshotTree(payload), golden('repo'), 'the default is the same walk');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('a subtree walk keeps the subtree .git, and drops it only when the subtree IS the repository', () => {
   const dir = materialize();
   try {
      const payload = path.join(dir, 'payload');
      const pkg = path.join(payload, 'pkg');

      // Root means the repository, not the call: `pkg/.git` is content, and the paths
      // are relative to the walked directory.
      assert.deepEqual(snapshotTree(pkg, { repoRoot: payload }), golden('subtree'), 'the frozen subtree golden');

      // The same walk claiming the subtree as the repository excludes exactly the .git
      // lines, and nothing else moves.
      const own = golden('subtree').filter((line) => line !== '.git/\tdir' && !line.startsWith('.git/'));
      assert.deepEqual(snapshotTree(pkg, { repoRoot: pkg }), own, 'its own .git is the one entry excluded');
      assert.ok(own.length > 0, 'and the walk still records the rest of the subtree');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});
