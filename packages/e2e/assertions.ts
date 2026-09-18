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

// The same layer once more per scheme a layer can name through
// `viewer.theme.appearance`, live. A stamped page renders its scheme on every
// system, so judging it means a layer that names one and an emulated system that
// says the opposite. Served only: what the stamp puts on the page is decided at
// generation time and the SDK suites pin the exported flavor.
export const LIGHT_VIEWER_URL = 'http://127.0.0.1:23926';
export const DARK_VIEWER_URL = 'http://127.0.0.1:23927';

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
export function rgb(hex: string): string {
   const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
   return `rgb(${r}, ${g}, ${b})`;
}

/** The color the browser actually paints an element, which is the only form of this
 * question worth asking: a stylesheet says many things about one element, and the
 * cascade decides which of them wins. */
export async function colorOf(locator: Locator): Promise<string> {
   await expect(locator).toBeVisible();
   return locator.evaluate((node) => getComputedStyle(node as Element).color);
}

/** The color the browser actually paints behind an element, asked for the same reason
 * as `colorOf`: a ground can be set by a token, a rule further down, or neither. */
export async function backgroundOf(locator: Locator): Promise<string> {
   await expect(locator).toBeVisible();
   return locator.evaluate((node) => getComputedStyle(node as Element).backgroundColor);
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

/**
 * The grounds and tones one color scheme paints, named by what each one is for.
 *
 * Where `viewer.theme.appearance` is absent or `system`, the viewer follows the
 * operating system and nothing else, so a scheme is not a state the page can be put
 * into: it is judged by running the page under an emulated preference and reading
 * what the browser paints. Most of these resolve through a token the stylesheet
 * re-values, and two do not: the striped table row and the text inside a fenced
 * block are stock literals in light, which the dark block has to override by
 * selector.
 */
export interface SchemeTones {
   /** The content ground, painted on `body`. */
   page: string;
   /** The sidebar and the panels that share its canvas. */
   paper: string;
   /** The striped table row. */
   stripe: string;
   /** The ground under a fenced block. */
   codeBg: string;
   /** Headings and emphasis. */
   text: string;
   /** Every normal-size run of copy, table cells included. */
   body: string;
   /** The text inside a fenced block. */
   codeText: string;
   /** Body links and inline code. */
   link: string;
}

/** What 1.5.0 painted, which a reader on a light system still sees. */
export const LIGHT_TONES: SchemeTones = {
   page: '#FFFFFF',
   paper: '#F7F8F5',
   stripe: '#F8F8F8',
   codeBg: '#E8F4EE',
   text: '#183B32',
   body: '#4D5B56',
   codeText: '#525252',
   link: '#007D59',
};

/** What a reader on a dark system sees instead. */
export const DARK_TONES: SchemeTones = {
   page: '#131A19',
   paper: '#1B2422',
   stripe: '#1B2422',
   codeBg: '#161E1D',
   text: '#F2F4F3',
   body: '#C5CCCA',
   codeText: '#C5CCCA',
   link: '#70D8C2',
};

/**
 * Every surface the scheme has to reach, judged as pixels.
 *
 * The surfaces are the ones a dark palette can leave behind: the content ground,
 * the sidebar, a fenced block and its text, a table cell and the striped row under
 * it, a body link, inline code, and a heading. A white ground surviving anywhere in
 * dark, or a dark value leaking into light, fails here and names the surface.
 */
export async function assertSchemeSurfaces(
   page: Page,
   base: string,
   tones: SchemeTones,
   other: SchemeTones,
): Promise<void> {
   // The two palettes share no value, so asserting a surface is one scheme's tone is
   // also a refutation of the other's. Stated once, rather than twice per surface.
   for (const surface of Object.keys(tones) as (keyof SchemeTones)[]) {
      expect(tones[surface], `${surface} differs between the two schemes`).not.toBe(other[surface]);
   }

   // Tables carry the most surfaces per page: cells, the stripe, inline code, and a
   // body link, all on the content ground with the sidebar beside them.
   await page.goto(`${base}/#/render/tables`);
   const content = page.locator('.markdown-section');
   expect(await backgroundOf(page.locator('body'))).toBe(rgb(tones.page));
   expect(await backgroundOf(page.locator('.sidebar'))).toBe(rgb(tones.paper));
   expect(await colorOf(content.locator('h1').first())).toBe(rgb(tones.text));
   expect(await colorOf(content.locator('table td').first())).toBe(rgb(tones.body));
   expect(await backgroundOf(content.locator('table tr:nth-child(2n)').first())).toBe(rgb(tones.stripe));
   expect(await colorOf(content.getByRole('link', { name: 'the boot profile' }))).toBe(rgb(tones.link));
   expect(await colorOf(content.locator('td code').first())).toBe(rgb(tones.link));

   // The fenced-code panel is the one ground the tables page does not carry.
   await page.goto(`${base}/#/render/code-blocks`);
   const fenced = content.locator('pre').first();
   expect(await backgroundOf(fenced)).toBe(rgb(tones.codeBg));
   expect(await colorOf(fenced.locator('code'))).toBe(rgb(tones.codeText));
}

/**
 * The fill of the first flowchart node's shape, or nothing while a re-render has
 * the diagram out of the document.
 *
 * Mermaid bakes its palette into the SVG it writes, so a stylesheet cannot re-theme
 * a rendered diagram and the shape's own fill is the only place a scheme change can
 * land. The read is bounded, so the waiting happens in the poll around it rather
 * than in one evaluation that would hold the whole test.
 */
async function diagramFill(page: Page): Promise<string> {
   const shape = page.locator('.mermaid[data-processed] svg g.node rect').first();
   return shape
      .evaluate((node) => getComputedStyle(node as Element).fill, undefined, { timeout: 1_000 })
      .catch(() => '');
}

/**
 * A rendered diagram follows a scheme change, without a reload and without losing
 * its content.
 *
 * Both halves matter and neither implies the other. A diagram whose fills never
 * move has silently kept one scheme's palette on the other's page; a diagram
 * re-rendered from an element whose source was consumed comes back empty, which is
 * how a re-render that reads only the processed marker fails. So the fill is
 * asserted at each of the three steps and the label is asserted to survive them.
 *
 * The nodes take the layer's own accent in light, and a fixed palette in dark,
 * because an accent that reads on white need not read on the dark ground. That
 * makes this an assertion about a layer with no `viewer.theme.primary` of its own.
 */
export async function assertDiagramFollowsScheme(page: Page, base: string): Promise<void> {
   await page.emulateMedia({ colorScheme: 'light' });
   await page.goto(`${base}/#/render/mermaid`);

   const label = page.locator('.mermaid[data-processed] svg').first().getByText('Boot profile');
   await expect(label).toBeVisible();
   expect(await diagramFill(page)).toBe(rgb(DEFAULT_ACCENT));

   await page.emulateMedia({ colorScheme: 'dark' });
   await expect.poll(() => diagramFill(page)).toBe(rgb(DARK_TONES.paper));
   await expect(label).toBeVisible();

   await page.emulateMedia({ colorScheme: 'light' });
   await expect.poll(() => diagramFill(page)).toBe(rgb(DEFAULT_ACCENT));
   await expect(label).toBeVisible();
}

/**
 * A layer that names its own color scheme paints that scheme, on a system saying
 * the opposite, and keeps it when the system changes under the open page.
 *
 * Both halves are the claim. The surfaces say the scheme arrived; the diagram says
 * it reached the one place CSS cannot go, mermaid having baked its palette into the
 * SVG at render time. The switch afterwards is what separates a page that named a
 * scheme from one that merely happens to agree with the system it loaded under: a
 * stamped page has no listener to follow, and nothing on it moves.
 */
export async function assertStampedScheme(page: Page, base: string, stamped: 'light' | 'dark'): Promise<void> {
   const tones = stamped === 'dark' ? DARK_TONES : LIGHT_TONES;
   const other = stamped === 'dark' ? LIGHT_TONES : DARK_TONES;
   // The nodes take the layer's accent in light and the fixed dark ground in dark,
   // exactly as they do when the reader's system chooses; the fixture declares no
   // accent of its own, so the light value is the Leji default.
   const fill = rgb(stamped === 'dark' ? DARK_TONES.paper : DEFAULT_ACCENT);

   await assertSchemeSurfaces(page, base, tones, other);
   await page.goto(`${base}/#/render/mermaid`);
   const label = page.locator('.mermaid[data-processed] svg').first().getByText('Boot profile');
   await expect(label).toBeVisible();
   expect(await diagramFill(page)).toBe(fill);

   // The reader's system moves under the open page, to the opposite of whatever it
   // started as: the flip is read off the page rather than assumed from `stamped`,
   // because the describe block is what set the starting scheme and a flip computed
   // from the wrong end lands back on it, leaving nothing switched and the
   // assertions below true of a page that never moved.
   const systemPrefersDark = (): Promise<boolean> =>
      page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
   const before = await systemPrefersDark();
   await page.emulateMedia({ colorScheme: before ? 'light' : 'dark' });
   expect(await systemPrefersDark(), 'the emulated system scheme actually changed').toBe(!before);

   // A layer that named its scheme does not follow the system it now disagrees with,
   // and the diagram is still the one it rendered.
   //
   // The wait is what makes that an assertion rather than a coincidence: a page that
   // wrongly followed the system would re-render its diagram within about 130ms, so
   // a read taken immediately can still be looking at the old fill and pass. Waiting
   // past that window is how "nothing moved" is asked of a change that would arrive
   // late, the mirror of the polling that asserts a change does arrive.
   await page.waitForTimeout(1_000);
   expect(await diagramFill(page)).toBe(fill);
   await expect(label).toBeVisible();
   await assertSchemeSurfaces(page, base, tones, other);
}

/** The generated Manifest page: chrome that lives outside the content tree and is
 * reached through it, so it is the one page a broken content mount still hides. */
export async function assertManifestPage(page: Page, base: string): Promise<void> {
   await page.goto(`${base}/#/_manifest`);
   await expect(page.locator('.markdown-section h1').first()).toHaveText(`${LAYER_NAME}: Manifest`);
   await expect(page.locator('.markdown-section').getByRole('heading', { name: 'Identity' })).toBeVisible();
   await expect(page.locator('.markdown-section')).toContainText('Fixture Owner');
}

/** The generated Decisions page: the same class of chrome, judged on the row it is
 * for, which is the fixture layer's one decision record, rendered as a linked title
 * with the status the record's frontmatter declares. */
export async function assertDecisionsPage(page: Page, base: string): Promise<void> {
   await page.goto(`${base}/#/_decisions`);
   await expect(page.locator('.markdown-section h1').first()).toHaveText(`${LAYER_NAME}: Decisions`);
   const row = page.locator('.markdown-section table tbody tr').filter({ hasText: 'Adopt the Leji context layer' });
   await expect(row).toHaveCount(1);
   await expect(row.getByRole('link', { name: 'Adopt the Leji context layer' })).toBeVisible();
   await expect(row).toContainText('accepted');
}

// --- the site, in both color schemes ---------------------------------------------
//
// leji.org follows the operating system too, through a dark sheet of its own linked
// under a media query, and adds what the viewer has no reader to offer it: a control
// that stores a scheme for the browser. Both are judged the way the viewer is, under
// an emulated preference and, where a choice is stored, with the key seeded before
// the page loads, by the color the browser actually paints. The palette is the
// viewer's family on the site's own grounds, so the roles below are the site's
// names for it, not a second copy of the viewer's set.

/** The grounds and tones one color scheme paints on leji.org, by role. */
export interface SiteTones {
   /** The page itself. */
   canvas: string;
   /** Cards and panels lifted off the page. */
   surface: string;
   /** The recessed wash behind an info block, a tip, or a contents box. */
   wash: string;
   /** The deep-green bands: the header, the hero, and every code frame. */
   deep: string;
   /** Inline code. */
   codeBg: string;
   /** Headings and emphasis. */
   text: string;
   /** Running copy, table cells included. */
   body: string;
   /** Body links and small interactive labels. */
   link: string;
   /** Lettering on a deep band, which is deep in both schemes. */
   inkOnDeep: string;
}

/** What 1.5.0 painted, which a reader on a light system still sees. */
export const SITE_LIGHT_TONES: SiteTones = {
   canvas: '#F7F8F5',
   surface: '#FFFFFF',
   wash: '#F6F1E0',
   deep: '#183D3B',
   codeBg: '#F1EDE2',
   text: '#183B32',
   body: '#4D5B56',
   link: '#007D59',
   inkOnDeep: '#FFFFFF',
};

/** What a reader on a dark system sees instead. */
export const SITE_DARK_TONES: SiteTones = {
   canvas: '#131A19',
   surface: '#1B2422',
   wash: '#161E1D',
   deep: '#0E1413',
   codeBg: '#0E1413',
   text: '#F2F4F3',
   body: '#C5CCCA',
   link: '#70D8C2',
   inkOnDeep: '#F2F4F3',
};

/**
 * One surface a page carries: where it is, whether the scheme reaches it as a
 * ground or as lettering, and which role its value has to be.
 *
 * A page is named by the surfaces it actually has rather than by a set every page
 * must grow: the landing page has no prose table and a specification page has no
 * hero, and a shared list would have to be the intersection, which is the page
 * ground and nothing else.
 */
export interface SiteSurface {
   /** What the surface is, so a failure names it. */
   what: string;
   /** Where it is on the page under test. */
   at: (page: Page) => Locator;
   /** Whether the read is the ground behind it or the text on it. */
   paints: 'background' | 'color';
   /** The role the painted value has to play in the scheme in force. */
   role: keyof SiteTones;
}

/**
 * Every surface a route carries, judged as pixels under the scheme in force.
 *
 * The scheme a page arrives in is arranged before it loads: the page is loaded under
 * an emulated operating-system preference, with the key seeded first where the run is
 * about a stored choice, and what the browser paints is the answer. A light ground
 * surviving anywhere in dark, or a dark value leaking into light, fails here and
 * names the surface it was read on.
 */
export async function assertSiteScheme(
   page: Page,
   route: string,
   surfaces: readonly SiteSurface[],
   tones: SiteTones,
   other: SiteTones,
): Promise<void> {
   // The two palettes give every role a different value, so asserting a surface is
   // one scheme's tone is also a refutation of the other's. Stated once, rather
   // than twice per surface.
   for (const { role } of surfaces) {
      expect(tones[role], `${role} differs between the two schemes`).not.toBe(other[role]);
   }

   const response = await page.goto(`${SITE_URL}${route}`);
   expect(response?.status(), route).toBe(200);
   for (const { what, at, paints, role } of surfaces) {
      const painted = paints === 'background' ? await backgroundOf(at(page)) : await colorOf(at(page));
      expect(painted, `${route}: ${what}`).toBe(rgb(tones[role]));
   }
}
