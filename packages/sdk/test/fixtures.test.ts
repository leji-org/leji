import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkIndex, conformanceReport, loadManifest, validateLayer } from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');

interface ExpectedFinding {
   rule: string;
   severity: string;
   path: string;
   message?: string;
}

const triple = (f: { rule: string; severity: string; path?: string }) => `${f.path ?? ''}|${f.rule}|${f.severity}`;

// When an expected finding pins a `message`, also compare the message text;
// otherwise the path|rule|severity triple is the contract.
const key = (f: { rule: string; severity: string; path?: string; message?: string }, withMessage: boolean) =>
   withMessage ? `${triple(f)}|${f.message ?? ''}` : triple(f);

for (const name of fs.readdirSync(fixturesDir).sort()) {
   const dir = path.join(fixturesDir, name);
   const expectedFile = path.join(dir, 'expected.json');
   if (!fs.existsSync(expectedFile)) continue;
   const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));

   test(`fixture ${name}: validate`, () => {
      const result = validateLayer(dir);
      const wantFindings = expected.validate.findings as ExpectedFinding[];
      const got = result.findings.map(triple).sort();
      const want = wantFindings.map(triple).sort();
      assert.deepEqual(got, want, `findings mismatch for ${name}`);
      // When an expected finding pins a `message`, assert a matching actual
      // finding carries that exact message too (path|rule|severity + message).
      for (const wf of wantFindings) {
         if (wf.message === undefined) continue;
         const match = result.findings.some((af) => key(af, true) === key(wf, true));
         assert.ok(match, `message mismatch for ${name}: ${key(wf, true)}`);
      }
      const exit = result.findings.some((f) => f.severity === 'error') ? 1 : 0;
      assert.equal(exit, expected.validate.exit, `exit code mismatch for ${name}`);
   });

   if (expected.conformance) {
      test(`fixture ${name}: conformance`, () => {
         const result = conformanceReport(dir);
         assert.equal(result.claimedLevel ?? 'none', expected.conformance.claimedLevel);
         assert.equal(result.verifiedLevel ?? 'none', expected.conformance.verifiedLevel);
         const exit = result.findings.some((f) => f.severity === 'error') ? 1 : 0;
         assert.equal(exit, expected.conformance.exit);
      });
   }

   if (expected.indexCheck) {
      test(`fixture ${name}: index --check`, () => {
         const { manifest } = loadManifest(dir);
         assert.ok(manifest, 'manifest must load for indexCheck fixtures');
         const result = checkIndex(dir, manifest!);
         assert.equal(result.stale ?? true, expected.indexCheck.stale);
         const exit = result.findings.some((f) => f.severity === 'error') ? 1 : 0;
         assert.equal(exit, expected.indexCheck.exit);
      });
   }
}
