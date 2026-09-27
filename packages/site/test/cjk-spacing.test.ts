import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Full-width punctuation already carries its own trailing space, so a Latin space
// after it shows as a gap in the ja and zh-hans pages. The build compresses template
// whitespace JSX-style: a line break next to an element renders nothing, but an
// explicit `{' '}` renders one space, and so does a literal space inside a line. The
// formatter wraps `{' '}` across three lines when the line runs long, which is why
// this is a scan of the sources rather than a grep someone remembers to run.
//
// The spaces between CJK text and a Latin term are the translations' own convention
// and are not this check's business; only the space after a full-width mark is.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pagesDir = path.resolve(testDir, '..', 'src', 'pages');
const LOCALES = ['ja', 'zh-hans'];

const MARKS = '。、，：；！？）「」';
/** `{' '}` in either form, single-line or wrapped by the formatter. */
const SPACE_EXPRESSION = /\{\s*(['"`]) \1\s*\}/g;
/** A mark followed on the same line by a space or tab and then something that renders. */
const LITERAL_SPACE = new RegExp(`[${MARKS}][ \\t]+(?=\\S)`, 'g');

function astroFiles(dir: string): string[] {
   return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return astroFiles(full);
      return entry.name.endsWith('.astro') ? [full] : [];
   });
}

/** The template's text alone: frontmatter, style and script blocks, and quoted attribute
 *  values (a page title's ` · Leji` suffix is not page text) blanked, line numbers kept. */
function template(source: string): string {
   const blank = (block: string) => block.replace(/[^\n]/g, ' ');
   return source
      .replace(/^---\n[\s\S]*?\n---(?=\n)/, blank)
      .replace(/<(style|script)\b[\s\S]*?<\/\1>/g, blank)
      .replace(/=\s*("[^"]*"|'[^']*')/g, blank);
}

function lineOf(text: string, index: number): number {
   return text.slice(0, index).split('\n').length;
}

function spacesAfterMarks(source: string): number[] {
   const text = template(source);
   const lines: number[] = [];
   for (const match of text.matchAll(SPACE_EXPRESSION)) {
      const before = text.slice(0, match.index).trimEnd();
      if (MARKS.includes(before.at(-1) ?? '')) lines.push(lineOf(text, match.index));
   }
   for (const match of text.matchAll(LITERAL_SPACE)) lines.push(lineOf(text, match.index));
   return lines.sort((a, b) => a - b);
}

test('no ja or zh-hans page renders a space after full-width punctuation', () => {
   const hits: string[] = [];
   for (const locale of LOCALES) {
      for (const file of astroFiles(path.join(pagesDir, locale))) {
         const rel = path.relative(pagesDir, file);
         for (const line of spacesAfterMarks(fs.readFileSync(file, 'utf8'))) hits.push(`${rel}:${line}`);
      }
   }
   assert.deepEqual(hits, [], `a space follows full-width punctuation at:\n${hits.join('\n')}`);
});
