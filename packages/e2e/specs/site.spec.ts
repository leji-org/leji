// leji.org, as `astro preview` serves the built site. Every selector here is an
// existing role, accessible label, heading, or URL: the suite reads the site as a
// reader does and never asks it to grow a hook for the sake of a test.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
   SITE_CONSOLE_ALLOWANCES,
   SITE_URL,
   backgroundOf,
   collectConsoleErrors,
   expectNoConsoleErrors,
   resourceNotFoundAllowance,
   rgb,
} from '../assertions.js';
// The site's own reader for the two files the hero's viewer window is built from.
// Imported rather than reimplemented: a second copy of the parse would agree with
// itself while the page showed something else.
import { parseSidebar } from '../../site/src/lib/hero-glimpse.js';

const specDir = path.dirname(fileURLToPath(import.meta.url));
const pinnedSidebar = path.resolve(specDir, '..', '..', 'site', 'src', 'data', 'hero-glimpse', '_sidebar.md');

test.describe('site', () => {
   test('the index page renders the hero session and the install tabs', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Make your');
      await expect(
         page.getByRole('group', { name: 'A real Leji session: adopt an existing repo, validate it, score it' }),
      ).toBeVisible();
      const tabs = page.getByRole('tablist', { name: 'Install Leji' });
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole('tab')).not.toHaveCount(0);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   // The viewer window in the hero is drawn from the sidebar `leji export` writes for
   // the hero fixture. The SDK's test keeps that file current and the site's unit test
   // keeps the reading of it honest; neither can see whether the markup then preserved
   // what it read. A flattened group, or the decisions index rendered outside Decisions,
   // is invisible to a comparison of labels in order and visible to this one.
   test('the hero glimpse renders the generated sidebar, hierarchy intact', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/`);
      expect(response?.status()).toBe(200);
      // The window is in the markup whatever the animation is doing, and hidden from
      // the accessibility tree, so this reads the DOM rather than what is visible.
      const glimpse = page.locator('.glimpse');
      await expect(glimpse).toHaveCount(1);

      const rendered = await glimpse.evaluate((root) => {
         const text = (el: Element): string => (el.textContent ?? '').trim();
         const folders = (list: Element) =>
            [...list.querySelectorAll(':scope > li')].map((li) => ({
               label: text(li.querySelector(':scope > .g-label')!),
               entries: [...li.querySelectorAll(':scope > ul > li')].map(text),
            }));
         // The last list is the drawer, below the sidebar's last rule, exactly as the
         // generated file's own zones divide it.
         const lists = [...root.querySelectorAll('.g-side ul.g-nav')];
         return {
            pins: [...root.querySelectorAll('.g-side ul.g-pins > li')].map(text),
            groups: lists.slice(0, -1).flatMap(folders),
            drawer: lists.length > 0 ? (folders(lists[lists.length - 1])[0] ?? null) : null,
         };
      });

      expect(rendered).toEqual(parseSidebar(fs.readFileSync(pinnedSidebar, 'utf8')));
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the quickstart page renders its steps', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/quickstart/`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build a context layer, check it conforms.');
      await expect(page.getByRole('region', { name: 'Quickstart steps' })).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the agent-ready page renders the three commands and their copy buttons', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/agent-ready/`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your repo, agent-ready in three commands.');
      const commands = page.getByRole('region', { name: 'The three commands' });
      await expect(commands).toBeVisible();
      await expect(commands.getByRole('button', { name: 'Copy install command' })).toBeVisible();
      await expect(commands.getByRole('button', { name: 'Copy the start command' })).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the spec index renders', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/spec/`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the recessed surfaces are painted warm', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/spec/`);
      expect(response?.status()).toBe(200);
      // Pixels, not stylesheet text: one token tints every recessed surface on the
      // site, so what is worth asserting is what the cascade actually paints on the
      // two that a reader meets first on a specification page.
      expect(await backgroundOf(page.getByRole('navigation', { name: 'Contents' }))).toBe(rgb('#F6F1E0'));
      // Inline code only. A `pre` block drops the chip and sits on the deep green,
      // and its `code` would otherwise be the first one this page offers.
      expect(await backgroundOf(page.locator('.prose :not(pre) > code').first())).toBe(rgb('#F1EDE2'));
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('a long specification page lists its sections and each entry lands on one', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/spec/distribution/`);
      expect(response?.status()).toBe(200);
      const contents = page.getByRole('navigation', { name: 'Contents' });
      await expect(contents).toBeVisible();
      // The document's own h2s and h3s, in reading order: the list is a view over
      // the headings, so a heading added or renamed in the frozen prose shows up
      // here rather than leaving the list quietly stale.
      await expect(contents.getByRole('link')).toHaveText([
         'Pattern 1: Monorepo (default)',
         'Pattern 2: the docs-only submodule for multi-repo setups',
         'Pattern 3: federation of sibling context layers',
         'Reading a federated context layer',
         'Restricted mounts',
         'Notes (non-normative)',
      ]);
      await contents.getByRole('link', { name: 'Restricted mounts' }).click();
      await expect(page).toHaveURL(`${SITE_URL}/spec/distribution/#restricted-mounts`);
      await expect(page.locator('#restricted-mounts')).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the one-page specification is reachable from the sidebar', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/spec/`);
      expect(response?.status()).toBe(200);
      // A regex, not the exact label: the sidebar draws its list marker with CSS
      // generated content, which the accessible name picks up.
      await page
         .getByRole('navigation', { name: 'Documentation' })
         .getByRole('link', { name: /One page/ })
         .click();
      await expect(page).toHaveURL(`${SITE_URL}/spec/full/`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('The Leji Specification');
      await expect(page.getByRole('navigation', { name: 'Contents' })).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the manifest schema page states what the viewer accent drives', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/schemas/context-manifest/`);
      expect(response?.status()).toBe(200);
      // The field reference is generated from `schemas/context-manifest.schema.json`
      // at build, so this reads the published contract rather than a copy of it: the
      // sentence is the one adopters are given about `viewer.theme.primary`, and it
      // has to keep agreeing with what the viewer actually does with the accent.
      const viewerField = page.locator('dt#viewer + dd');
      await expect(viewerField).toBeVisible();
      await expect(viewerField).toContainText('body links and inline code use the fixed accessible tone');
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('a translated page says what it is, how to correct it, and switches back', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/vi/quickstart/`);
      expect(response?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
      // The canonical note: how the page was made, that the English page governs,
      // how it was made, and the two ways to correct it. No revision is shown to a
      // reader at all; keeping every translation current is the drift gate's business.
      const note = page.getByRole('main').getByText(/^Bản dịch có sự hỗ trợ của AI agent/);
      await expect(note).toBeVisible();
      await expect(note).not.toContainText(/[0-9a-f]{7}/);
      await expect(note.getByRole('link', { name: 'trang tiếng Anh' })).toHaveAttribute('href', '/quickstart/');
      // Both invitations are links: the issue form knows the language and the route,
      // and the pull request opens this page's own source file.
      await expect(note.getByRole('link', { name: 'issue' })).toHaveAttribute(
         'href',
         `https://github.com/leji-org/leji/issues/new?template=translation-correction.md&title=${encodeURIComponent('[vi] /vi/quickstart/: ')}`,
      );
      await expect(note.getByRole('link', { name: 'pull request' })).toHaveAttribute(
         'href',
         'https://github.com/leji-org/leji/edit/main/packages/site/src/pages/vi/quickstart.astro',
      );
      // The language selector sits beside the logo and never in the menu, so the
      // primary navigation offers no language of its own. It is named in the page's
      // own language here, like every other label in the chrome.
      const menu = page.getByRole('navigation', { name: 'Chính' });
      await expect(menu).toHaveCount(1);
      await expect(menu.getByRole('link', { name: 'English' })).toHaveCount(0);
      // It names the language being read, and opens as a disclosure with no
      // script: the only `summary` in the banner is its own.
      const selector = page.getByRole('banner').getByRole('group');
      await expect(selector).toContainText('Tiếng Việt');
      await selector.locator('summary').click();
      // Every entry is a link, never a redirect: following one lands on the same
      // route in that language, at its own URL.
      await selector.getByRole('link', { name: 'English' }).click();
      await expect(page).toHaveURL(`${SITE_URL}/quickstart/`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build a context layer, check it conforms.');
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('a translated page navigates in its own language, to its own pages where they exist', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/vi/quickstart/`);
      expect(response?.status()).toBe(200);
      // The menu band and the side-nav, both named and labelled in Vietnamese.
      const menu = page.getByRole('navigation', { name: 'Chính' });
      const sidebar = page.getByRole('navigation', { name: 'Tài liệu' });
      const quickstart = menu.getByRole('link', { name: 'Bắt đầu nhanh' });
      // A translated destination goes to the Vietnamese page, and the page being
      // read is marked current, which a comparison against the served path could
      // not do on a translated page.
      await expect(quickstart).toHaveAttribute('href', '/vi/quickstart/');
      await expect(quickstart).toHaveAttribute('aria-current', 'page');
      await expect(sidebar.getByRole('link', { name: 'Sẵn sàng cho agent' })).toHaveAttribute(
         'href',
         '/vi/agent-ready/',
      );
      // The schema reference was the last destination in this locale's chrome that
      // still went to English, and it no longer does: every link the sidebar offers a
      // Vietnamese reader now lands in Vietnamese. The rule it used to demonstrate is
      // unchanged and still carries every locale whose own page is missing — a link to
      // the English route, with nothing marking it as a language change beyond the
      // selector that already names the language being read.
      await expect(sidebar.getByRole('link', { name: 'Schemas' })).toHaveAttribute('href', '/vi/schemas/');
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('a translated schema page reads in its language and keeps the schema in English', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/vi/schemas/context-manifest/`);
      expect(response?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
      // The page states the contract in Vietnamese: the classification eyebrow, the
      // field table's own words, and the field descriptions the schema publishes.
      await expect(page.getByRole('main').getByText('spec 1.0 · chuẩn tắc')).toBeVisible();
      const viewerField = page.locator('dt#viewer + dd');
      await expect(viewerField).toContainText('không mang tính chuẩn tắc');
      await expect(page.locator('dt#leji').getByText('bắt buộc')).toBeVisible();
      // The schema tab is the machine surface and is never translated: it prints the
      // published file, which is what tooling fetches from the canonical $id.
      await expect(page.locator('[data-panel="schema"]')).toContainText('"$id": "https://leji.org/schemas/v1.0/');
      // The note, then the selector, then the English page of record for this route.
      const note = page.getByRole('main').getByText(/^Bản dịch có sự hỗ trợ của AI agent/);
      await expect(note.getByRole('link', { name: 'trang tiếng Anh' })).toHaveAttribute(
         'href',
         '/schemas/context-manifest/',
      );
      const selector = page.getByRole('banner').getByRole('group');
      await selector.locator('summary').click();
      await selector.getByRole('link', { name: 'English' }).click();
      await expect(page).toHaveURL(`${SITE_URL}/schemas/context-manifest/`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Leji context manifest (leji.json)');
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('an unknown URL answers 404 with the branded page', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      // The status matters as much as the rendering: a 404 page served with a 200
      // is a soft 404, which is what search engines index and what a link checker
      // reports as healthy.
      const response = await page.goto(`${SITE_URL}/no-such-page/`);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found.');
      await expect(page.getByRole('link', { name: 'the specification' })).toBeVisible();
      // The 404 document load is itself a failed resource load, so the browser
      // reports it: the one error this test asserts, named by the exact URL it
      // came from and the origin that served it.
      expectNoConsoleErrors(errors, [
         ...SITE_CONSOLE_ALLOWANCES,
         resourceNotFoundAllowance(`${SITE_URL}/no-such-page/`, SITE_URL),
      ]);
   });

   // Prose must not run into an inline element. In the built markup a line break
   // between text and a following `<a>`, `<code>`, `<strong>` or `<em>` is dropped,
   // so a template that leans on it renders "reporting.How federation works." or
   // "Usestatus". The pages carry an explicit space instead, and this reads the
   // built HTML of the space-delimited languages to hold them there. Chinese and
   // Japanese are out: they set no space between words.
   test('prose never runs into an inline element on the space-delimited pages', async ({ request }) => {
      /** Classes whose neighbour is placed by layout, so no space belongs in the text. */
      const LAYOUT_CLASSES = [
         'step-num', // the quickstart step number, set beside its step heading
         'doc-seq', // the previous/next bar under a specification page
         'heading-anchor', // the permalink glyph that trails a heading's own text
         'flows', // the rationale figure's line of collaboration modes
         'cta', // the hero's button row, held apart by the flex gap between the buttons
         'sec-edit', // the correction link, whose ::before supplies the separator before it
      ];
      const INLINE = 'a|code|strong|em';
      const CHECKS: { what: string; find: RegExp; mainOnly?: boolean }[] = [
         // A sentence ending, then the element: "reporting.How federation works."
         { what: 'punctuation running into an inline element', find: new RegExp(`[.!?;:,]<(?:${INLINE})\\b`, 'gu') },
         // A word ending, then the element: "Usestatus", "leavesleji.json".
         { what: 'a word running into an inline element', find: new RegExp(`[\\p{L}\\p{N}]<(?:${INLINE})\\b`, 'gu') },
         // The element ending, then a word: "statusto inspect".
         {
            what: 'an inline element running into a word',
            find: new RegExp(`</(?:${INLINE})>(?=[\\p{L}\\p{N}])`, 'gu'),
         },
         // One element ending straight into the next: "tree?adopt", "$id:https://".
         // Read in the page's own <main> alone. The header's nav row, its dropdown
         // menus and the language selector are lists of links laid side by side by
         // CSS, so every neighbouring pair in them is a closing </a> against an
         // opening <a> and none of them wants a space in the text.
         {
            what: 'an inline element running into another inline element',
            find: new RegExp(`</(?:${INLINE})><(?:${INLINE})\\b`, 'gu'),
            mainOnly: true,
         },
      ];
      const routes = ['/', '/quickstart/', '/federation/', '/trademark/', '/rationale/'].flatMap((route) => [
         route,
         ...['es', 'pt-br', 'vi'].map((locale) => `/${locale}${route}`),
      ]);

      const found: string[] = [];
      for (const route of routes) {
         const response = await request.get(`${SITE_URL}${route}`);
         expect(response.status(), route).toBe(200);
         let markup = (await response.text())
            .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
            .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
            .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
            .replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ');
         for (const cls of LAYOUT_CLASSES) {
            markup = markup.replace(
               new RegExp(`<(\\w+)[^>]*class="[^"]*${cls}[^"]*"[^>]*>[\\s\\S]*?</\\1>`, 'gi'),
               ' ',
            );
         }
         const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(markup)?.[1];
         expect(main, `${route} renders no <main>`).toBeDefined();
         for (const { what, find, mainOnly } of CHECKS) {
            const read = mainOnly ? main! : markup;
            for (const match of read.matchAll(find)) {
               const from = Math.max(0, match.index - 50);
               found.push(`${route}: ${what}: ...${read.slice(from, match.index + 50).replace(/\s+/g, ' ')}...`);
            }
         }
      }
      expect(found, `missing space before or after an inline element:\n${found.join('\n')}`).toEqual([]);
   });
});
