import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../dist/index.js';
// The scan is the export command's own policy rather than SDK surface, so it stays
// inside the module an in-repo test reads directly.
import { scanRenderConstructs } from '../dist/lib/renderlint.js';

// Two halves of one contract. First the scan itself, family by family over the
// edges the fixtures state in prose: what it reports, and — the half a lint lives
// or dies on — what it stays quiet about. Then the shared render fixtures, driven
// through the real command: their pinned findings, their layout, and their golden
// export bytes.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');

/** The scan as `line:construct` strings, which is what a family assertion reads. */
function hits(text: string): string[] {
   return scanRenderConstructs(text).map((h) => `${h.line}:${h.construct}`);
}

// --- family: multi-line HTML blocks -------------------------------------------

test('family: an HTML block reports once, at the line it opens on', () => {
   // A block runs to the next blank line, so the tags inside it — the closing one
   // included — are block content and not a second construct.
   assert.deepEqual(hits(['# Doc', '', '<div class="callout">', '   inner text', '</div>', '', 'after'].join('\n')), [
      '3:raw-html',
   ]);
   // Two blocks separated by a blank line are two constructs.
   assert.deepEqual(hits(['<table>', '<tr><td>a</td></tr>', '</table>', '', '<div>', '</div>'].join('\n')), [
      '1:raw-html',
      '5:raw-html',
   ]);
   // A raw-text block (type 1) ends at its closing tag rather than at a blank line,
   // so the blank line inside it does not split it into two.
   assert.deepEqual(hits(['<script>', '', 'let x = 1;', '', '</script>', '', 'prose'].join('\n')), ['1:raw-html']);
   // Inline raw HTML mid-paragraph is the other form, reported on its own line, and
   // a line carrying two tags is still one finding: the line is the unit.
   assert.deepEqual(hits('A paragraph with <b>bold</b> and <i>italic</i> in it.\n'), ['1:raw-html']);
   // Negative: a document with no HTML at all reports nothing.
   assert.deepEqual(hits('# Title\n\nProse with a < less-than and an a > b comparison.\n'), []);
});

// --- family: excluded regions -------------------------------------------------

test('family: code spans, fences, and comments are excluded regions', () => {
   // Code spans, including the multiple-backtick form.
   assert.deepEqual(hits('The tag `<div>` and `[^ref]` and `$$x$$` are text.\n'), []);
   assert.deepEqual(hits('A span with a backtick in it: ``a `<b>` span``.\n'), []);
   // Fenced blocks, whatever the info string, and a longer fence carrying a shorter
   // one: everything between the delimiters is code.
   assert.deepEqual(hits(['```html', '<div>', '</div>', '```'].join('\n')), []);
   assert.deepEqual(hits(['````markdown', '```html', '<span>x</span>', '```', '````'].join('\n')), []);
   assert.deepEqual(hits(['~~~', '[^one]: definition', '$$', 'x', '$$', '~~~'].join('\n')), []);
   // Comments are the excepted HTML form: nothing inside one is reported, on one
   // line or many, at the start of a line or inside prose.
   assert.deepEqual(hits(['<!--', '   <div> and [^ref] and $$x$$', '-->', '', 'prose'].join('\n')), []);
   assert.deepEqual(hits('Prose with <!-- a <div> inside a comment --> and more prose.\n'), []);
   // Positive controls: the same constructs outside a region are reported, so the
   // assertions above are the exclusion working rather than a scan that sees nothing.
   assert.deepEqual(hits('The tag <div> and [^ref] and $$x$$ are markup.\n'), [
      '1:footnote',
      '1:math-block',
      '1:raw-html',
   ]);
   // An unclosed fence excludes the rest of the document, as a renderer reads it.
   assert.deepEqual(hits(['```', '<div>', '[^one]'].join('\n')), []);
});

// --- family: malformed and unpaired forms -------------------------------------

test('family: an unpaired or malformed construct is prose', () => {
   // `$$` needs an open and a close; a lone delimiter is prose.
   assert.deepEqual(hits('A lone delimiter:\n\n$$\n'), []);
   assert.deepEqual(hits('$$\na^2 + b^2 = c^2\n$$\n'), ['1:math-block']);
   assert.deepEqual(hits('An inline pair: $$e = mc^2$$ mid-sentence.\n'), ['1:math-block']);
   // A single `$` is deliberately outside the closed token set.
   assert.deepEqual(hits('An amount of $5 and a variable named $path.\n'), []);
   // A footnote needs its closing bracket.
   assert.deepEqual(hits('An open bracket [^ and nothing closing it.\n'), []);
   assert.deepEqual(hits('An empty label [^] is not a footnote either.\n'), []);
   assert.deepEqual(hits('A reference[^one] and its definition.\n\n[^one]: The text.\n'), ['1:footnote', '3:footnote']);
   // A `<` that opens no valid tag is prose, and a bare tag name is not markup.
   assert.deepEqual(hits('Compare a < b, and 3<4, and <-- an arrow.\n'), []);
});

// --- family: the YAML frontmatter boundary ------------------------------------

test('family: frontmatter is excluded, and only a leading block is frontmatter', () => {
   const front = ['---', 'title: A value with <div> and [^ref] and $$x$$', '---', '', '# Doc', ''].join('\n');
   assert.deepEqual(hits(front), []);
   // A `---` later in a document is a thematic break, so the text after it is
   // scanned like any other prose.
   assert.deepEqual(hits(['# Doc', '', '---', '', 'Prose with <div> in it.', ''].join('\n')), ['5:raw-html']);
   // A block that never closes is not frontmatter, so its content is prose — and
   // reported, which is the honest read of a document nothing will strip.
   assert.deepEqual(hits(['---', 'title: <div>', '', '# Doc', ''].join('\n')), ['2:raw-html']);
   // Frontmatter opens the FILE or it is not frontmatter: a block one line down is
   // a thematic break followed by prose.
   assert.deepEqual(hits(['', '---', 'title: <div>', '---', ''].join('\n')), ['3:raw-html']);
});

// --- family: overlaps and same-line ordering ----------------------------------

test('family: overlapping constructs resolve to the earliest start, one per line and construct', () => {
   // Three constructs on one line, reported in the closed set's alphabetical order —
   // the tie-breaker that keeps a same-line group deterministic across the SDKs.
   assert.deepEqual(hits('All three: [^b], <i>italic</i>, and $$x + y$$ in one sentence.\n'), [
      '1:footnote',
      '1:math-block',
      '1:raw-html',
   ]);
   // A footnote-looking label inside a tag's attribute belongs to the tag: the
   // earliest-starting match consumes it, so the line reports raw HTML only.
   assert.deepEqual(hits('<span title="[^ref]">text</span>\n'), ['1:raw-html']);
   // And the other way round: a tag inside a math pair belongs to the pair.
   assert.deepEqual(hits('$$ a <b> c $$\n'), ['1:math-block']);
   // A math pair spanning lines is attributed to its opening line, and the constructs
   // between the delimiters are inside it.
   assert.deepEqual(hits(['$$', 'a <b> c [^ref]', '$$', '', '<span>x</span>'].join('\n')), [
      '1:math-block',
      '5:raw-html',
   ]);
   // Block structure outranks the inline pair, as a renderer reads it: a line
   // OPENING with a block tag is an HTML block running to the blank line, so the
   // second delimiter is inside it and the first never pairs.
   assert.deepEqual(hits(['$$', '<div> [^ref]', '$$', '', '<span>x</span>'].join('\n')), ['2:raw-html', '5:raw-html']);
   // Repeats on one line collapse; the same construct on the next line does not.
   assert.deepEqual(hits('[^a] and [^b] together.\n[^c] alone.\n'), ['1:footnote', '2:footnote']);
});

// --- family: backslash escapes ------------------------------------------------

test('family: an escaped delimiter is a literal, and an entity is not markup', () => {
   assert.deepEqual(hits('Escaped: \\<div> and \\<b>bold\\</b> are prose.\n'), []);
   assert.deepEqual(hits('Escaped: \\[^one] in a sentence.\n\n\\[^one]: not a definition.\n'), []);
   assert.deepEqual(hits('Escaped math: \\$\\$ a^2 \\$\\$ is prose about the notation.\n'), []);
   // An HTML entity spells a character, not an element.
   assert.deepEqual(hits('Entities: &lt;div&gt; and &amp;lt; are text.\n'), []);
   // Positive controls for each escape above.
   assert.deepEqual(hits('Unescaped: <div> here.\n'), ['1:raw-html']);
   assert.deepEqual(hits('Unescaped: [^one] here.\n'), ['1:footnote']);
   assert.deepEqual(hits('Unescaped: $$ a^2 $$ here.\n'), ['1:math-block']);
   // A backslash before a non-punctuation character is a literal backslash, so the
   // construct after it still reports.
   assert.deepEqual(hits('A backslash \\n then <div>.\n'), ['1:raw-html']);
});

// --- family: the HTML block forms that end mid-line ---------------------------

test('family: a processing instruction, declaration, or CDATA block runs through its terminator line', () => {
   // CommonMark type 3: the block ends on the line carrying `?>`, and the WHOLE of
   // that line belongs to it — so what follows the terminator there is block content
   // rather than a second construct, and the block reports once, at its opening line.
   assert.deepEqual(hits(['<?php', '[^inside]', '?> [^after]'].join('\n')), ['1:raw-html']);
   // Type 4 (a declaration) ends at the first `>`, type 5 (CDATA) at `]]>`; what
   // follows the block, on a later line, is scanned normally.
   assert.deepEqual(hits(['<!DOCTYPE html>', '', '[^after]'].join('\n')), ['1:raw-html', '3:footnote']);
   assert.deepEqual(hits(['<![CDATA[', '[^x]', ']]> [^after]', '', 'prose [^real]'].join('\n')), [
      '1:raw-html',
      '5:footnote',
   ]);
   // A block whose terminator never arrives runs to the end of the document, exactly
   // as the comment form does.
   assert.deepEqual(hits(['<?php', '[^inside]'].join('\n')), ['1:raw-html']);
   // Negatives. The same forms mid-line are INLINE raw HTML, so the line's remainder
   // is still scanned; an escaped opener is prose; one inside a fence is code.
   assert.deepEqual(hits('Prose <?php echo 1; ?> and [^ref].\n'), ['1:footnote', '1:raw-html']);
   assert.deepEqual(hits('Escaped \\<?php ?> here.\n'), []);
   assert.deepEqual(hits(['```', '<?php ?>', '```', '[^after]'].join('\n')), ['4:footnote']);
});

// --- family: inline state never crosses a block boundary ----------------------

test('family: a code span or a math pair never bridges a block region', () => {
   // The candidate closer lies beyond a block region, which ended the paragraph the
   // run opened in: the backticks are literal at that boundary, so the footnote after
   // the region is reported rather than swallowed.
   assert.deepEqual(hits(['Text `open', '<!-- comment -->', '[^after] and a closer `here'].join('\n')), ['3:footnote']);
   // The same for a `$$` whose apparent mate sits on the far side of the region: an
   // unpaired delimiter is prose, and what follows it still reports.
   assert.deepEqual(hits(['$$ open', '<!-- comment -->', '$$ and [^after]'].join('\n')), ['3:footnote']);
   // Positive controls: inside ONE block, both forms still span lines.
   assert.deepEqual(hits(['A span `over', 'two lines` and [^after]'].join('\n')), ['2:footnote']);
   assert.deepEqual(hits(['$$', 'a^2 + b^2', '$$'].join('\n')), ['1:math-block']);
});

// --- family: a mate inside an excluded span, and straddling delimiters ---------

test('family: a delimiter whose mate sits in a code span or a comment does not pair', () => {
   // The apparent closer is inside an excluded region, so the open never pairs and
   // the line is prose about the notation.
   assert.deepEqual(hits('$$ open `$$` tail\n'), []);
   assert.deepEqual(hits('$$ open <!-- $$ --> tail\n'), []);
   // Positive controls: a readable mate pairs, and a real pair after an excluded one
   // is still found.
   assert.deepEqual(hits('$$ open $$ tail\n'), ['1:math-block']);
   assert.deepEqual(hits('`$$` and then a real pair $$x$$\n'), ['1:math-block']);
   // Straddling a span's edge, both ways: a footnote whose closing bracket is inside
   // a code span still reports — the earliest start wins the overlap — while one that
   // OPENS inside the span is span content.
   assert.deepEqual(hits('[^one `] and text`\n'), ['1:footnote']);
   assert.deepEqual(hits('`[^one` ] tail\n'), []);
});

// --- family: declaration case, split terminators, and indented openers --------

test('family: a declaration takes an ASCII letter of either case, and a terminator must be contiguous', () => {
   // `<!` plus an ASCII letter of EITHER case is a declaration, at block and inline
   // positions alike — the rendering the vendored renderer actually produces, and
   // CommonMark's own character class. A block one runs to the next `>`, so what
   // sits inside the consumed span and what trails the terminator on its line are
   // block content rather than constructs of their own.
   assert.deepEqual(hits(['<!foo', '[^inside]', '<!DOCTYPE html> [^tail]', '', '[^after]'].join('\n')), [
      '1:raw-html',
      '5:footnote',
   ]);
   // Unterminated, the block runs to the end of the document, as the comment form does.
   assert.deepEqual(hits(['<!foo', '[^after]'].join('\n')), ['1:raw-html']);
   assert.deepEqual(hits('Prose <!foo bar> and [^ref].\n'), ['1:footnote', '1:raw-html']);
   // The uppercase spellings, block form and inline form: identical treatment, so the
   // assertions above are the grammar and not a case accident.
   assert.deepEqual(hits(['<!DOCTYPE html>', '', '[^after]'].join('\n')), ['1:raw-html', '3:footnote']);
   assert.deepEqual(hits('Prose <!ENTITY x "y"> and [^ref].\n'), ['1:footnote', '1:raw-html']);
   // A terminator split across two lines is not a terminator: the CDATA block runs on
   // to the contiguous `]]>`, and that whole line is block content.
   assert.deepEqual(hits(['<![CDATA[', 'data ]]', '> still inside [^no]', ']]> [^after]', '', '[^real]'].join('\n')), [
      '1:raw-html',
      '6:footnote',
   ]);
   // Indentation decides whether a line opens a block at all: a tab is one indent
   // character, so a tab-indented opener still opens one, terminator line included.
   assert.deepEqual(hits(['\t<?php', '[^inside]', '\t?> [^after]', '', '[^real]'].join('\n')), [
      '1:raw-html',
      '5:footnote',
   ]);
   // Four leading spaces are indented code, which opens no block: an unterminated
   // opener there swallows nothing, and the line after it still reports.
   assert.deepEqual(hits(['    <?php', '[^after]'].join('\n')), ['2:footnote']);
});

// --- the shared render fixtures -----------------------------------------------

interface ExpectedFinding {
   rule: string;
   severity: string;
   path: string;
   line: number;
   construct: string;
}

interface GoldenTree {
   status: 'pending' | 'baked' | 'none';
   contentDir?: string;
   manifest?: string;
}

interface ExpectedExport {
   args?: string[];
   exit: number;
   findings: ExpectedFinding[];
   out: string;
   layout?: { roles?: Record<string, string>; present?: string[]; absent?: string[]; preserved?: string[] };
   rerun?: { byteIdentical?: boolean };
   goldenTree: GoldenTree;
}

/** The layout fixtures are driven by canary.test.ts, which asserts their trust
 * corpus alongside the same export block; this harness takes the rest. */
const CANARY_DRIVEN = new Set([
   'valid-unified-leji-fresh',
   'valid-unified-leji-stale-tree',
   'valid-trust-canary-nested-root',
   'valid-trust-canary-dot-root',
]);

/** run() writes to the console; swallow it and hand back what it said. */
async function quiet<T>(fn: () => T | Promise<T>): Promise<{ value: T; stdout: string }> {
   const chunks: string[] = [];
   const log = console.log;
   const err = console.error;
   console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(' ') + '\n');
   console.error = () => {};
   try {
      return { value: await fn(), stdout: chunks.join('') };
   } finally {
      console.log = log;
      console.error = err;
   }
}

/** Every path under `dir` as `rel -> digest` (directories as `rel/` -> ''), so a
 * comparison covers appearance and disappearance as well as content. */
function snapshot(dir: string, rel = '', acc = new Map<string, string>()): Map<string, string> {
   const abs = rel === '' ? dir : path.join(dir, rel);
   for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
         acc.set(childRel + '/', '');
         snapshot(dir, childRel, acc);
      } else if (entry.isFile()) {
         acc.set(
            childRel,
            crypto
               .createHash('sha256')
               .update(fs.readFileSync(path.join(dir, childRel)))
               .digest('hex'),
         );
      } else {
         acc.set(childRel, 'non-regular');
      }
   }
   return acc;
}

/** A golden artifact at its declared name, or at the dot-prefixed name beside it:
 * a `rootPath: "."` fixture exports its own root, so a plainly named golden would
 * be exported into the next bake of itself (fixtures/README.md). */
function goldenPath(fixtureRoot: string, declared: string): string {
   const [head, ...rest] = declared.split('/');
   const plain = path.join(fixtureRoot, head, ...rest);
   return fs.existsSync(plain) ? plain : path.join(fixtureRoot, '.' + head, ...rest);
}

/** Files only, as export-root-relative POSIX paths. */
function filesUnder(dir: string, rel = '', acc: string[] = []): string[] {
   for (const entry of fs.readdirSync(rel === '' ? dir : path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) filesUnder(dir, childRel, acc);
      else acc.push(childRel);
   }
   return acc.sort();
}

for (const name of fs.readdirSync(fixturesDir).sort()) {
   if (CANARY_DRIVEN.has(name)) continue;
   const expectedFile = path.join(fixturesDir, name, 'expected.json');
   if (!fs.existsSync(expectedFile)) continue;
   const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8')) as { export?: ExpectedExport };
   const block = expected.export;
   if (!block) continue;

   test(`fixture ${name}: the export block, its findings, and its golden tree`, async () => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-render-')));
      fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });

      const preservedBefore = new Map<string, string>();
      for (const rel of block.layout?.preserved ?? []) {
         const abs = path.join(dir, ...rel.split('/'));
         assert.ok(fs.existsSync(abs), `preserved path exists before the run: ${rel}`);
         if (fs.statSync(abs).isFile()) preservedBefore.set(rel, fs.readFileSync(abs, 'utf8'));
      }

      // The whole command, under the fixture's own argv: the exit code is the
      // process's, and the findings are the ones a `--json` consumer reads.
      const args = block.args ?? ['export'];
      const { value: exit, stdout } = await quiet(() => run([...args, '--root', dir, '--json']));
      assert.equal(exit, block.exit, `exit code for ${name}: ${stdout}`);
      const doc = JSON.parse(stdout) as { out: string; findings: ExpectedFinding[] };
      assert.equal(doc.out.split(path.sep).join('/'), block.out, 'the declared output directory');
      // Matched on (rule, severity, path, line, construct) IN ORDER — message text is
      // never compared, and the order is the canonical one the three SDKs share.
      assert.deepEqual(
         doc.findings.map((f) => ({
            rule: f.rule,
            severity: f.severity,
            path: f.path,
            line: f.line,
            construct: f.construct,
         })),
         block.findings,
         `findings for ${name}`,
      );

      // `roles` is the layout's role map — which directory each role NAMES — and
      // `present`/`absent` say which of them a given run establishes: a `--strict`
      // run names the export role and deliberately writes nothing at it.
      const absent = new Set((block.layout?.absent ?? []).map((p) => p.replace(/\/+$/, '')));
      for (const [role, roleDir] of Object.entries(block.layout?.roles ?? {})) {
         const rel = roleDir.replace(/\/+$/, '');
         const abs = path.join(dir, ...rel.split('/'));
         if (absent.has(rel)) continue;
         assert.ok(fs.existsSync(abs) && fs.statSync(abs).isDirectory(), `role ${role} established at ${roleDir}`);
      }
      for (const rel of block.layout?.present ?? []) {
         assert.ok(
            fs.existsSync(path.join(dir, ...rel.replace(/\/+$/, '').split('/'))),
            `present after the run: ${rel}`,
         );
      }
      for (const rel of block.layout?.absent ?? []) {
         assert.ok(!fs.existsSync(path.join(dir, ...rel.replace(/\/+$/, '').split('/'))), `never created: ${rel}`);
      }
      for (const [rel, before] of preservedBefore) {
         assert.equal(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'), before, `byte-identical: ${rel}`);
      }

      // --- the golden tree -----------------------------------------------------
      const out = path.join(dir, ...block.out.split('/'));
      if (block.goldenTree.status === 'none') {
         assert.ok(!fs.existsSync(out), 'a run that writes no export tree has nothing to bake');
      }
      if (block.goldenTree.status === 'baked') {
         const contentDir = goldenPath(path.join(fixturesDir, name), block.goldenTree.contentDir!);
         const manifestFile = goldenPath(path.join(fixturesDir, name), block.goldenTree.manifest!);
         const written = filesUnder(out);
         const inContent = written.filter((f) => f.startsWith('content/'));
         const outside = written.filter((f) => !f.startsWith('content/'));

         // The committed bytes ARE the export's content tree: same paths, same bytes,
         // in both directions, so a file that appears or disappears fails here.
         assert.deepEqual(
            inContent.map((f) => f.slice('content/'.length)),
            filesUnder(contentDir),
            `${name}: the golden content tree lists exactly what the export wrote`,
         );
         for (const rel of filesUnder(contentDir)) {
            assert.deepEqual(
               fs.readFileSync(path.join(out, 'content', ...rel.split('/'))),
               fs.readFileSync(path.join(contentDir, ...rel.split('/'))),
               `${name}: exported bytes differ from the golden for content/${rel}`,
            );
         }

         // Everything else — chrome, vendored assets, fonts — by digest and size. The
         // two sets are disjoint by construction and exhaustive by this comparison.
         const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
            version: number;
            files: Record<string, { sha256: string; size: number }>;
         };
         assert.equal(manifest.version, 1, 'the manifest states its version');
         assert.deepEqual(
            Object.keys(manifest.files),
            outside,
            `${name}: the manifest pins every file outside content/`,
         );
         for (const rel of outside) {
            const bytes = fs.readFileSync(path.join(out, ...rel.split('/')));
            assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), manifest.files[rel].sha256, rel);
            assert.equal(bytes.length, manifest.files[rel].size, `${rel} size`);
         }
      }

      // --- idempotency ---------------------------------------------------------
      if (block.rerun?.byteIdentical) {
         const afterFirst = snapshot(dir);
         await quiet(() => run([...args, '--root', dir, '--json']));
         assert.deepEqual(
            [...snapshot(dir).entries()].sort(),
            [...afterFirst.entries()].sort(),
            'a second run is a byte-level no-op across the whole working tree',
         );
      }
      fs.rmSync(dir, { recursive: true, force: true });
   });
}
