import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { linkFindings, linkUnresolvedMessage, resolveLinkTarget, scanLinks } from '../dist/lib/links.js';

// The fixture runner compares findings on (rule, severity, path) alone, so the two
// halves of this rule it cannot see are pinned here, over the very same committed
// bytes: which destination the grammar reads out of each spelling, the line it
// reports, and the path that destination resolves to.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = (name: string): string => path.join(repoRoot, 'fixtures', name);

/** Every link in a governed document as the `(target as written, resolved path,
 * line)` triple, the resolved path repository-root-relative POSIX and null for a
 * destination this rule never judges. */
function triples(root: string, relPath: string): [string, string | null, number][] {
   const rootAbs = path.resolve(root);
   const layerRootAbs = path.resolve(rootAbs, 'docs');
   const text = fs.readFileSync(path.join(rootAbs, relPath), 'utf8');
   return scanLinks(text).map((link) => {
      const abs = resolveLinkTarget(rootAbs, layerRootAbs, relPath, link.target);
      const resolved = abs === null ? null : path.relative(rootAbs, abs).split(path.sep).join('/');
      return [link.target, resolved, link.line];
   });
}

test('valid-links: every spelling, its resolved path, and its line', () => {
   assert.deepEqual(triples(fixture('valid-links'), 'docs/domain/overview.md'), [
      ['dir/README.md', 'docs/domain/dir/README.md', 5],
      ['../boot-profile.md', 'docs/boot-profile.md', 6],
      ['/decisions/0001-adopt-leji.md', 'docs/decisions/0001-adopt-leji.md', 7],
      // A directory resolves to the directory; the README inside it is what makes
      // the target answerable, and the existence rule reads it.
      ['dir/', 'docs/domain/dir', 8],
      // Never judged: a bare fragment, and anything carrying a URI scheme.
      ['#overview', null, 9],
      ['https://leji.org/spec/', null, 10],
      ['mailto:owner@example.invalid', null, 11],
      ['dir/with%20space.md', 'docs/domain/dir/with space.md', 12],
      // The three spellings of a path a bare run cannot carry plainly: balanced
      // parentheses, the angle-bracketed form, and the backslash-escaped form the
      // viewer emits for a generated link. All three resolve to the same file.
      ['dir/(x).md', 'docs/domain/dir/(x).md', 13],
      ['dir/with space.md', 'docs/domain/dir/with space.md', 14],
      ['dir/\\(x\\).md', 'docs/domain/dir/(x).md', 15],
      ['diagram.svg', 'docs/domain/diagram.svg', 16],
      // The reference definition on the last line, its title read only far enough to
      // establish that the line is a definition, then discarded.
      ['crlf.md', 'docs/domain/crlf.md', 27],
   ]);
});

test('valid-links: a code span and a fenced block are code, CRLF terminators included', () => {
   const crlf = fs.readFileSync(path.join(fixture('valid-links'), 'docs/domain/crlf.md'), 'utf8');
   assert.ok(crlf.includes('\r\n'), 'the fixture is stored with CRLF line endings');
   assert.deepEqual(triples(fixture('valid-links'), 'docs/domain/crlf.md'), [
      ['overview.md', 'docs/domain/overview.md', 6],
   ]);
});

test('invalid-link-split-line: `](` split across a line break is not a link', () => {
   assert.deepEqual(triples(fixture('invalid-link-split-line'), 'docs/domain/overview.md'), [
      ['missing-split.md', 'docs/domain/missing-split.md', 10],
   ]);
});

test('invalid-link-escapes-root: `..` and a symlink out of the layer are both unresolved', () => {
   const root = fixture('invalid-link-escapes-root');
   const rootAbs = path.resolve(root);
   const layerRootAbs = path.join(rootAbs, 'docs');

   // The symlink resolves to a file that exists — outside the layer — so existence
   // alone would pass it. Containment is what refuses it.
   const symlink = path.join(rootAbs, 'docs/domain/outside-link.md');
   assert.ok(fs.lstatSync(symlink).isSymbolicLink(), 'the fixture plants a symlink');
   assert.ok(fs.existsSync(symlink), 'whose target exists');

   for (const [relPath, target, line] of [
      ['docs/boot-profile.md', '../../outside.md', 9],
      ['docs/domain/overview.md', 'outside-link.md', 4],
   ] as const) {
      const text = fs.readFileSync(path.join(rootAbs, relPath), 'utf8');
      assert.deepEqual(
         scanLinks(text).map((l) => [l.target, l.line]),
         [[target, line]],
         `${relPath} carries one link`,
      );
      const findings = linkFindings(rootAbs, layerRootAbs, relPath, text);
      assert.equal(findings.length, 1, `${relPath} reports one finding`);
      assert.deepEqual(
         { rule: findings[0].rule, severity: findings[0].severity, path: findings[0].path },
         { rule: 'link-unresolved', severity: 'error', path: relPath },
      );
      assert.equal(findings[0].line, line, 'the finding carries the link line');
      assert.equal(findings[0].construct, target, 'and the destination as written');
   }
});

test('invalid-link-readme-escapes-root: a directory whose README leaves the layer does not resolve', () => {
   const root = fixture('invalid-link-readme-escapes-root');
   const rootAbs = path.resolve(root);
   const layerRootAbs = path.join(rootAbs, 'docs');
   const relPath = 'docs/domain/overview.md';

   // The directory is inside the layer and its README exists, so the directory's own
   // containment check and a bare existence test both pass it. Only containment of
   // the README ITSELF refuses this target.
   const readme = path.join(rootAbs, 'docs', 'domain', 'section', 'README.md');
   assert.ok(fs.lstatSync(readme).isSymbolicLink(), 'the fixture plants the README as a symlink');
   assert.ok(fs.existsSync(readme), 'whose target exists');

   assert.deepEqual(triples(root, relPath), [['section/', 'docs/domain/section', 4]]);

   const findings = linkFindings(rootAbs, layerRootAbs, relPath, fs.readFileSync(path.join(rootAbs, relPath), 'utf8'));
   assert.equal(findings.length, 1, 'one finding');
   assert.deepEqual(
      { rule: findings[0].rule, severity: findings[0].severity, path: findings[0].path },
      { rule: 'link-unresolved', severity: 'error', path: relPath },
   );
   assert.equal(findings[0].line, 4);
   assert.equal(findings[0].construct, 'section/');
});

// The message carries the destination as written, byte for byte, in all three SDKs:
// a runtime that quotes it (Go's %q) would escape exactly these three and print a
// different line than the other two for the same layer.
test('the message interpolates the destination verbatim, whatever it carries', () => {
   assert.equal(linkUnresolvedMessage('missing\\name.md'), 'link target "missing\\name.md" does not resolve');
   assert.equal(linkUnresolvedMessage('a"b.md'), 'link target "a"b.md" does not resolve');
   assert.equal(linkUnresolvedMessage('a\tb.md'), 'link target "a\tb.md" does not resolve');
});
