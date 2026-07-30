import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseIndexFile } from '../dist/lib/indexfile.js';

// Direct unit coverage for the `leji-index` block parser. The shared fixtures
// exercise it end-to-end; these tests pin the small-format edge cases (multiple
// blocks, comments, trailing-comment stripping, directory-vs-file entries, and
// the rejection paths) that the Go and Python ports must replicate identically.

test('parser: multiple blocks in one file concatenate in document order', () => {
   const text = [
      '# System context',
      '',
      'Prose before the first block is ignored.',
      '',
      '```leji-index',
      '- path: docs/a.md',
      '- path: docs/b.md',
      '```',
      '',
      '## More, with its own block',
      '',
      '```leji-index',
      '- path: docs/c.md',
      '```',
      '',
   ].join('\n');
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(errors, []);
   assert.deepEqual(
      entries.map((e) => e.path),
      ['docs/a.md', 'docs/b.md', 'docs/c.md'],
   );
});

test('parser: blank lines and full-line # comments inside a block are ignored', () => {
   const text = [
      '```leji-index',
      '# a heading comment for humans',
      '',
      '- path: docs/a.md',
      '   # an indented comment',
      '- path: docs/sub/',
      '```',
   ].join('\n');
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(errors, []);
   assert.deepEqual(
      entries.map((e) => e.path),
      ['docs/a.md', 'docs/sub/'],
   );
});

test('parser: a trailing whitespace-preceded comment is stripped, but a # inside the path is kept', () => {
   const text = [
      '```leji-index',
      '- path: docs/a.md      # selected from a mixed directory',
      '- path: docs/C#-notes.md',
      '```',
   ].join('\n');
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(errors, []);
   assert.deepEqual(
      entries.map((e) => e.path),
      ['docs/a.md', 'docs/C#-notes.md'],
   );
});

test('parser: directory and single-file entries are both captured', () => {
   const text = ['```leji-index', '- path: docs/decisions/', '- path: docs/invariants.md', '```'].join('\n');
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(errors, []);
   assert.deepEqual(
      entries.map((e) => e.path),
      ['docs/decisions/', 'docs/invariants.md'],
   );
});

test('parser: a duplicate path is reported and not added twice', () => {
   const text = ['```leji-index', '- path: docs/a.md', '- path: docs/a.md', '```'].join('\n');
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(
      entries.map((e) => e.path),
      ['docs/a.md'],
   );
   assert.equal(errors.length, 1);
   assert.match(errors[0], /duplicate path "docs\/a\.md"/);
});

test('parser: an unparseable entry line is reported', () => {
   const text = ['```leji-index', '- docs/a.md', '```'].join('\n');
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(entries, []);
   assert.equal(errors.length, 1);
   assert.match(errors[0], /unparseable entry/);
});

test('parser: escaping paths are rejected (absolute, parent-escape, backslash)', () => {
   const text = [
      '```leji-index',
      '- path: /etc/passwd',
      '- path: ../escape.md',
      '- path: docs\\windows.md',
      '```',
   ].join('\n');
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(entries, []);
   assert.equal(errors.length, 3);
   for (const e of errors) assert.match(e, /invalid path/);
});

test('parser: an unterminated block (no closing fence) is reported', () => {
   const text = ['```leji-index', '- path: docs/a.md'].join('\n');
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(
      entries.map((e) => e.path),
      ['docs/a.md'],
   );
   assert.ok(errors.some((e) => /unterminated leji-index block/.test(e)));
});

test('parser: a file with no leji-index block is reported', () => {
   const text = '# Just prose\n\nNo block here.\n';
   const { entries, errors } = parseIndexFile(text);
   assert.deepEqual(entries, []);
   assert.ok(errors.some((e) => /no leji-index block found/.test(e)));
});

test('parser: a leading UTF-8 BOM does not decide whether the opening fence exists', () => {
   // Reproduced divergence: the BOM survived into the first line, and each runtime's
   // own trim disagreed about whether it was whitespace, so the same file parsed in
   // Node and failed with `index-file-parse` in Go and Python.
   const parsed = parseIndexFile('\ufeff```leji-index\n- path: docs/a.md\n```\n');
   assert.deepEqual(parsed.errors, []);
   assert.deepEqual(parsed.entries, [{ path: 'docs/a.md', kind: 'intent' }]);
});

test('parser: whitespace in the grammar is ASCII space and tab, and nothing else', () => {
   // Reproduced divergence: an NBSP before a trailing `#` opened a comment under
   // JavaScript's and Python's `\s` but not Go's, so one entry named two different
   // paths depending on which SDK read it. Under the ASCII alphabet all three keep
   // the `#` in the path, and the layer reports it missing rather than inventing one.
   const nbsp = parseIndexFile('```leji-index\n- path: docs/a.md\u00a0# note\n```\n');
   assert.deepEqual(nbsp.errors, []);
   assert.deepEqual(nbsp.entries, [{ path: 'docs/a.md\u00a0# note', kind: 'intent' }]);
   // A space-preceded `#` is still a comment, and padding is still stripped.
   const ascii = parseIndexFile('```leji-index\n   - path: docs/a.md \t# note\t \n```\n');
   assert.deepEqual(ascii.entries, [{ path: 'docs/a.md', kind: 'intent' }]);
   // Non-ASCII padding around an entry is not padding: the line does not parse.
   const padded = parseIndexFile('```leji-index\n\u00a0- path: docs/a.md\n```\n');
   assert.equal(padded.entries.length, 0);
   assert.equal(padded.errors.length, 1);
   assert.match(padded.errors[0], /^line 2: unparseable entry /);
   // A fence line padded with U+00A0 is not a fence line either, in any SDK.
   assert.deepEqual(parseIndexFile('\u00a0```leji-index\n- path: docs/a.md\n```\n').errors, [
      'no leji-index block found in this index file',
   ]);
});

test('parser: a fence carrying junk after the tag is a reportable block, not a silent skip', () => {
   // The `leji-mounts` behavior, now shared: the fence opens and the grammar
   // rejects what follows, instead of the whole block vanishing from the scan.
   const parsed = parseIndexFile('```leji-index record extra\n- path: docs/a.md\n```\n');
   assert.deepEqual(parsed.errors, [
      'line 1: unknown leji-index block kind "record extra" (expected intent or record)',
   ]);
   assert.deepEqual(parsed.entries, [{ path: 'docs/a.md', kind: 'intent' }]);
});
