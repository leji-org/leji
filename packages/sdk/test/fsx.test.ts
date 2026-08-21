import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
   guardRoot,
   mkdirpGuarded,
   openWriteGuarded,
   renameGuarded,
   resolvedWithinRoot,
   rmGuarded,
   verifiedTargetRead,
   writeFileAtomicGuarded,
   writeFileGuarded,
} from '../dist/lib/fsx.js';
import { DIST_REL, WORK_REL } from '../dist/lib/layout.js';

// The write boundary at its own level: the strict within-root primitive, the rule
// `guardedWrite` applies through every convenience, and the verified read that
// decides what is standing at a target before anything acts on it. The canary suite
// pins the same rule through the commands; these pin the mechanism, so a port has a
// per-case oracle rather than an end-to-end one.

/** A temp repository root, realpath-resolved (macOS hands out /var -> /private/var). */
function repo(): string {
   return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-fsx-')));
}

/** A destination outside any repository, for the escape cases. */
function outside(): string {
   return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-outside-')));
}

// --- the strict within-root primitive ----------------------------------------

test('resolvedWithinRoot: existing, absent, dangling, escaping, case-variant', () => {
   const root = repo();
   fs.writeFileSync(path.join(root, 'file.md'), 'x\n');
   assert.equal(resolvedWithinRoot(root, path.join(root, 'file.md')), true, 'an existing file inside root');
   assert.equal(resolvedWithinRoot(root, path.join(root, 'not-yet', 'file.md')), true, 'a not-yet-created target');

   const away = outside();
   fs.symlinkSync(path.join(away, 'gone.md'), path.join(root, 'dangling.md'));
   assert.equal(resolvedWithinRoot(root, path.join(root, 'dangling.md')), false, 'a dangling link out of root');

   fs.writeFileSync(path.join(away, 'real.md'), 'x\n');
   fs.symlinkSync(path.join(away, 'real.md'), path.join(root, 'escape.md'));
   assert.equal(resolvedWithinRoot(root, path.join(root, 'escape.md')), false, 'a link resolving out of root');

   fs.mkdirSync(path.join(root, 'dir'));
   fs.symlinkSync(away, path.join(root, 'dir', 'up'));
   assert.equal(resolvedWithinRoot(root, path.join(root, 'dir', 'up', 'new.md')), false, 'a symlinked ancestor');

   // A `.LEJI/` spelling on a case-insensitive filesystem resolves to the directory
   // the filesystem actually holds, which is what the `.leji/` rule then judges.
   fs.mkdirSync(path.join(root, '.leji', 'dist'), { recursive: true });
   const variant = path.join(root, '.LEJI', 'dist', 'x.html');
   if (fs.existsSync(path.join(root, '.LEJI'))) {
      const verdict = writeFileGuarded(root, variant, null, 'x');
      assert.equal(verdict.ok, false, 'a .LEJI/ spelling is judged as the .leji/ role it opens');
      assert.equal(verdict.role, 'dist');
   }

   fs.rmSync(root, { recursive: true, force: true });
   fs.rmSync(away, { recursive: true, force: true });
});

test('resolvedWithinRoot: an unreadable directory is unresolvable, and unresolvable is false', (t) => {
   if (process.getuid?.() === 0) {
      t.skip('running as root: a 0o000 directory is still traversable');
      return;
   }
   const root = repo();
   const closed = path.join(root, 'closed');
   fs.mkdirSync(closed);
   fs.writeFileSync(path.join(closed, 'target.md'), 'x\n');
   fs.chmodSync(closed, 0o000);
   try {
      if (fs.existsSync(path.join(closed, 'target.md'))) {
         t.skip('this platform allows traversal of a 0o000 directory');
         return;
      }
      assert.equal(resolvedWithinRoot(root, path.join(closed, 'target.md')), false, 'unresolvable fails closed');
      const verdict = writeFileGuarded(root, path.join(closed, 'target.md'), null, 'x');
      assert.equal(verdict.ok, false);
      assert.equal(verdict.unresolvable, true, 'and the chokepoint refuses it as unresolvable');
   } finally {
      fs.chmodSync(closed, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
   }
});

// --- the rule, through the conveniences ---------------------------------------

test('the write rule: outside the repository is refused absolutely, whatever the role', () => {
   const root = repo();
   const away = outside();
   fs.mkdirSync(path.join(root, '.leji'), { recursive: true });
   fs.symlinkSync(away, path.join(root, '.leji', 'dist'));

   const verdict = writeFileGuarded(root, path.join(root, DIST_REL, 'index.html'), DIST_REL, 'x');
   assert.equal(verdict.ok, false, 'an own-role target relocated out of the repository is refused');
   assert.equal(verdict.outsideRoot, true);
   assert.deepEqual(fs.readdirSync(away), [], 'and nothing was written outside');

   const cleared = rmGuarded(root, path.join(root, DIST_REL), DIST_REL);
   assert.equal(cleared.outsideRoot, true, 'the clear is refused the same way');
   assert.ok(fs.existsSync(away), 'the out-of-tree directory still stands');

   fs.rmSync(root, { recursive: true, force: true });
   fs.rmSync(away, { recursive: true, force: true });
});

test('the write rule: another role is refused, the own role passes, no role is content-only', () => {
   const root = repo();
   fs.mkdirSync(path.join(root, WORK_REL), { recursive: true });

   const crossed = writeFileGuarded(root, path.join(root, WORK_REL, 'stolen.md'), DIST_REL, 'x');
   assert.equal(crossed.ok, false, 'the export role may not write into the work role');
   assert.equal(crossed.role, 'work');
   assert.equal(fs.existsSync(path.join(root, WORK_REL, 'stolen.md')), false, 'nothing was written');

   assert.equal(writeFileGuarded(root, path.join(root, DIST_REL, 'index.html'), DIST_REL, 'x').ok, true, 'own role');
   assert.equal(writeFileGuarded(root, path.join(root, 'overview.md'), null, 'x').ok, true, 'ordinary content');

   const roleless = writeFileGuarded(root, path.join(root, DIST_REL, 'other.html'), null, 'x');
   assert.equal(roleless.ok, false, 'content has no legitimate .leji/ landing');
   assert.equal(roleless.role, 'dist');

   const bare = writeFileGuarded(root, path.join(root, '.leji', 'loose.md'), DIST_REL, 'x');
   assert.equal(bare.ok, false, 'a file loose in .leji/ is not the export role');
   assert.equal(bare.role, 'loose.md', 'the role is the first segment under .leji/');
   const lejiItself = rmGuarded(root, path.join(root, '.leji'), DIST_REL);
   assert.equal(lejiItself.ok, false, '.leji/ itself is never the export role');
   assert.equal(lejiItself.role, '');
   assert.equal(fs.existsSync(path.join(root, WORK_REL)), true, 'and the trust domain still stands');

   fs.rmSync(root, { recursive: true, force: true });
});

test('the write rule: a parent symlinked out of root is caught before the file is created', () => {
   const root = repo();
   const away = outside();
   fs.symlinkSync(away, path.join(root, 'redirect'));
   const verdict = writeFileGuarded(root, path.join(root, 'redirect', 'planted.md'), null, 'x');
   assert.equal(verdict.ok, false);
   assert.equal(verdict.outsideRoot, true);
   assert.deepEqual(fs.readdirSync(away), [], 'the parent was not written through');
   fs.rmSync(root, { recursive: true, force: true });
   fs.rmSync(away, { recursive: true, force: true });
});

test('the conveniences: exclusive create, mkdirp, rename, atomic write, guarded open', () => {
   const root = repo();
   const away = outside();

   const created = writeFileGuarded(root, path.join(root, 'leji.json'), null, '{}\n', { exclusive: true });
   assert.equal(created.ok, true);
   const again = writeFileGuarded(root, path.join(root, 'leji.json'), null, '{"other":1}\n', { exclusive: true });
   assert.equal(again.ok, false);
   assert.equal(again.exists, true, 'an existing target is its own verdict, never an overwrite');
   assert.equal(fs.readFileSync(path.join(root, 'leji.json'), 'utf8'), '{}\n', 'the bytes are untouched');

   const made = mkdirpGuarded(root, path.join(root, DIST_REL, 'content'), DIST_REL);
   assert.equal(made.ok, true);
   assert.equal(made.ok && made.real, path.join(root, DIST_REL, 'content'), 'the checked resolved path comes back');

   fs.symlinkSync(away, path.join(root, 'out'));
   assert.equal(mkdirpGuarded(root, path.join(root, 'out', 'deep'), null).ok, false, 'mkdirp is guarded too');
   assert.deepEqual(fs.readdirSync(away), []);

   assert.equal(
      renameGuarded(root, path.join(root, 'leji.json'), path.join(root, 'out', 'leji.json'), null).ok,
      false,
      'a rename with an escaping destination is refused',
   );
   assert.equal(fs.existsSync(path.join(root, 'leji.json')), true, 'and the source is still there');
   assert.equal(renameGuarded(root, path.join(root, 'leji.json'), path.join(root, 'moved.json'), null).ok, true);

   assert.equal(writeFileAtomicGuarded(root, path.join(root, 'ci.yml'), null, 'jobs:\n').ok, true);
   assert.equal(fs.readFileSync(path.join(root, 'ci.yml'), 'utf8'), 'jobs:\n');
   assert.equal(fs.existsSync(path.join(root, 'ci.yml.leji-tmp')), false, 'the temp sibling is gone');
   assert.equal(
      writeFileAtomicGuarded(root, path.join(root, 'out', 'ci.yml'), null, 'x').ok,
      false,
      'an escaping atomic destination is refused',
   );

   const opened = openWriteGuarded(root, path.join(root, DIST_REL, 'assets', 'app.css'), DIST_REL, { mode: 0o644 });
   assert.equal(opened.ok, true);
   if (opened.ok) {
      fs.writeSync(opened.fd, 'body{}\n');
      fs.closeSync(opened.fd);
      assert.equal(fs.readFileSync(opened.real, 'utf8'), 'body{}\n');
   }
   const refusedOpen = openWriteGuarded(root, path.join(root, 'out', 'app.css'), null);
   assert.equal(refusedOpen.ok, false);
   assert.deepEqual(fs.readdirSync(away), [], 'nothing landed outside the repository');

   fs.rmSync(root, { recursive: true, force: true });
   fs.rmSync(away, { recursive: true, force: true });
});

test('an exclusive create is decided on the standing entry, never on where it resolves', () => {
   // O_EXCL on the RESOLVED path is not enough: a dangling symlink resolves to its
   // missing destination, so resolving first would let `leji.json -> nowhere` create
   // the file the link points at. ANY standing entry is `exists`, and nothing anywhere
   // is created.
   const root = repo();
   const away = outside();
   fs.mkdirSync(path.join(root, WORK_REL), { recursive: true });
   fs.writeFileSync(path.join(root, WORK_REL, 'private.json'), 'private\n');
   const target = path.join(root, 'leji.json');
   const bytes = '{"schemaVersion":"1.0"}\n';

   const cases: { name: string; plant: () => void; landing: string }[] = [
      {
         name: 'a dangling link to a contained path',
         plant: () => fs.symlinkSync(path.join(root, 'missing.json'), target),
         landing: path.join(root, 'missing.json'),
      },
      {
         name: 'a dangling link out of the repository',
         plant: () => fs.symlinkSync(path.join(away, 'missing.json'), target),
         landing: path.join(away, 'missing.json'),
      },
      {
         name: 'a link into another role',
         plant: () => fs.symlinkSync(path.join(root, WORK_REL, 'planted.json'), target),
         landing: path.join(root, WORK_REL, 'planted.json'),
      },
      {
         name: 'a link to a standing file in another role',
         plant: () => fs.symlinkSync(path.join(root, WORK_REL, 'private.json'), target),
         landing: target, // its destination stands already; the bytes are checked below
      },
      { name: 'a directory', plant: () => fs.mkdirSync(target), landing: target },
   ];
   for (const c of cases) {
      c.plant();
      const verdict = writeFileGuarded(root, target, null, bytes, { exclusive: true });
      assert.equal(verdict.ok, false, `${c.name}: refused`);
      assert.equal(verdict.exists, true, `${c.name}: reported as an existing target`);
      if (c.landing !== target) {
         assert.equal(fs.existsSync(c.landing), false, `${c.name}: the link's destination was not created`);
      }
      fs.rmSync(target, { recursive: true, force: true });
   }
   assert.equal(
      fs.readFileSync(path.join(root, WORK_REL, 'private.json'), 'utf8'),
      'private\n',
      "the other role's file was never written through",
   );

   // A standing regular file is the ordinary case, and its bytes stay as they were.
   fs.writeFileSync(target, 'original\n');
   const overExisting = writeFileGuarded(root, target, null, bytes, { exclusive: true });
   assert.equal(overExisting.exists, true, 'an existing regular file is never overwritten');
   assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
   fs.rmSync(target);

   // Nothing standing: the resolved path is judged, its parents included, and created.
   assert.equal(writeFileGuarded(root, target, null, bytes, { exclusive: true }).ok, true);
   assert.equal(fs.readFileSync(target, 'utf8'), bytes);
   assert.deepEqual(fs.readdirSync(away), [], 'nothing was created outside the repository at any point');
   assert.deepEqual(fs.readdirSync(path.join(root, WORK_REL)), ['private.json'], 'nor in another role');

   fs.rmSync(root, { recursive: true, force: true });
   fs.rmSync(away, { recursive: true, force: true });
});

test('a refused write establishes no directory', () => {
   const root = repo();
   fs.mkdirSync(path.join(root, WORK_REL), { recursive: true });
   const verdict = writeFileGuarded(root, path.join(root, WORK_REL, 'deep', 'nested', 'x.md'), DIST_REL, 'x');
   assert.equal(verdict.ok, false);
   assert.equal(fs.existsSync(path.join(root, WORK_REL, 'deep')), false, 'no parent was created for a refused write');
   fs.rmSync(root, { recursive: true, force: true });
});

// --- the verified read ---------------------------------------------------------

test('verifiedTargetRead: absent, regular, dangling, socket, symlink to socket, directory', () => {
   const root = repo();
   const target = path.join(root, 'leji-badge.svg');

   assert.deepEqual(verifiedTargetRead(root, target, null).status, 'absent', 'nothing standing there');

   fs.writeFileSync(target, 'svg\n');
   const regular = verifiedTargetRead(root, target, null);
   assert.equal(regular.status, 'regular');
   assert.equal(regular.status === 'regular' && regular.bytes.toString('utf8'), 'svg\n');
   fs.rmSync(target);

   fs.symlinkSync(path.join(root, 'missing.svg'), target);
   const dangling = verifiedTargetRead(root, target, null);
   assert.equal(dangling.status, 'refused', 'a standing dangling link is never written through as absent');
   assert.equal(dangling.status === 'refused' && dangling.reason, 'unverifiable');
   fs.rmSync(target);

   const sock = path.join(root, 'sock');
   const server = net.createServer();
   server.listen(sock);
   try {
      const direct = verifiedTargetRead(root, sock, null);
      assert.equal(direct.status, 'refused');
      assert.equal(direct.status === 'refused' && direct.reason, 'not-regular');
      fs.symlinkSync(sock, target);
      const linked = verifiedTargetRead(root, target, null);
      assert.equal(linked.status, 'refused', 'a link to a socket is settled on what it resolves to');
      assert.equal(linked.status === 'refused' && linked.reason, 'not-regular');
      fs.rmSync(target);
   } finally {
      server.close();
      fs.rmSync(sock, { force: true });
   }

   fs.mkdirSync(target);
   const dir = verifiedTargetRead(root, target, null);
   assert.equal(dir.status, 'refused');
   assert.equal(dir.status === 'refused' && dir.reason, 'not-regular');
   fs.rmSync(target, { recursive: true });

   fs.rmSync(root, { recursive: true, force: true });
});

test('verifiedTargetRead: outside root, another role, and a parent symlinked out', () => {
   const root = repo();
   const away = outside();
   fs.writeFileSync(path.join(away, 'real.svg'), 'svg\n');

   const escaping = path.join(root, 'escape.svg');
   fs.symlinkSync(path.join(away, 'real.svg'), escaping);
   const out = verifiedTargetRead(root, escaping, null);
   assert.equal(out.status, 'refused');
   assert.equal(out.status === 'refused' && out.reason, 'outside-root');

   fs.mkdirSync(path.join(root, WORK_REL), { recursive: true });
   fs.writeFileSync(path.join(root, WORK_REL, 'private.svg'), 'svg\n');
   const crossing = path.join(root, 'crossing.svg');
   fs.symlinkSync(path.join(root, WORK_REL, 'private.svg'), crossing);
   const role = verifiedTargetRead(root, crossing, null);
   assert.equal(role.status, 'refused');
   assert.equal(role.status === 'refused' && role.reason, 'other-role');
   assert.equal(verifiedTargetRead(root, crossing, WORK_REL).status, 'regular', 'its own role reads through');

   fs.symlinkSync(away, path.join(root, 'redirect'));
   const parent = verifiedTargetRead(root, path.join(root, 'redirect', 'real.svg'), null);
   assert.equal(parent.status, 'refused');
   assert.equal(parent.status === 'refused' && parent.reason, 'outside-root');

   fs.rmSync(root, { recursive: true, force: true });
   fs.rmSync(away, { recursive: true, force: true });
});

test('guardRoot resolves a root reached through a symlinked ancestor', () => {
   const root = repo();
   const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-link-')));
   const link = path.join(parent, 'repo');
   fs.symlinkSync(root, link);
   assert.equal(guardRoot(link), root, 'both sides of the rule come through one resolver');
   assert.equal(writeFileGuarded(guardRoot(link), path.join(link, 'x.md'), null, 'x').ok, true);
   assert.equal(fs.readFileSync(path.join(root, 'x.md'), 'utf8'), 'x');
   fs.rmSync(root, { recursive: true, force: true });
   fs.rmSync(parent, { recursive: true, force: true });
});
