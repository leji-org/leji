import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { conformanceReport, loadManifest, validateLayer } from '../dist/index.js';
import { mountSurfacingFindings } from '../dist/commands/validate.js';
import { parseMountBlocks } from '../dist/lib/mountblock.js';

// The `leji-mounts` block: the machine-checkable half of boot-profile.md req 9.
// Grammar cases run against the parser directly; the cross-check against the
// manifest (enumeration, identity, presence) runs against the federated host
// example, which ships a conforming block. The Go and Python ports must
// replicate both, including the finding order these tests pin.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const hostExample = path.join(repoRoot, 'examples', 'multi-repo', 'core-context');
const BLOCK = /```leji-mounts\n(?:[\s\S]*?\n)?```\n/;

function block(...lines: string[]): string {
   return ['```leji-mounts', ...lines, '```'].join('\n');
}

/** A copy of the federated host example (one declared mount, one entry for it). */
function hostLayer(): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-mountblock-'));
   fs.cpSync(hostExample, dir, { recursive: true });
   return dir;
}

/** Replace the example's shipped block with `replacement` (empty string removes it). */
function setBlock(dir: string, replacement: string): void {
   const p = path.join(dir, 'docs', 'boot-profile.md');
   const text = fs.readFileSync(p, 'utf8');
   assert.ok(BLOCK.test(text), 'the shipped example carries a leji-mounts block');
   fs.writeFileSync(p, text.replace(BLOCK, replacement === '' ? '' : `${replacement}\n`));
}

function setMounts(dir: string, mounts: unknown[] | null): void {
   const p = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(p, 'utf8'));
   if (mounts === null) delete m.federation;
   else m.federation = { mounts };
   fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
}

/** Surfacing findings in the check's own order (validateLayer sorts them). */
function surfacing(dir: string): { rule: string; message: string }[] {
   const { manifest } = loadManifest(dir);
   return mountSurfacingFindings(dir, manifest!).map((f) => ({ rule: f.rule, message: f.message }));
}

const DECLARED = {
   name: 'acme-product-context',
   source: 'https://github.com/acme/product-context',
   pin: '7d3f2a19c4e8b6a0d5f1c2e9b8a7f6d5c4b3a2e1',
   owner: { name: 'Product team' },
   categories: ['domain'],
   topics: ['billing'],
};

// --- grammar ---

test('mount block: one record parses, fields in any order, with punctuation and non-ASCII values', () => {
   const text = [
      '# Boot Profile',
      '',
      block(
         '- mount: acme-product-context',
         '  read-when: a task touches billing, pricing (including trials), or the `checkout` surface',
         '  carries: produktbeschreibung, Preise und Entscheidungen: 決済まわり',
         '  owner: Ada Okafor',
      ),
      '',
   ].join('\n');
   const parsed = parseMountBlocks(text);
   assert.deepEqual(parsed.errors, []);
   assert.equal(parsed.sawBlock, true);
   assert.equal(parsed.entries.length, 1);
   assert.equal(parsed.entries[0].mount, 'acme-product-context');
   assert.equal(parsed.entries[0].owner, 'Ada Okafor');
   assert.equal(parsed.entries[0].carries, 'produktbeschreibung, Preise und Entscheidungen: 決済まわり');
   assert.match(parsed.entries[0].readWhen, /`checkout` surface$/);
});

test('mount block: several records across two blocks concatenate in document order', () => {
   const entry = (name: string) => [
      `- mount: ${name}`,
      `  owner: ${name} team`,
      '  carries: its own slice',
      '  read-when: a task touches it',
   ];
   const text = [
      block(...entry('alpha'), ...entry('beta')),
      '',
      'Prose between the blocks, which the scan walks past.',
      '',
      block(...entry('gamma')),
   ].join('\n');
   const parsed = parseMountBlocks(text);
   assert.deepEqual(parsed.errors, []);
   assert.deepEqual(
      parsed.entries.map((e) => e.mount),
      ['alpha', 'beta', 'gamma'],
   );
});

test('mount block: blank lines and full-line # comments are ignored; a # inside a value is kept', () => {
   const text = block(
      '# the siblings this layer reads',
      '',
      '- mount: alpha',
      '  owner: Alpha team',
      '  carries: the # channel conventions',
      '  read-when: a task touches them',
      '',
   );
   const parsed = parseMountBlocks(text);
   assert.deepEqual(parsed.errors, []);
   assert.equal(parsed.entries[0].carries, 'the # channel conventions');
});

test('mount block: misindented, unknown, duplicated, and missing fields are all reported', () => {
   const text = block(
      '- mount: alpha',
      '   owner: Alpha team',
      '  role: extra',
      '  carries: a slice',
      '  carries: a second slice',
      '  read-when: a task touches it',
   );
   const parsed = parseMountBlocks(text);
   assert.deepEqual(parsed.entries, []);
   // Source-line order, not detection order: the missing-field error belongs to the
   // record's own line even though it is raised when the record closes.
   assert.deepEqual(
      parsed.errors.map((e) => e.message),
      [
         'mount "alpha" is missing the "owner" field',
         'a field line must be indented exactly two spaces, as "  <key>: <value>"',
         'mount "alpha" carries the unknown field "role"',
         'mount "alpha" declares the "carries" field twice',
      ],
   );
   assert.deepEqual(
      parsed.errors.map((e) => e.line),
      [2, 3, 4, 6],
   );
});

test('mount block: an empty value, a padded value, and a CR inside a value are rejected', () => {
   const text = block(
      '- mount: alpha',
      '  owner: ',
      '  carries:  padded on the left',
      '  read-when: split\rby a carriage return',
   );
   const parsed = parseMountBlocks(text);
   assert.deepEqual(parsed.entries, []);
   assert.deepEqual(
      parsed.errors.map((e) => e.message),
      [
         'mount "alpha" is missing the "owner" field',
         'mount "alpha" is missing the "carries" field',
         'mount "alpha" is missing the "read-when" field',
         'mount "alpha" field "owner" is unusable: the value is empty',
         'mount "alpha" field "carries" is unusable: the value has leading or trailing whitespace',
         'mount "alpha" field "read-when" is unusable: the value carries a control or line-separator character',
      ],
   );
   assert.deepEqual(
      parsed.errors.map((e) => e.line),
      [2, 2, 2, 3, 4, 5],
   );
});

test('mount block: anything after leji-mounts is an error, and the block is still consumed', () => {
   const record = ['- mount: alpha', '  owner: Alpha team', '  carries: a slice', '  read-when: a task touches it'];
   const withInfo = (info: string) => parseMountBlocks(['```leji-mounts' + info, ...record, '```'].join('\n'));

   for (const [info, named] of [
      [' bogus', 'bogus'],
      // Several trailing tokens are one finding naming the whole remainder: a fence
      // the pattern half-recognized would leave the body to degrade into prose.
      [' bogus extra', 'bogus extra'],
      ['\tbogus\textra ', 'bogus\textra'],
   ] as const) {
      const parsed = withInfo(info);
      assert.equal(parsed.sawBlock, true, `${JSON.stringify(info)} opens a block`);
      assert.deepEqual(
         parsed.errors.map((e) => e.message),
         [`the leji-mounts info string carries nothing after the tag, but this fence declares "${named}"`],
      );
      assert.equal(parsed.errors[0].line, 1);
      // Consumed, never re-read as prose: the record inside still parses.
      assert.deepEqual(
         parsed.entries.map((e) => e.mount),
         ['alpha'],
      );
   }

   // The tag boundary holds: a longer tag is a different grammar, not this one.
   const other = parseMountBlocks(['```leji-mountsx', ...record, '```'].join('\n'));
   assert.equal(other.sawBlock, false);
   assert.deepEqual(other.entries, []);
   assert.deepEqual(other.errors, []);
});

test('mount block: fence whitespace is ASCII space and tab only', () => {
   const record = ['- mount: alpha', '  owner: Alpha team', '  carries: a slice', '  read-when: a task touches it'];
   // Tab-padded and indented fences are fences.
   const tabs = ['\t```leji-mounts\t', ...record, '  ```  '].join('\n');
   const parsedTabs = parseMountBlocks(tabs);
   assert.deepEqual(parsedTabs.errors, []);
   assert.deepEqual(
      parsedTabs.entries.map((e) => e.mount),
      ['alpha'],
   );
   // U+00A0 padding is not fence whitespace, so no block is seen at all. A runtime
   // whitespace class would have called this a block; the ports must not.
   const nbsp = ['\u00a0```leji-mounts', ...record, '```'].join('\n');
   const parsedNbsp = parseMountBlocks(nbsp);
   assert.equal(parsedNbsp.sawBlock, false);
   assert.deepEqual(parsedNbsp.entries, []);
});

test('mount block: an unterminated block is reported, and a record must start at column 1', () => {
   const unterminated = ['```leji-mounts', '- mount: alpha', '  owner: Alpha team'].join('\n');
   assert.ok(parseMountBlocks(unterminated).errors.some((e) => /unterminated leji-mounts block/.test(e.message)));
   const indented = block('  - mount: alpha');
   assert.deepEqual(
      parseMountBlocks(indented).errors.map((e) => e.message),
      ['a "- mount:" record must start at column 1, followed by one space'],
   );
});

// --- validate: the cross-check against the declaration ---

test('surfacing: the shipped federated example surfaces its mount cleanly', () => {
   assert.deepEqual(surfacing(hostExample), []);
});

test('surfacing: mounts declared with no block is one mount-surfacing-block finding', () => {
   const dir = hostLayer();
   setBlock(dir, '');
   const found = surfacing(dir);
   assert.equal(found.length, 1);
   assert.equal(found[0].rule, 'mount-surfacing-block');
   assert.match(found[0].message, /carries no leji-mounts block/);
});

test('surfacing: a block with no mounts declared is one finding, empty block included', () => {
   const dir = hostLayer();
   setMounts(dir, null);
   setBlock(dir, block());
   const found = surfacing(dir);
   assert.deepEqual(found, [
      {
         rule: 'mount-surfacing-block',
         message: 'this layer declares no federation.mounts; remove the leji-mounts block',
      },
   ]);
   // No mounts and no block is the clean case.
   setBlock(dir, '');
   assert.deepEqual(surfacing(dir), []);
});

test('surfacing: syntax, unknown, duplicate, missing, and owner findings accumulate in order', () => {
   const dir = hostLayer();
   setMounts(dir, [DECLARED, { ...DECLARED, name: 'acme-billing-context', owner: { name: 'Billing team' } }]);
   setBlock(
      dir,
      block(
         '- mount: acme-product-context',
         '  owner: Someone Else',
         '  carries: product-side context',
         '  read-when: a task touches the product surface',
         '- mount: acme-product-context',
         '  owner: Product team',
         '  carries: the same sibling again',
         '  read-when: never',
         '- mount: acme-unknown-context',
         '  owner: Nobody',
         '  carries: a sibling this layer does not declare',
         '  read-when: never',
         '  role: an unknown field',
      ),
   );
   const found = surfacing(dir);
   assert.deepEqual(
      found.map((f) => f.rule),
      ['mount-surfacing-syntax', 'mount-surfacing-duplicate', 'mount-surfacing-owner', 'mount-surfacing-missing'],
   );
   // The unknown-mount entry carried the unknown field, so it never became an
   // entry: its syntax finding is the one reported, in document order, first.
   assert.match(found[0].message, /unknown field "role"/);
   assert.match(found[1].message, /surfaced more than once/);
   assert.match(found[2].message, /surfaced with owner "Someone Else" but is declared with owner "Product team"/);
   assert.match(found[3].message, /declared mount "acme-billing-context" has no entry/);
});

test('surfacing: an entry for an undeclared mount is mount-surfacing-unknown', () => {
   const dir = hostLayer();
   setBlock(
      dir,
      [
         block(
            '- mount: acme-product-context',
            '  owner: Product team',
            '  carries: product-side context',
            '  read-when: a task touches the product surface',
         ),
         '',
         block(
            '- mount: acme-retired-context',
            '  owner: Product team',
            '  carries: a sibling that was unmounted',
            '  read-when: never',
         ),
      ].join('\n'),
   );
   const found = surfacing(dir);
   assert.equal(found.length, 1);
   assert.equal(found[0].rule, 'mount-surfacing-unknown');
   assert.match(found[0].message, /entry names "acme-retired-context"/);
});

test('surfacing: an owner name no entry could carry is reported against the manifest', () => {
   const dir = hostLayer();
   setMounts(dir, [{ ...DECLARED, owner: { name: 'Product team\nsecond line' } }]);
   const found = mountSurfacingFindings(dir, loadManifest(dir).manifest!);
   const unrepresentable = found.filter((f) => f.rule === 'mount-owner-name-line');
   assert.equal(unrepresentable.length, 1);
   assert.equal(unrepresentable[0].path, 'leji.json');
   assert.match(unrepresentable[0].message, /owner name no leji-mounts entry could carry/);
});

test('surfacing: a mount name no entry could carry is reported against the manifest', () => {
   const dir = hostLayer();
   setMounts(dir, [{ ...DECLARED, name: ' padded ' }]);
   const found = mountSurfacingFindings(dir, loadManifest(dir).manifest!);
   const unrepresentable = found.filter((f) => f.rule === 'mount-name-line');
   assert.equal(unrepresentable.length, 1);
   assert.equal(unrepresentable[0].path, 'leji.json');
   assert.match(unrepresentable[0].message, /name no leji-mounts entry could carry: .*leading or trailing whitespace/);
   // The block still carries the old name, so the surfacing checks are unaffected:
   // that entry names an undeclared mount, and the declared one has no entry.
   assert.deepEqual(
      found.map((f) => f.rule),
      ['mount-surfacing-unknown', 'mount-surfacing-missing', 'mount-name-line'],
   );
});

test('surfacing: a mount whose name and owner are both unrepresentable reports name first', () => {
   const dir = hostLayer();
   setMounts(dir, [{ ...DECLARED, name: ' padded ', owner: { name: 'Product team\nsecond line' } }]);
   const identity = mountSurfacingFindings(dir, loadManifest(dir).manifest!).filter((f) => f.rule.endsWith('-line'));
   assert.deepEqual(
      identity.map((f) => f.rule),
      ['mount-name-line', 'mount-owner-name-line'],
   );
   for (const f of identity) assert.equal(f.path, 'leji.json');
});

test('surfacing: findings reach validate as errors on the boot profile', () => {
   const dir = hostLayer();
   setBlock(dir, '');
   const errors = validateLayer(dir).findings.filter((f) => f.rule.startsWith('mount-surfacing'));
   assert.equal(errors.length, 1);
   assert.equal(errors[0].severity, 'error');
   assert.equal(errors[0].path, 'docs/boot-profile.md');
});

// --- conformance ---

test('conformance: mount-discovery passes on a valid block, fails without one, n/a with no mounts', () => {
   const dir = hostLayer();
   const item = (d: string) => conformanceReport(d).items.find((i) => i.id === 'mount-discovery')!;
   assert.equal(item(dir).status, 'pass');

   setBlock(dir, '');
   const failed = item(dir);
   assert.equal(failed.status, 'fail');
   assert.match(failed.detail!, /carries no leji-mounts block/);

   setMounts(dir, null);
   const na = item(dir);
   assert.equal(na.status, 'not-applicable');
   assert.equal(na.detail, 'no federation.mounts declared');
});
