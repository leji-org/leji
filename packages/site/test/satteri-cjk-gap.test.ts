import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri';
import { satteriCjkGap } from '../src/satteri-cjk-gap.ts';

// What the plugin deletes is a space the author could not leave out: CommonMark closes
// `**` after `。` only when a space follows it. So these cases are written the way a
// translator has to write them, rendered, and read for the space that should not have
// survived. The kept set is the other half of the convention, and the larger one: a
// Latin neighbour, a code span, an ideographic space, a heading, a link, or any raw
// HTML in the document means the space is someone's spacing rather than Markdown's.
//
// The renders go through a processor built here rather than the site's own options
// module, which Node cannot load directly (its imports carry no extensions); the last
// test reads that module instead and pins the registration.

const FEATURES = { gfm: true, smartPunctuation: true } as const;
const plugged = await createSatteriMarkdownProcessor({ hastPlugins: [satteriCjkGap], features: FEATURES });
const plain = await createSatteriMarkdownProcessor({ hastPlugins: [], features: FEATURES });
// Two registrations of one plugin are two passes over the same tree, the second over
// what the first mutated: the tree-level idempotence check.
const twice = await createSatteriMarkdownProcessor({ hastPlugins: [satteriCjkGap, satteriCjkGap], features: FEATURES });

const testDir = path.dirname(fileURLToPath(import.meta.url));

/** A file in the locale's translated specification, which is what makes a render
 *  eligible: the plugin reads the language off the path, as the link rewriter does. */
const source = (locale: string) => new URL(`../src/content/i18n/${locale}/spec/example.md`, import.meta.url);

const render = async (markdown: string, fileURL?: URL) => (await plugged.render(markdown, { fileURL })).code;
const untouched = async (markdown: string, fileURL?: URL) => (await plain.render(markdown, { fileURL })).code;

const ja = source('ja');

/** The boundaries the convention describes, each with the render it must produce. */
const DELETED: [string, string, string][] = [
   ['after closing punctuation', '**注意。** 次へ', '<p><strong>注意。</strong>次へ</p>\n'],
   ['before an emphasis', '次へ **注意**', '<p>次へ<strong>注意</strong></p>\n'],
   ['between two emphases', '**甲** **乙**', '<p><strong>甲</strong><strong>乙</strong></p>\n'],
   ['after a supplementary-plane ideograph', '**𠮷田** です', '<p><strong>𠮷田</strong>です</p>\n'],
   ['after a prolonged sound mark', 'ユーザー **注意**', '<p>ユーザー<strong>注意</strong></p>\n'],
   ['before an opening bracket', '次へ **「注意」**', '<p>次へ<strong>「注意」</strong></p>\n'],
   ['after an ellipsis', '**待って…** 次へ', '<p><strong>待って…</strong>次へ</p>\n'],
   ['before a katakana middle dot', '**項目** ・説明', '<p><strong>項目</strong>・説明</p>\n'],
   ['before a wave dash', '**範囲** 〜次へ', '<p><strong>範囲</strong>〜次へ</p>\n'],
   ['on both sides of an emphasis holding a digit', '前へ **第2章** 次へ', '<p>前へ<strong>第2章</strong>次へ</p>\n'],
   [
      'at every nesting level of the emphasis',
      '前へ ***注意。** 次へ* 後へ',
      '<p>前へ<em><strong>注意。</strong>次へ</em>後へ</p>\n',
   ],
   ['at both ends of one text node', '**甲** 中 **乙**', '<p><strong>甲</strong>中<strong>乙</strong></p>\n'],
   [
      'at bridges and text in one paragraph',
      '**甲** **乙** 次へ **丙** **丁**',
      '<p><strong>甲</strong><strong>乙</strong>次へ<strong>丙</strong><strong>丁</strong></p>\n',
   ],
   [
      'inside a table cell',
      '| 見出し |\n|---|\n| **注意。** 次へ |',
      '<table>\n<thead>\n<tr>\n<th>見出し</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td><strong>注意。</strong>次へ</td>\n</tr>\n</tbody>\n</table>\n',
   ],
];

/** Boundaries that look like the ones above and are not them. */
const KEPT: [string, string][] = [
   ['a Latin word follows', '**注意。** API'],
   ['a code span follows', '**注意。** `code`'],
   ['the emphasis ends on a digit', '**第2** 章'],
   ['a digit precedes the emphasis', '第2 **章**'],
   ['the neighbours are full-width Latin', '**型Ａ** 型Ｂ'],
   ['the separator is an ideographic space', '**注意。**　次へ'],
   ['a code span sits at the emphasis edge', '**`例`** 次へ'],
   ['the whole phrase is a link', '[**注意。** 次へ](/x)'],
];

test('the forced space goes at every CJK boundary the convention names', async () => {
   for (const [name, markdown, expected] of DELETED) {
      assert.equal(await render(markdown, ja), expected, name);
   }
});

test('a Simplified Chinese page is read the same way', async () => {
   const zh = source('zh-hans');
   assert.equal(await render('**注意。** 下一步', zh), '<p><strong>注意。</strong>下一步</p>\n');
   assert.equal(await render('下一步 **注意**', zh), '<p>下一步<strong>注意</strong></p>\n');
});

test('a space someone put there, rather than Markdown, stays', async () => {
   for (const [name, markdown] of KEPT) {
      assert.equal(await render(markdown, ja), await untouched(markdown, ja), name);
   }
});

test('a heading keeps its spaces, so every id and fragment link stays put', async () => {
   for (const level of ['#', '##', '######']) {
      const markdown = `${level} **注意。** 次へ`;
      const rendered = await render(markdown, ja);
      assert.equal(rendered, await untouched(markdown, ja), markdown);
      assert.match(rendered, /id="注意-次へ"/);
   }
});

test('a document carrying raw HTML is left as authored, whole', async () => {
   const documents: [string, string][] = [
      ['an inline wrapper', '<span data-cjk-gap="keep">**注意。** 次へ</span>'],
      ['a wrapper spanning blocks', '<a href="/x">\n\n**注意。** 次へ\n\n</a>'],
      ['raw inside the emphasis', '前へ **注意 <span>例</span>。** 次へ'],
      // A highlighted code block reaches the tree as raw HTML too, so a document with
      // a fenced block keeps its spaces exactly as authored.
      ['a fenced code block', '```json\n{"a": 1}\n```\n\n**注意。** 次へ'],
   ];
   for (const [name, markdown] of documents) {
      assert.equal(await render(markdown, ja), await untouched(markdown, ja), name);
   }
});

test('the boundary between two list items is not a gap', async () => {
   const markdown = '- **甲**\n- 乙 次へ';
   assert.equal(await render(markdown, ja), await untouched(markdown, ja));
});

test('a locale whose punctuation is half width is untouched, and so is a render with no file', async () => {
   const es = source('es');
   for (const [name, markdown] of DELETED) {
      assert.equal(await render(markdown, es), await untouched(markdown, es), `es: ${name}`);
      assert.equal(await render(markdown), await untouched(markdown), `no file: ${name}`);
   }
});

test('one processor keeps every document to its own locale, whatever the order', async () => {
   const markdown = '**注意。** 次へ';
   const deleted = '<p><strong>注意。</strong>次へ</p>\n';
   const kept = await untouched(markdown, ja);
   assert.equal(await render(markdown, ja), deleted);
   assert.equal(await render(markdown, source('zh-hans')), deleted);
   assert.equal(await render(markdown, source('es')), kept);
   assert.equal(await render(markdown), kept);
   assert.equal(await render(markdown, ja), deleted);
});

test('a second pass over the mutated tree changes nothing', async () => {
   for (const [name, markdown, expected] of DELETED) {
      assert.equal((await twice.render(markdown, { fileURL: ja })).code, expected, name);
   }
});

test('the site pipeline runs the plugin last, after the tree is otherwise final', () => {
   const options = fs.readFileSync(path.join(testDir, '..', 'src', 'markdown-options.ts'), 'utf8');
   const registered = /hastPlugins:\s*\[([^\]]*)\]/.exec(options)?.[1];
   assert.ok(registered, 'the shared options register no hast plugins');
   assert.equal(
      registered
         .split(',')
         .map((name) => name.trim())
         .filter(Boolean)
         .at(-1),
      'satteriCjkGap',
   );
});
