// The predicates the live viewer and its static export are both judged by, in one
// module both specs import. The parity claim is only worth something if there is
// literally one set of assertions: two files that started identical drift, and a
// suite that has drifted still reports green.

import { expect, type Locator, type Page } from '@playwright/test';

// Fixed ports in a high range, so the base URLs are stable enough for a spec, a
// CI artifact, and a README to name them. `run.mjs` refuses to start when one of
// them is already bound, so a second concurrent run on the same machine stops
// with the port named instead of quietly sharing a server with the first; runs on
// one machine serialize, which is the behavior, not a collision-prevention scheme.
export const VIEWER_URL = 'http://127.0.0.1:23921';
export const STATIC_URL = 'http://127.0.0.1:23922';
export const SITE_URL = 'http://127.0.0.1:23923';

// The same layer again with `viewer.theme.primary` set, live and exported. A second
// copy rather than a second route: the accent reaches CSS at generation time, so
// the only way to judge what a custom accent does to the tones is to generate a
// layer that has one. `run.mjs` prepares the copy and holds these two ports.
export const ACCENT_VIEWER_URL = 'http://127.0.0.1:23924';
export const ACCENT_STATIC_URL = 'http://127.0.0.1:23925';

/** The accent each fixture pair carries: the Leji default (no `viewer.theme`) and
 * the custom one the accent copy declares. Named here so a spec states which layer
 * it is judging instead of repeating a hex. */
export const DEFAULT_ACCENT = '#009F71';
export const CUSTOM_ACCENT = '#2244AA';

/** The fixture layer's name, as `leji.json` declares it. */
const LAYER_NAME = 'fixture';

/**
 * One console error or uncaught page error, with everything an allowance needs to
 * be aimed at it and nothing that would let it spread. `text` alone is not enough:
 * a failed request reaches the console as the bare sentence "Failed to load
 * resource: …", so every 404 in the suite reads identically and a substring
 * allowance written for one would cover them all.
 */
export interface ConsoleEntry {
   /** `error` for a console error, `pageerror` for an uncaught exception. */
   type: 'error' | 'pageerror';
   /** The message, verbatim. */
   text: string;
   /** The page the message was reported on. */
   pageUrl: string;
   /** The resource the message is about, empty when the browser named none. */
   sourceUrl: string;
}

/** A predicate that permits exactly one known entry class. Every allowance in
 * this module is anchored on the message, the resource it names, and the origin
 * of the page it came from, so a new error class can never inherit one. */
export type ConsoleAllowance = (entry: ConsoleEntry) => boolean;

/** A URL's origin, or the empty string for anything that does not parse. */
function originOf(url: string): string {
   try {
      return new URL(url).origin;
   } catch {
      return '';
   }
}

/** Console errors and uncaught page errors, from this page, in order. A page is
 * fresh per test, so the collection is per test with no reset to forget. */
export function collectConsoleErrors(page: Page): ConsoleEntry[] {
   const entries: ConsoleEntry[] = [];
   page.on('console', (message) => {
      if (message.type() !== 'error') return;
      entries.push({ type: 'error', text: message.text(), pageUrl: page.url(), sourceUrl: message.location().url });
   });
   page.on('pageerror', (error) => {
      entries.push({ type: 'pageerror', text: error.message, pageUrl: page.url(), sourceUrl: '' });
   });
   return entries;
}

/** Every console error the page produced, minus the ones the caller has named.
 * The allowances below are the only ones in the suite, and each says why it
 * exists and what would retire it. */
export function expectNoConsoleErrors(entries: ConsoleEntry[], allowed: readonly ConsoleAllowance[] = []): void {
   expect(entries.filter((entry) => !allowed.some((permits) => permits(entry)))).toEqual([]);
}

/** Chromium's wording for a request that answered 404. Matched exactly: a
 * variation is a different message class, and a different message class is not
 * covered by an allowance written for this one. */
const RESOURCE_404 = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

/**
 * A 404 on exactly this resource, reported on a page served by exactly this
 * origin. The two tests that assert a 404 are the only callers: each has already
 * counted and identified its own on the response side, and this keeps the console
 * check from being the one place that would also swallow somebody else's.
 */
export function resourceNotFoundAllowance(resourceUrl: string, pageOrigin: string): ConsoleAllowance {
   return (entry) =>
      entry.type === 'error' &&
      entry.text === RESOURCE_404 &&
      entry.sourceUrl === resourceUrl &&
      originOf(entry.pageUrl) === pageOrigin;
}

/**
 * The viewer chrome is quiet in both flavors, so no console error is allowed on
 * any viewer page, live or exported. The one allowance that stood here (Chromium
 * reporting `frame-ancestors` ignored in a `<meta>` policy, once per page) retired
 * when `templates/viewer/index.html` stopped claiming the directive: the served
 * flavor sends it as a response header, and in an export the host sets it.
 */
export const VIEWER_CONSOLE_ALLOWANCES: readonly ConsoleAllowance[] = [];

/** The site ships analytics-free, so no console error is allowed on any site page. */
export const SITE_CONSOLE_ALLOWANCES: readonly ConsoleAllowance[] = [];

/** The home route renders the layer: its name in the chrome, a populated sidebar,
 * and the seeded overview as the page. */
export async function assertLayerHome(page: Page, base: string): Promise<void> {
   await page.goto(`${base}/#/`);
   await expect(page.locator('.app-name')).toContainText(LAYER_NAME);
   await expect(page.locator('.sidebar-nav')).toBeVisible();
   await expect(page.locator('.sidebar-nav').getByRole('link', { name: 'Boot profile' })).toBeVisible();
   await expect(page.locator('.markdown-section h1').first()).toHaveText(LAYER_NAME);
}

/**
 * A `../`-style link on a nested page routes inside the app, without a reload.
 * Both halves are asserted, because either alone passes for the wrong reason: a
 * full page load also ends up at the right URL, and a marker survives a click
 * that navigated nowhere. So: a marker set on `window` before the click, the
 * hash after it, and the destination's own heading.
 */
export async function assertRelativeLinkInApp(page: Page, base: string): Promise<void> {
   await page.goto(`${base}/#/render/commonmark-core`);
   await expect(page.locator('.markdown-section h1').first()).toBeVisible();
   await page.evaluate(() => {
      (window as unknown as { __lejiSameDocument?: boolean }).__lejiSameDocument = true;
   });
   await page.getByRole('link', { name: 'link to another page' }).click();
   await expect(page).toHaveURL(`${base}/#/domain/overview`);
   await expect(page.locator('.markdown-section h1').first()).toHaveText('Overview');
   const sameDocument = await page.evaluate(
      () => (window as unknown as { __lejiSameDocument?: boolean }).__lejiSameDocument === true,
   );
   expect(sameDocument).toBe(true);
}

/** An image beside a document one directory down actually
 * renders. `naturalWidth` is the assertion because a broken `img` is present,
 * visible, and zero pixels wide. */
export async function assertImageAtDepth(page: Page, base: string): Promise<void> {
   await page.goto(`${base}/#/render/commonmark-core`);
   const image = page.locator('.markdown-section img[alt="A fixture diagram"]');
   await expect(image).toBeVisible();
   await expect.poll(async () => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
}

/**
 * An unknown route renders the in-app not-found page and asks for exactly one
 * thing it cannot have: the missing document. `notFoundPage: false` is what keeps
 * the runtime from issuing a second, always-failing fetch for a `_404.md` no
 * layer ships, so the absence of that request is asserted as directly as the
 * presence of the message.
 */
export async function assertUnknownRouteInApp(page: Page, base: string): Promise<void> {
   const notFound: string[] = [];
   const requested: string[] = [];
   page.on('request', (request) => requested.push(request.url()));
   page.on('response', (response) => {
      if (response.status() === 404) notFound.push(response.url());
   });
   await page.goto(`${base}/#/does-not-exist`);
   await expect(page.locator('.markdown-section h1').first()).toHaveText('404 - Not found');
   expect(notFound).toEqual([`${base}/content/does-not-exist.md`]);
   expect(requested.filter((url) => url.includes('_404'))).toEqual([]);
}

/** A `#RRGGBB` color as the string `getComputedStyle` reports for it. */
function rgb(hex: string): string {
   const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
   return `rgb(${r}, ${g}, ${b})`;
}

/** The color the browser actually paints an element, which is the only form of this
 * question worth asking: a stylesheet says many things about one element, and the
 * cascade decides which of them wins. */
async function colorOf(locator: Locator): Promise<string> {
   await expect(locator).toBeVisible();
   return locator.evaluate((node) => getComputedStyle(node as Element).color);
}

/**
 * The tone contract, judged as pixels rather than as CSS text.
 *
 * Body links and inline code take the fixed accessible green whatever the layer's
 * accent is: that is the whole point of the fixed token, and it is why this runs
 * against a layer with a custom accent as well as one without. The chrome does take
 * the accent, so the active sidebar item is asserted to be exactly it: without that
 * half, a viewer that ignored `viewer.theme.primary` entirely would also pass.
 * Headings and copy are the brand's own typography tones, which no accent touches.
 */
export async function assertTones(page: Page, base: string, { accent }: { accent: string }): Promise<void> {
   await page.goto(`${base}/#/render/commonmark-core`);
   const content = page.locator('.markdown-section');

   // Never `.markdown-section a` unqualified: docsify wraps every heading in an
   // anchor, so the first link on the page is chrome, not body text.
   const link = content.getByRole('link', { name: 'link to another page' });
   expect(await colorOf(link)).toBe(rgb('#007D59'));
   expect(await colorOf(content.locator('p code').first())).toBe(rgb('#007D59'));

   expect(await colorOf(content.locator('h1').first())).toBe(rgb('#183B32'));
   expect(await colorOf(content.locator('p').first())).toBe(rgb('#4D5B56'));

   // The document's own sidebar entry, which docsify marks active on arrival. The
   // outer entry comes first in document order; the in-page heading list nested
   // under it takes the accent from the same rule.
   expect(await colorOf(page.locator('.sidebar-nav li.active > a').first())).toBe(rgb(accent));
}

/** The generated Manifest page: chrome that lives outside the content tree and is
 * reached through it, so it is the one page a broken content mount still hides. */
export async function assertManifestPage(page: Page, base: string): Promise<void> {
   await page.goto(`${base}/#/_manifest`);
   await expect(page.locator('.markdown-section h1').first()).toHaveText(`${LAYER_NAME}: Manifest`);
   await expect(page.locator('.markdown-section').getByRole('heading', { name: 'Identity' })).toBeVisible();
   await expect(page.locator('.markdown-section')).toContainText('Fixture Owner');
}
