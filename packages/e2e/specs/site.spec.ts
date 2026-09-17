// leji.org, as `astro preview` serves the built site. Every selector here is an
// existing role, accessible label, heading, or URL: the suite reads the site as a
// reader does and never asks it to grow a hook for the sake of a test.

import { type Page, expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
   SITE_CONSOLE_ALLOWANCES,
   SITE_DARK_TONES,
   SITE_LIGHT_TONES,
   SITE_URL,
   type SiteSurface,
   assertSiteScheme,
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
      // unchanged and still carries every locale whose own page is missing: a link to
      // the English route, with nothing marking it as a language change beyond the
      // selector that already names the language being read.
      await expect(sidebar.getByRole('link', { name: 'Schemas' })).toHaveAttribute('href', '/vi/schemas/');
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the collapsed menu button keeps its Vietnamese name across a press', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      // The toggle only renders where the header collapses, which the default
      // viewport is too wide for, so the width is part of the case.
      await page.setViewportSize({ width: 600, height: 900 });
      const response = await page.goto(`${SITE_URL}/vi/`);
      expect(response?.status()).toBe(200);
      // The button is named in Vietnamese and stays named that through a press:
      // `aria-expanded` carries open and closed, so the reader is never told the
      // state in a second language by the control they just used.
      const toggle = page.getByRole('banner').getByRole('button', { name: 'Mở menu' });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(toggle).toHaveAccessibleName('Mở menu');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toHaveAccessibleName('Mở menu');
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

// The site paints the operating system's color scheme unless a reader has stored a
// choice of their own: the light palette and the dark one are sheets of their own,
// `packages/site/src/styles/palette.css` and `dark.css`, and the head links the dark
// one under a media query the control rewrites. Neither scheme is a state a page can
// be put into without either the preference or the choice, so both are judged by
// rendering. The unit test holds the palette to its contrast floors; this run holds
// the pages to the palette, on the surfaces a dark theme can leave behind.
//
// Seven routes, chosen for the surfaces they carry between them rather than for
// coverage of the route table: the landing page and a locale's copy of it (the
// monument, its cards and its recessed band), the quickstart (a tip, a table, both
// kinds of code frame), a specification page (prose, a contents box, inline code),
// a schema page (the generated field reference), the translation page (prose alone)
// and the 404.
const SCHEME_SURFACES: { route: string; surfaces: SiteSurface[] }[] = [
   {
      route: '/',
      surfaces: [
         { what: 'the page ground', at: (page) => page.locator('body'), paints: 'background', role: 'canvas' },
         {
            what: 'the wordmark in the header',
            at: (page) => page.getByRole('banner').locator('.leji-logo'),
            paints: 'color',
            role: 'inkOnDeep',
         },
         {
            what: 'the hero headline',
            at: (page) => page.locator('.hero h1'),
            paints: 'color',
            role: 'inkOnDeep',
         },
         {
            what: 'a card on the recessed band',
            at: (page) => page.locator('.ladder li').first(),
            paints: 'background',
            role: 'surface',
         },
         {
            what: 'the recessed band',
            at: (page) => page.locator('.levels-band').first(),
            paints: 'background',
            role: 'wash',
         },
      ],
   },
   {
      route: '/quickstart/',
      surfaces: [
         { what: 'the page ground', at: (page) => page.locator('body'), paints: 'background', role: 'canvas' },
         {
            what: 'the header band',
            at: (page) => page.locator('.site-header-band'),
            paints: 'background',
            role: 'deep',
         },
         {
            what: 'the wordmark in the header',
            at: (page) => page.getByRole('banner').locator('.leji-logo'),
            paints: 'color',
            role: 'inkOnDeep',
         },
         { what: 'the page headline', at: (page) => page.locator('.gs-hero h1'), paints: 'color', role: 'text' },
         { what: 'the tip beside a step', at: (page) => page.locator('.map-note'), paints: 'background', role: 'wash' },
         {
            what: 'a table cell',
            at: (page) => page.locator('.shape-table td').first(),
            paints: 'color',
            role: 'body',
         },
         {
            what: 'inline code in a step',
            at: (page) => page.locator('.step-text code').first(),
            paints: 'background',
            role: 'codeBg',
         },
         {
            what: 'a code block',
            at: (page) => page.locator('.peek-code .astro-code'),
            paints: 'background',
            role: 'deep',
         },
         { what: 'a body link', at: (page) => page.locator('.peek-text a').first(), paints: 'color', role: 'link' },
      ],
   },
   {
      route: '/spec/boot-profile/',
      surfaces: [
         { what: 'the page ground', at: (page) => page.locator('body'), paints: 'background', role: 'canvas' },
         {
            what: 'the header band',
            at: (page) => page.locator('.site-header-band'),
            paints: 'background',
            role: 'deep',
         },
         { what: 'the document heading', at: (page) => page.locator('.prose h1'), paints: 'color', role: 'text' },
         {
            what: 'the contents box',
            at: (page) => page.getByRole('navigation', { name: 'Contents' }),
            paints: 'background',
            role: 'wash',
         },
         {
            what: 'a section-nav group',
            at: (page) => page.getByRole('navigation', { name: 'Documentation' }).locator('summary').first(),
            paints: 'color',
            role: 'body',
         },
         { what: 'a code block', at: (page) => page.locator('.prose pre').first(), paints: 'background', role: 'deep' },
         {
            what: 'inline code in prose',
            at: (page) => page.locator('.prose p > code').first(),
            paints: 'background',
            role: 'codeBg',
         },
         { what: 'a body link', at: (page) => page.locator('.prose p a').first(), paints: 'color', role: 'link' },
      ],
   },
   {
      route: '/schemas/context-manifest/',
      surfaces: [
         { what: 'the page ground', at: (page) => page.locator('body'), paints: 'background', role: 'canvas' },
         {
            what: 'the header band',
            at: (page) => page.locator('.site-header-band'),
            paints: 'background',
            role: 'deep',
         },
         { what: 'the schema heading', at: (page) => page.locator('.prose h1'), paints: 'color', role: 'text' },
         {
            what: 'the published schema, in its frame',
            at: (page) => page.locator('[data-panel="schema"] pre'),
            paints: 'background',
            role: 'deep',
         },
         {
            what: 'a field description',
            at: (page) => page.locator('dt#viewer + dd'),
            paints: 'color',
            role: 'text',
         },
         { what: 'a body link', at: (page) => page.locator('.all-schemas a'), paints: 'color', role: 'link' },
      ],
   },
   {
      route: '/translation/',
      surfaces: [
         { what: 'the page ground', at: (page) => page.locator('body'), paints: 'background', role: 'canvas' },
         {
            what: 'the header band',
            at: (page) => page.locator('.site-header-band'),
            paints: 'background',
            role: 'deep',
         },
         { what: 'the document heading', at: (page) => page.locator('.prose h1'), paints: 'color', role: 'text' },
         {
            what: 'a section-nav group',
            at: (page) => page.getByRole('navigation', { name: 'Documentation' }).locator('summary').first(),
            paints: 'color',
            role: 'body',
         },
         { what: 'a body link', at: (page) => page.locator('.prose li a').first(), paints: 'color', role: 'link' },
      ],
   },
   {
      route: '/vi/',
      surfaces: [
         { what: 'the page ground', at: (page) => page.locator('body'), paints: 'background', role: 'canvas' },
         {
            what: 'the wordmark in the header',
            at: (page) => page.getByRole('banner').locator('.leji-logo'),
            paints: 'color',
            role: 'inkOnDeep',
         },
         { what: 'the hero headline', at: (page) => page.locator('.hero h1'), paints: 'color', role: 'inkOnDeep' },
         {
            what: 'a card on the recessed band',
            at: (page) => page.locator('.ladder li').first(),
            paints: 'background',
            role: 'surface',
         },
         {
            what: 'the recessed band',
            at: (page) => page.locator('.levels-band').first(),
            paints: 'background',
            role: 'wash',
         },
      ],
   },
   {
      route: '/404.html',
      surfaces: [
         { what: 'the page ground', at: (page) => page.locator('body'), paints: 'background', role: 'canvas' },
         {
            what: 'the header band',
            at: (page) => page.locator('.site-header-band'),
            paints: 'background',
            role: 'deep',
         },
         {
            what: 'the wordmark in the header',
            at: (page) => page.getByRole('banner').locator('.leji-logo'),
            paints: 'color',
            role: 'inkOnDeep',
         },
         { what: 'the headline', at: (page) => page.locator('.lost h1'), paints: 'color', role: 'text' },
         { what: 'the copy under it', at: (page) => page.locator('.lost-text'), paints: 'color', role: 'body' },
         { what: 'a body link', at: (page) => page.locator('.lost-text a').first(), paints: 'color', role: 'link' },
      ],
   },
];

// Both schemes over the same reads. The light run is the half that keeps the media
// block from leaking: a dark value reaching a reader who asked for neither theme
// fails here on the value 1.5.0 painted.
for (const [scheme, tones, other] of [
   ['dark', SITE_DARK_TONES, SITE_LIGHT_TONES],
   ['light', SITE_LIGHT_TONES, SITE_DARK_TONES],
] as const) {
   test.describe(`site (${scheme} scheme)`, () => {
      test.use({ colorScheme: scheme });

      for (const { route, surfaces } of SCHEME_SURFACES) {
         test(`${route} paints the ${scheme} scheme on every surface it carries`, async ({ page }) => {
            await assertSiteScheme(page, route, surfaces, tones, other);
         });
      }
   });
}

// --- the reader's own choice ------------------------------------------------------
//
// A reader may keep a scheme of their own, in one key per browser, and the runs below
// are the half the preference cannot reach: a stored choice that opposes the operating
// system, the control cycling through its three states, and the same cycle in a
// browser whose storage refuses to answer.

/** The key the site stores a reader's choice under. */
const APPEARANCE_KEY = 'leji-appearance';
/** The states the control cycles through, in the order it cycles them. */
const SCHEME_STATES = ['System', 'Light', 'Dark'] as const;

/** How the page is arranged for a scheme: the root's stamp, the dark link's media,
 *  and how many further links to the same sheet the pre-paint script wrote. */
async function schemeArrangement(page: Page) {
   return page.evaluate(() => {
      const link = document.getElementById('leji-dark') as HTMLLinkElement | null;
      if (link === null) return null;
      const href = link.getAttribute('href');
      return {
         appearance: document.documentElement.dataset.appearance ?? null,
         media: link.getAttribute('media'),
         written: document.querySelectorAll(`link[rel="stylesheet"][href="${href}"]:not(#leji-dark)`).length,
      };
   });
}

/** The control, addressed the way a reader using a screen reader reaches it: by role
 *  and by the whole accessible name, which carries the state it is in. */
const schemeControl = (page: Page, state: (typeof SCHEME_STATES)[number]) =>
   page.getByRole('button', { name: `Color scheme ${state}` });

/** What the key holds, as the page's own storage reports it. */
const storedChoice = (page: Page) => page.evaluate((key) => localStorage.getItem(key), APPEARANCE_KEY);

const canvasOf = (page: Page) => backgroundOf(page.locator('body'));

for (const [stored, scheme, tones, other] of [
   ['dark', 'light', SITE_DARK_TONES, SITE_LIGHT_TONES],
   ['light', 'dark', SITE_LIGHT_TONES, SITE_DARK_TONES],
] as const) {
   test.describe(`site (stored ${stored} choice)`, () => {
      test.use({ colorScheme: scheme });

      test.beforeEach(async ({ page }) => {
         await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [APPEARANCE_KEY, stored]);
      });

      for (const { route, surfaces } of SCHEME_SURFACES) {
         test(`${route} paints the stored ${stored} scheme under a ${scheme} system`, async ({ page }) => {
            await assertSiteScheme(page, route, surfaces, tones, other);
         });
      }

      test(`the head is arranged for a stored ${stored} choice`, async ({ page }) => {
         await page.goto(`${SITE_URL}/quickstart/`);
         // The control drawn in the stored state is the control script's own signal
         // that it has run, so the arrangement below is read after it, not during it.
         await expect(schemeControl(page, stored === 'dark' ? 'Dark' : 'Light')).toBeVisible();
         expect(await schemeArrangement(page)).toEqual({
            appearance: stored,
            media: 'not all',
            // A stored dark choice needs a sheet that blocks the first paint in every
            // browser, which is the link the pre-paint script writes through the
            // parser. A stored light choice needs no sheet at all.
            written: stored === 'dark' ? 1 : 0,
         });
      });
   });
}

test.describe('site (the stored dark choice is handed back)', () => {
   test.use({ colorScheme: 'light' });

   test.beforeEach(async ({ page }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [APPEARANCE_KEY, 'dark']);
   });

   test('the first click retires the written link and gives the scheme to the static one', async ({ page }) => {
      await page.goto(`${SITE_URL}/quickstart/`);
      await expect(canvasOf(page)).resolves.toBe(rgb(SITE_DARK_TONES.canvas));

      await schemeControl(page, 'Dark').click();

      await expect(schemeControl(page, 'System')).toBeVisible();
      expect(await schemeArrangement(page)).toEqual({
         appearance: null,
         media: '(prefers-color-scheme: dark)',
         written: 0,
      });
      await expect(storedChoice(page)).resolves.toBe(null);
      await expect(canvasOf(page)).resolves.toBe(rgb(SITE_LIGHT_TONES.canvas));
   });
});

test.describe('site (the reader cycles the scheme)', () => {
   test.use({ colorScheme: 'light' });

   test('the control moves through system, light and dark, and the page follows it', async ({ page }) => {
      await page.goto(`${SITE_URL}/`);

      // Nothing stored, so the page arrives on the operating system's scheme and the
      // control says so. Each click then names the state it has moved to, in its
      // accessible name, and the root, the link, the key and the canvas move with it.
      for (const [state, appearance, media, stored, canvas] of [
         ['System', null, '(prefers-color-scheme: dark)', null, SITE_LIGHT_TONES.canvas],
         ['Light', 'light', 'not all', 'light', SITE_LIGHT_TONES.canvas],
         ['Dark', 'dark', 'all', 'dark', SITE_DARK_TONES.canvas],
         ['System', null, '(prefers-color-scheme: dark)', null, SITE_LIGHT_TONES.canvas],
      ] as const) {
         const control = schemeControl(page, state);
         await expect(control).toBeVisible();
         await expect(control).toHaveAttribute('data-appearance', state.toLowerCase());
         expect(await schemeArrangement(page)).toEqual({ appearance, media, written: 0 });
         await expect(storedChoice(page)).resolves.toBe(stored);
         await expect(canvasOf(page)).resolves.toBe(rgb(canvas));
         await control.click();
      }
   });
});

// Storage is a privilege a browser can withdraw, and the control is not allowed to
// stop working when it does: the choice is best-effort, but the cycle is not. Each
// run below replaces the storage methods before any of the page's own scripts run.
test.describe('site (a browser whose storage refuses)', () => {
   test.use({ colorScheme: 'light' });

   /** The tones the three states paint under a light system, in cycling order. */
   const canvasFor = {
      System: SITE_LIGHT_TONES.canvas,
      Light: SITE_LIGHT_TONES.canvas,
      Dark: SITE_DARK_TONES.canvas,
   };

   /** Three clicks from wherever the control started, each asserted as it lands. */
   async function cycleFrom(page: Page, first: (typeof SCHEME_STATES)[number]) {
      let at = SCHEME_STATES.indexOf(first);
      await expect(schemeControl(page, SCHEME_STATES[at])).toBeVisible();
      for (let click = 0; click < 3; click += 1) {
         await schemeControl(page, SCHEME_STATES[at]).click();
         at = (at + 1) % SCHEME_STATES.length;
         const state = SCHEME_STATES[at];
         await expect(schemeControl(page, state)).toBeVisible();
         await expect(canvasOf(page)).resolves.toBe(rgb(canvasFor[state]));
      }
   }

   test('reads and writes that throw leave the control cycling from system', async ({ page }) => {
      await page.addInitScript(() => {
         const refuse = () => {
            throw new DOMException('storage is not available', 'SecurityError');
         };
         for (const method of ['getItem', 'setItem', 'removeItem']) {
            Object.defineProperty(Storage.prototype, method, { value: refuse });
         }
      });
      await page.goto(`${SITE_URL}/`);
      await cycleFrom(page, 'System');
   });

   test('a read that answers dark with writes that throw leaves the control cycling from dark', async ({ page }) => {
      await page.addInitScript(() => {
         const refuse = () => {
            throw new DOMException('storage is not available', 'SecurityError');
         };
         Object.defineProperty(Storage.prototype, 'getItem', { value: () => 'dark' });
         for (const method of ['setItem', 'removeItem']) {
            Object.defineProperty(Storage.prototype, method, { value: refuse });
         }
      });
      await page.goto(`${SITE_URL}/`);
      await cycleFrom(page, 'Dark');
   });

   test('a read that changes after the first one cannot move the control off the page', async ({ page }) => {
      // Storage is read once a page, by the script in the head. A second read here
      // would answer `light` and put the control out of step with the dark page the
      // first read produced, which is why the control reads the root instead.
      await page.addInitScript(() => {
         let reads = 0;
         Object.defineProperty(Storage.prototype, 'getItem', {
            value: () => (reads++ === 0 ? 'dark' : 'light'),
         });
      });
      await page.goto(`${SITE_URL}/`);

      await expect(schemeControl(page, 'Dark')).toBeVisible();
      expect(await schemeArrangement(page)).toEqual({ appearance: 'dark', media: 'not all', written: 1 });
      await expect(canvasOf(page)).resolves.toBe(rgb(SITE_DARK_TONES.canvas));

      await schemeControl(page, 'Dark').click();

      await expect(schemeControl(page, 'System')).toBeVisible();
      expect(await schemeArrangement(page)).toEqual({
         appearance: null,
         media: '(prefers-color-scheme: dark)',
         written: 0,
      });
      await expect(canvasOf(page)).resolves.toBe(rgb(SITE_LIGHT_TONES.canvas));
   });
});

// --- the head of every built page -------------------------------------------------
//
// The three elements have to be on every page, in order, and ahead of the styles the
// bundle appends: a page that lost them would paint the operating system's scheme
// whatever a reader chose, and a page whose palette link landed after the bundle
// would paint the light canvas in dark. Seven routes cannot answer that, so this one
// reads the built inventory from disk, which is the directory the runner serves.

/** The built page inventory. Stated rather than taken from the walk, so a route that
 *  stopped being emitted fails here instead of quietly shrinking the sweep. */
const BUILT_PAGES = 186;

const siteDist = path.resolve(specDir, '..', '..', 'site', 'dist');

function builtPages(dir: string): string[] {
   return fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.html'))
      .map((entry) => path.join(dir, entry));
}

const PALETTE_LINK = /<link rel="stylesheet" href="\/_astro\/palette\.[A-Za-z0-9_-]+\.css">/;
const DARK_LINK =
   /<link id="leji-dark" rel="stylesheet" href="\/_astro\/dark\.[A-Za-z0-9_-]+\.css" media="\(prefers-color-scheme: dark\)">/;
/** Anything the bundle emits: a hashed stylesheet other than the two above, or one of
 *  the blocks Astro inlines instead of linking. */
const BUNDLED = /<style[\s>]|<link rel="stylesheet" href="\/_astro\/(?!palette\.|dark\.)/;

test.describe('site (every built page)', () => {
   test('the head carries the palette, the dark sheet and the script, ahead of the bundle', () => {
      const pages = builtPages(siteDist);
      expect(pages.length, 'the built page inventory').toBe(BUILT_PAGES);

      for (const file of pages) {
         const where = path.relative(siteDist, file);
         const html = fs.readFileSync(file, 'utf8');
         const headEnd = html.indexOf('</head>');
         expect(headEnd, `${where}: no head`).toBeGreaterThan(0);
         const head = html.slice(0, headEnd);

         const palette = head.search(PALETTE_LINK);
         const dark = head.search(DARK_LINK);
         const script = [...head.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi)].find((m) =>
            m[0].includes("getElementById('leji-dark')"),
         );
         const bundled = head.search(BUNDLED);

         expect(palette, `${where}: the palette link`).toBeGreaterThanOrEqual(0);
         expect(dark, `${where}: the dark link`).toBeGreaterThan(palette);
         expect(script?.index, `${where}: the pre-paint script`).toBeGreaterThan(dark);
         expect(bundled, `${where}: a bundled stylesheet`).toBeGreaterThan(script!.index);

         // The root is stamped by the script at runtime and never by the build, so a
         // cached page cannot carry one reader's choice to the next.
         expect(/<html[^>]*data-appearance/.test(html), `${where}: a built-in appearance`).toBe(false);
      }
   });
});
