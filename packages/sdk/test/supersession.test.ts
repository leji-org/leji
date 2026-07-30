import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateLayer } from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const minimal = path.join(repoRoot, 'fixtures', 'valid-minimal-core');

/** A copy of the minimal core fixture whose decision records are replaced by the
 * given (filename -> frontmatter-fields) map. Returns the layer root. */
function layerWithDecisions(records: Record<string, string>): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-sup-'));
   fs.cpSync(minimal, dir, { recursive: true });
   const decisions = path.join(dir, 'docs', 'decisions');
   for (const f of fs.readdirSync(decisions)) fs.rmSync(path.join(decisions, f));
   for (const [name, fields] of Object.entries(records)) {
      const id = name.replace(/\.md$/, '');
      fs.writeFileSync(
         path.join(decisions, name),
         `---\nid: ${id}\ntitle: ${id}\ndate: 2026-06-01\n${fields}---\n\n# ${id}\n\n## Context\nc\n\n## Decision\nd\n\n## Consequences\ne\n`,
      );
   }
   return dir;
}

function supersessionFindings(dir: string): { path?: string; message: string }[] {
   return validateLayer(dir)
      .findings.filter((f) => f.rule === 'decision-supersession')
      .map((f) => ({ path: f.path, message: f.message }));
}

test('supersession: forward one-directional (B supersedes A, A left accepted) flags A twice', () => {
   const dir = layerWithDecisions({
      'a.md': 'status: accepted\n',
      'b.md': 'status: accepted\nsupersedes: a\n',
   });
   const f = supersessionFindings(dir);
   // A must be superseded, and A's supersededBy must point back: both fire at a.md.
   assert.equal(f.length, 2);
   assert.ok(f.every((x) => x.path === 'docs/decisions/a.md'));
});

test('supersession: dangling supersedes target', () => {
   const dir = layerWithDecisions({
      'b.md': 'status: accepted\nsupersedes: ghost\n',
   });
   const f = supersessionFindings(dir);
   assert.equal(f.length, 1);
   assert.match(f[0].message, /supersedes "ghost" but no decision record has that id/);
   assert.equal(f[0].path, 'docs/decisions/b.md');
});

test('supersession: dangling supersededBy target on a superseded record', () => {
   const dir = layerWithDecisions({
      'a.md': 'status: superseded\nsupersededBy: ghost\n',
      'keep.md': 'status: accepted\n',
   });
   const f = supersessionFindings(dir);
   assert.equal(f.length, 1);
   assert.match(f[0].message, /supersededBy "ghost" but no decision record has that id/);
});

test('supersession: supersededBy on a non-superseded record is rejected', () => {
   const dir = layerWithDecisions({
      'a.md': 'status: accepted\nsupersededBy: b\n',
      'b.md': 'status: accepted\nsupersedes: a\n',
   });
   const f = supersessionFindings(dir);
   // a.md is accepted but carries supersededBy -> rejected; b.supersedes=a then
   // expects a to be superseded -> a flagged again. Both at a.md.
   assert.ok(f.length >= 1);
   assert.ok(f.some((x) => /supersededBy is set but status is "accepted"/.test(x.message)));
});

test('supersession: a consistent pair is clean', () => {
   const dir = layerWithDecisions({
      'a.md': 'status: superseded\nsupersededBy: b\n',
      'b.md': 'status: accepted\nsupersedes: a\n',
   });
   assert.deepEqual(supersessionFindings(dir), []);
});
