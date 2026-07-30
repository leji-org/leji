import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ScannedProfile } from '../dist/index.js';
import { parseFrontmatter } from '../dist/lib/frontmatter.js';
import { resolveAgentProfile } from '../dist/lib/layer.js';
import { schemaErrors } from '../dist/lib/schemas.js';

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

// --- CRLF line endings ---
// A Windows contributor or core.autocrlf=true authors every line with \r\n. The
// block's last line must keep its whole terminator: a bare \r left behind folds
// into the last scalar's value, which the Go and Python SDKs never did.

/** Join lines with CRLF terminators, the way a Windows editor writes a file. */
const crlf = (...lines: string[]): string => lines.map((line) => `${line}\r\n`).join('');

/** The scan result a profile's bytes produce, as scanFrontmatterArtifact builds it. */
function scanned(relPath: string, text: string): ScannedProfile {
   const fm = parseFrontmatter(text);
   return { relPath, frontmatter: fm.data, body: fm.body, findings: [] };
}

test('CRLF: the last frontmatter field keeps no trailing carriage return', () => {
   const fm = parseFrontmatter(crlf('---', 'id: reviewer', 'role: reviewer', '---', '', 'Body.'));
   assert.equal(fm.error, undefined);
   assert.equal(fm.data!.role, 'reviewer');
   assert.equal(fm.body, '\r\nBody.\r\n');
});

test('CRLF: a profile whose last key is `inherits` passes schema and resolves', () => {
   const base = scanned(
      'docs/agents/core.md',
      crlf(
         '---',
         'id: core',
         'name: Core',
         'role: core',
         'requiredRead:',
         '  - docs/boot-profile.md',
         'mustAskWhen:',
         '  - always',
         '---',
         '',
         '# Core',
      ),
   );
   const derived = scanned(
      'docs/agents/reviewer.md',
      crlf('---', 'id: reviewer', 'name: Reviewer', 'role: reviewer', 'inherits: core', '---', '', '# Reviewer'),
   );
   assert.deepEqual(schemaErrors('agent-profile', derived.frontmatter), []);
   const resolved = resolveAgentProfile(derived, [base, derived]);
   assert.deepEqual(resolved.findings, []);
   assert.deepEqual(resolved.sourceIds, ['core', 'reviewer']);
});

test('CRLF: a blank line before the closing fence still parses', () => {
   const fm = parseFrontmatter(crlf('---', 'id: reviewer', 'role: reviewer', '', '---', '', 'Body.'));
   assert.equal(fm.error, undefined);
   assert.equal(fm.data!.role, 'reviewer');
});

test('CRLF: a decision record reports its schema defect, not a YAML error', () => {
   const fm = parseFrontmatter(
      crlf('---', 'id: crlf-record', 'title: CRLF record', 'date: 2026-07-28', 'status: maybe', '', '---', '', 'Body.'),
   );
   assert.equal(fm.error, undefined);
   const errors = schemaErrors('decision-record', fm.data);
   assert.equal(errors.length, 1);
   assert.match(errors[0], /^\/status /);
});

test('LF documents parse identically, with LF terminators preserved', () => {
   const fm = parseFrontmatter('---\nid: reviewer\nrole: reviewer\n---\n\nBody.\n');
   assert.equal(fm.error, undefined);
   assert.equal(fm.data!.role, 'reviewer');
   assert.equal(fm.body, '\nBody.\n');
});
