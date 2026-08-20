import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { DOCS_CANDIDATES, KNOWN_VENDOR_FILES, classifyTarget, withinRoot } from '../dist/internal/create.js';

// One sandbox for the file. `realpathSync` on the temp root because macOS hands out
// /var, which is a symlink to /private/var: the classifier compares real paths, and a
// fixture built on the unresolved spelling would test the resolver, not the rule.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-classify-')));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** Somewhere outside every target, to point escaping links at. */
const outside = path.join(sandbox, 'outside');
fs.mkdirSync(path.join(outside, 'docs'), { recursive: true });
fs.mkdirSync(path.join(outside, '.github'), { recursive: true });
fs.writeFileSync(path.join(outside, '.github', 'copilot-instructions.md'), '# elsewhere\n');
fs.writeFileSync(path.join(outside, 'leji.json'), '{}\n');

let seq = 0;
/** A fresh target directory; a trailing `/` in `files` means a directory. */
function target(files: string[] = []): string {
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

test('classifyTarget names each state of a plain directory', () => {
   assert.equal(classifyTarget(path.join(sandbox, 'nothing-here')), 'missing');
   assert.equal(classifyTarget(target()), 'init');
   assert.equal(classifyTarget(target(['docs/'])), 'adopt');
   assert.equal(classifyTarget(target(['Docs/'])), 'adopt');
   assert.equal(classifyTarget(target(['leji.json'])), 'adopted');
   assert.equal(classifyTarget(target(['docs/', 'leji.json'])), 'adopted');
});

test('every docs candidate and vendor entrypoint the SDK declares is recognized', () => {
   for (const rel of DOCS_CANDIDATES) assert.equal(classifyTarget(target([rel])), 'adopt', rel);
   for (const rel of KNOWN_VENDOR_FILES) assert.equal(classifyTarget(target([rel])), 'adopt', rel);
});

test('a target that cannot be listed is unreadable, never guessed at', () => {
   const file = path.join(target(['README.md']), 'README.md');
   assert.equal(classifyTarget(file), 'unreadable', 'a file where a directory was named');

   const dangling = path.join(sandbox, `dangling-${seq++}`);
   fs.symlinkSync(path.join(sandbox, 'no-such-target'), dangling);
   assert.equal(classifyTarget(dangling), 'unreadable', 'a dangling symlink is not a missing directory');
});

test('a symlinked target is classified through its real path', () => {
   const real = target(['docs/']);
   const link = path.join(sandbox, `target-link-${seq++}`);
   fs.symlinkSync(real, link);
   assert.equal(classifyTarget(link), 'adopt');
});

test('only the selected target is inspected, never its parent', () => {
   const monorepo = target(['docs/', 'packages/app/']);
   assert.equal(classifyTarget(path.join(monorepo, 'packages', 'app')), 'init');
});

// --- nothing outside the target decides the answer ---------------------------

test('a docs root symlinked out of the target is not an adopt trigger', () => {
   const dir = target();
   fs.symlinkSync(path.join(outside, 'docs'), path.join(dir, 'docs'));
   assert.equal(classifyTarget(dir), 'init');
});

test('a leji.json symlinked out of the target does not make it adopted', () => {
   const dir = target();
   fs.symlinkSync(path.join(outside, 'leji.json'), path.join(dir, 'leji.json'));
   assert.equal(classifyTarget(dir), 'init');
});

test('a vendor entrypoint reached through an escaping parent is not counted', () => {
   const dir = target();
   fs.symlinkSync(path.join(outside, '.github'), path.join(dir, '.github'));
   assert.equal(classifyTarget(dir), 'init', 'the entry itself is not a link; its parent is');
});

test('a dangling entry inside the target counts as absent', () => {
   const dir = target();
   fs.symlinkSync(path.join(dir, 'no-such-file'), path.join(dir, 'CLAUDE.md'));
   assert.equal(classifyTarget(dir), 'init');
});

test('symlinks that stay inside the target still count', () => {
   const docsDir = target(['real-docs/']);
   fs.symlinkSync(path.join(docsDir, 'real-docs'), path.join(docsDir, 'docs'));
   assert.equal(classifyTarget(docsDir), 'adopt', 'an in-target docs link is a docs root');

   const manifestDir = target(['real.json']);
   fs.symlinkSync(path.join(manifestDir, 'real.json'), path.join(manifestDir, 'leji.json'));
   assert.equal(classifyTarget(manifestDir), 'adopted', 'an in-target manifest link is the manifest');

   const vendorDir = target(['real.md']);
   fs.symlinkSync(path.join(vendorDir, 'real.md'), path.join(vendorDir, 'CLAUDE.md'));
   assert.equal(classifyTarget(vendorDir), 'adopt', 'an in-target entrypoint link is an entrypoint');
});

test('classifying writes nothing', () => {
   const dir = target(['docs/', 'CLAUDE.md']);
   const before = fs.readdirSync(dir).sort();
   assert.equal(classifyTarget(dir), 'adopt');
   assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

// --- the containment rule itself --------------------------------------------

test('withinRoot accepts the target and its descendants, and nothing else', () => {
   const root = path.join(sandbox, 'repo');
   assert.equal(withinRoot(root, root), true, 'the target is inside itself');
   assert.equal(withinRoot(root, path.join(root, 'docs')), true, 'a child');
   assert.equal(withinRoot(root, path.join(root, 'a', 'b', 'c.md')), true, 'a descendant');
   assert.equal(withinRoot(root, path.dirname(root)), false, 'the parent');
   assert.equal(withinRoot(root, path.join(sandbox, 'other')), false, 'a sibling');
   // The separator is what makes this a path comparison rather than a string one.
   assert.equal(withinRoot(root, `${root}sitory`), false, 'a sibling sharing the prefix');
});

test('withinRoot accepts children of a filesystem-root target', () => {
   // The one target whose real path ends in a separator, so appending another would ask
   // whether `/foo` starts with `//`. Asserted on the helper: classifying the real root
   // would read the machine's filesystem, which is no business of a unit test.
   const fsRoot = path.parse(sandbox).root;
   assert.equal(path.parse(fsRoot).root, fsRoot, 'a root is its own root, which is what the branch keys on');
   assert.equal(withinRoot(fsRoot, fsRoot), true, 'the root itself');
   assert.equal(withinRoot(fsRoot, path.join(fsRoot, 'anything')), true, 'a child of the root');
   assert.equal(withinRoot(fsRoot, sandbox), true, 'the sandbox is under the root');
});

test('withinRoot accepts children of a Windows drive root', { skip: path.sep !== '\\' }, () => {
   assert.equal(withinRoot('C:\\', 'C:\\'), true);
   assert.equal(withinRoot('C:\\', 'C:\\repo'), true);
});

test('a target given with a trailing separator classifies the same directory', () => {
   const dir = target(['docs/']);
   assert.equal(classifyTarget(dir + path.sep), 'adopt');
   assert.equal(classifyTarget(target(['leji.json']) + path.sep), 'adopted');
});

test('a target given relative to the working directory is resolved first', () => {
   const dir = target(['CLAUDE.md']);
   const cwd = process.cwd();
   try {
      process.chdir(sandbox);
      assert.equal(classifyTarget(path.basename(dir)), 'adopt');
      assert.equal(classifyTarget(path.join('.', path.basename(dir))), 'adopt');
      assert.equal(classifyTarget('.'), 'init', 'the sandbox itself has nothing to adopt');
   } finally {
      process.chdir(cwd);
   }
});
