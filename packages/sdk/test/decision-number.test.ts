import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { checkDecisionNumbers, decisionNumberKey } from '../dist/commands/validate.js';
import type { Finding } from '../dist/lib/findings.js';
import type { ScannedProfile } from '../dist/lib/layer.js';

/** A decision record reduced to what the number rule reads. */
function record(relPath: string): ScannedProfile {
   return { relPath, frontmatter: null, body: '', findings: [] };
}

// A file name may legally carry a CR, and the three SDKs must agree on whether it
// carries a decision number: ECMAScript's `.` rejects CR (and U+2028/U+2029) where
// Python's and Go's accept it, so the pattern spells the class out instead.
test('decisionNumberKey accepts a carriage return in the slug and rejects a newline', () => {
   assert.equal(decisionNumberKey('docs/decisions/2-a\rb.md'), '2');
   assert.equal(decisionNumberKey('docs/decisions/2-a\nb.md'), null);
});

// U+E000 sorts before U+10000 by UTF-8 bytes and after it by UTF-16 code units. Byte
// order is the contract and all three SDKs' scans return it; the rule sorts on its own
// contract rather than trusting its input, so it names the same first record even when
// handed the other order, which is what this passes it.
test('checkDecisionNumbers names the first record in byte order, whatever order it is handed', () => {
   const pua = 'docs/decisions/2-\u{E000}.md';
   const astral = 'docs/decisions/2-\u{10000}.md';
   assert.deepEqual([pua, astral].sort(), [astral, pua], "JavaScript's own sort puts the astral path first");

   const findings: Finding[] = [];
   checkDecisionNumbers([astral, pua].map(record), findings);

   assert.equal(findings.length, 1);
   assert.equal(findings[0].rule, 'decision-number-duplicate');
   assert.equal(findings[0].severity, 'error');
   assert.equal(findings[0].path, astral);
   assert.equal(findings[0].message, `decision number "2" already used by ${pua}`);
});
