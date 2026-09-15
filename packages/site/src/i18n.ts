// The translation registry: one index over the translated page trees.
//
// A translated page joins the alternates and the header selector by existing.
// There is no list to keep in step with the files, and no per-page edit when the
// next translated page arrives: the head tags and the selector both read this
// index, so a page that is not there emits nothing anywhere.
//
// The roster below names every shipping locale up front, before its pages exist,
// so a locale's pages are the only thing its own work adds: a locale with no
// pages yet is simply invisible everywhere, and no two locales ever edit this
// file at the same time.
//
// English is canonical and keeps the unprefixed routes; a locale lives under
// `/<locale>/` with the same route tree beneath it, so the English route of any
// URL is that URL with its locale prefix removed.

import { correctionIndex, correctionLinksFor, type CorrectionLinks } from './correction-links';
import { publishedSchemaNames, schemaRouteFamily } from './schema-i18n';
import { specTranslationRoutes } from './spec-i18n';

/** BCP 47, lowercase. English first: it is the default and the page of record. */
export const LOCALES = ['en', 'zh-hans', 'ja', 'pt-br', 'es', 'vi'] as const;
export type Locale = (typeof LOCALES)[number];

const DEFAULT_LOCALE: Locale = 'en';

/** Each language named in itself, so a reader looking for their own language
 *  finds it in the one script they can read. */
const LOCALE_NAMES: Record<Locale, string> = {
   en: 'English',
   'zh-hans': '简体中文',
   ja: '日本語',
   'pt-br': 'Português (Brasil)',
   es: 'Español',
   vi: 'Tiếng Việt',
};

/** The 404 is not a route: it is served on a miss under whatever URL was asked
 *  for, it is kept out of the sitemap, and it is noindex on both sides. An
 *  alternate or a switch on it would point at a URL nobody navigates to. */
const NOT_A_ROUTE = new Set(['/404']);

/** One glob per translated locale. English is the source tree, so it has none.
 *  The glob argument has to be a literal, and the type makes the set exhaustive:
 *  a locale added to the roster above cannot be left without its own line. A
 *  locale whose directory does not exist yet globs to nothing, which is what
 *  keeps it invisible until its first page lands.
 *
 *  The specification routes are excluded here and read from the collection below:
 *  a locale's `spec/` directory holds one route file that renders whatever the
 *  locale has translated, so it is machinery, not a translation, and counting it
 *  as one would advertise ten routes on the day the first document lands. */
const TRANSLATED_PAGES: Record<Exclude<Locale, 'en'>, Record<string, unknown>> = {
   'zh-hans': import.meta.glob(['./pages/zh-hans/**/*.astro', '!./pages/zh-hans/spec/**']),
   ja: import.meta.glob(['./pages/ja/**/*.astro', '!./pages/ja/spec/**']),
   'pt-br': import.meta.glob(['./pages/pt-br/**/*.astro', '!./pages/pt-br/spec/**']),
   es: import.meta.glob(['./pages/es/**/*.astro', '!./pages/es/spec/**']),
   vi: import.meta.glob(['./pages/vi/**/*.astro', '!./pages/vi/spec/**']),
};

/** The translated specification, which is content rather than pages: one markdown
 *  file per document per locale, rendered by the locale's own route. A locale is
 *  a translation of `/spec/<doc>` by having the document, and of `/spec/full` only
 *  by having every one of them. */
const TRANSLATED_SPEC = import.meta.glob('./content/i18n/*/spec/*.md');

/** The schemas published on the v1.0 line, read from the directory that is their only
 *  source. This module is loaded while the Astro configuration loads, from whatever
 *  directory the site was started in, so the reader locates that directory from its own
 *  module URL rather than from the process working directory. */
const SCHEMA_INVENTORY = publishedSchemaNames();

/** A route file with a `[param]` segment is machinery, not a page: it emits a family of
 *  routes and has no route of its own, so recording its glob key would advertise a URL
 *  nobody can navigate to. What it does emit is recorded from the inventory below. */
const DYNAMIC_ROUTE = /\[[^/]*\]/;

/** `/quickstart/` and `/quickstart` are one route; the root is `/`. */
function routeKey(pathname: string): string {
   const trimmed = pathname.replace(/\/+$/, '');
   return trimmed === '' ? '/' : trimmed;
}

/** `./pages/vi/quickstart.astro` is the `vi` translation of `/quickstart`. */
function routeKeyOfFile(file: string, locale: Locale): string {
   const rel = file
      .slice(`./pages/${locale}`.length)
      .replace(/\.astro$/, '')
      .replace(/\/index$/, '');
   return routeKey(rel);
}

/** English route -> the locales that translate it. */
const TRANSLATIONS = new Map<string, Locale[]>();
function record(key: string, locale: Locale): void {
   TRANSLATIONS.set(key, [...(TRANSLATIONS.get(key) ?? []), locale]);
}
for (const [locale, files] of Object.entries(TRANSLATED_PAGES) as [Locale, Record<string, unknown>][]) {
   for (const file of Object.keys(files)) {
      if (DYNAMIC_ROUTE.test(file)) continue;
      const key = routeKeyOfFile(file, locale);
      if (NOT_A_ROUTE.has(key)) continue;
      record(key, locale);
   }
}
/** The schema reference is a family: one route file emits a page per schema, so the
 *  routes a locale serves are its route file's existence times the inventory. The locale
 *  map is checked content and never evidence that a page is there: delete the route file
 *  and the whole family goes with it, which is what keeps the alternates, the selector
 *  and the sitemap from advertising a page nothing renders. */
const SCHEMA_ROUTES = schemaRouteFamily(
   Object.values(TRANSLATED_PAGES).flatMap((files) => Object.keys(files)),
   SCHEMA_INVENTORY,
);
for (const { locale, routeKey } of SCHEMA_ROUTES) record(routeKey, locale as Locale);
for (const { locale, routeKey } of specTranslationRoutes(Object.keys(TRANSLATED_SPEC))) {
   if (locale === DEFAULT_LOCALE || !(LOCALES as readonly string[]).includes(locale)) {
      throw new Error(`translated specification content for a locale that is not on the roster: ${locale}`);
   }
   record(routeKey, locale as Locale);
}
// Two sources, so insertion order is the order the files happen to be walked in.
// Roster order is the order every list on the site reads in, so it is settled here
// rather than at each of the three places that render one.
for (const [key, locales] of TRANSLATIONS) {
   TRANSLATIONS.set(
      key,
      LOCALES.filter((locale) => locales.includes(locale)),
   );
}

/** The language a URL is served in: the prefix where it names a locale, English
 *  otherwise, since English is the tree without a prefix. */
export function localeOf(pathname: string): Locale {
   const first = routeKey(pathname).split('/')[1];
   return first !== DEFAULT_LOCALE && (LOCALES as readonly string[]).includes(first)
      ? (first as Locale)
      : DEFAULT_LOCALE;
}

/** The English route a URL corresponds to, which is the page of record for it. */
export function englishKey(pathname: string): string {
   const key = routeKey(pathname);
   const locale = localeOf(pathname);
   return locale === DEFAULT_LOCALE ? key : routeKey(key.slice(`/${locale}`.length));
}

/** Directory-style, the shape every link on this site uses. */
function hrefFor(key: string, locale: Locale): string {
   const path = locale === DEFAULT_LOCALE ? key : `/${locale}${key === '/' ? '' : key}`;
   return path.endsWith('/') ? path : `${path}/`;
}

/** One route in one language: the locale's own route where the locale has that page,
 *  and the English route where it does not. English is the page of record and always
 *  exists, so a link out of the chrome never dead-ends and never needs a marker: the
 *  selector beside the logo is what tells a reader which language they are in. */
export function localizedHref(route: string, locale: Locale): string {
   const key = englishKey(route);
   const translated = TRANSLATIONS.get(key)?.includes(locale) ?? false;
   return hrefFor(key, translated ? locale : DEFAULT_LOCALE);
}

/** Whether this route exists in a language other than English. */
export function hasTranslation(pathname: string): boolean {
   return TRANSLATIONS.has(englishKey(pathname));
}

export interface Alternate {
   hreflang: string;
   href: string;
}

/** The `hreflang` set for a route, given the languages it exists in. Split from the
 *  lookup below so the build fixture can render the same head tags over its own
 *  index rather than a copy of this one. */
export function alternatesFor(pathname: string, locales: readonly Locale[]): Alternate[] {
   if (locales.length === 0) return [];
   const key = englishKey(pathname);
   const english = hrefFor(key, DEFAULT_LOCALE);
   return [
      { hreflang: DEFAULT_LOCALE, href: english },
      ...locales.map((locale) => ({ hreflang: locale, href: hrefFor(key, locale) })),
      { hreflang: 'x-default', href: english },
   ];
}

/** The `hreflang` set for a route: every language it exists in, plus
 *  `x-default` pointing at English. Empty where the route is untranslated, so
 *  such a page emits no alternates at all, in either language. */
export function alternates(pathname: string): Alternate[] {
   return alternatesFor(pathname, TRANSLATIONS.get(englishKey(pathname)) ?? []);
}

export interface LocaleOption {
   locale: Locale;
   /** The language named in its own tongue. */
   label: string;
   href: string;
   /** The language the reader is already reading. */
   current: boolean;
}

/** The header selector's entries: English, always, because it is the page of
 *  record, plus every language this route is translated into, in roster order so
 *  the list never reorders itself as pages land. Each entry is a plain link to
 *  the same route in that language, never a redirect.
 *
 *  Empty where the route has no translation at all, which is what hides the
 *  selector rather than showing a reader a list of one. */
export function localeOptions(pathname: string): LocaleOption[] {
   const key = englishKey(pathname);
   const translated = TRANSLATIONS.get(key);
   if (!translated) return [];
   const here = localeOf(pathname);
   const available = new Set<Locale>([DEFAULT_LOCALE, ...translated]);
   return LOCALES.filter((locale) => available.has(locale)).map((locale) => ({
      locale,
      label: LOCALE_NAMES[locale],
      href: hrefFor(key, locale),
      current: locale === here,
   }));
}

// Where a translated page's own text lives, so a reader who finds a mistake is handed
// the file that holds it. The index is built from the same two globs the registry above
// reads, which is what keeps it honest: the file keys are the files, so a link can never
// name a path that is not there. The derivation itself is in `correction-links.ts`,
// where a test can walk it without a build.
const CORRECTIONS = correctionIndex(
   Object.values(TRANSLATED_PAGES).flatMap((files) => Object.keys(files)),
   Object.keys(TRANSLATED_SPEC),
);
// Every page the schema route file emits is corrected in that one file, which is where
// its text lives; the glob key it was indexed under is not a route anybody reads.
for (const { locale, routeKey } of SCHEMA_ROUTES) {
   CORRECTIONS.files.set(`/${locale}${routeKey}`, `pages/${locale}/schemas/[name].astro`);
}

export type { CorrectionDocument, CorrectionLinks } from './correction-links';
// Re-exported rather than imported by each component: the chrome reaches everything
// locale-shaped through this module, and a second edge out of a component would
// reorder what the build inlines on every page for nothing.
export { sentenceGap } from './sentence-gap';

/** The two ways to correct a translated page, derived from the page's own URL: the
 *  prefilled issue form, and the file the text lives in. Nothing is passed in, so no
 *  page carries a link to keep in step with its own path. */
export function correctionLinks(pathname: string): CorrectionLinks {
   const locale = localeOf(pathname);
   if (locale === DEFAULT_LOCALE) throw new Error(`correction links belong to a translated page: ${pathname}`);
   return correctionLinksFor(CORRECTIONS, {
      key: routeKey(pathname),
      locale,
      href: hrefFor(englishKey(pathname), locale),
   });
}
