import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseFrontmatter } from '../dist/lib/frontmatter.js';

test('document without frontmatter passes through', () => {
   const fm = parseFrontmatter('# Title\n\nBody.\n');
   assert.equal(fm.data, null);
   assert.equal(fm.error, undefined);
});

test('unterminated frontmatter block is an error', () => {
   const fm = parseFrontmatter('---\nid: x\n# never closed\n');
   assert.match(fm.error ?? '', /unterminated/);
});

test('non-mapping frontmatter is an error', () => {
   const fm = parseFrontmatter('---\n- just\n- a list\n---\n\nBody.\n');
   assert.equal(fm.data, null);
   assert.match(fm.error ?? '', /not a YAML mapping/);
});

test('invalid YAML is an error, body still recovered', () => {
   const fm = parseFrontmatter('---\nid: [unclosed\n---\n\nBody.\n');
   assert.equal(fm.data, null);
   assert.match(fm.error ?? '', /invalid YAML/);
   assert.match(fm.body, /Body/);
});

test('YAML 1.2 semantics: unquoted dates and no/yes stay strings', () => {
   const fm = parseFrontmatter('---\ndate: 2026-06-12\nflag: no\nok: true\n---\n\nbody\n');
   assert.equal(fm.data!.date, '2026-06-12');
   assert.equal(fm.data!.flag, 'no');
   assert.equal(fm.data!.ok, true);
});
