// Where a translated page's own text lives, and the two ways a reader who finds a
// mistake in it can say so: the repository's issue form, and the file itself on GitHub.
//
// The rules are pure over the file lists the registry globs, for the reason the rest of
// this machinery is: the index is derived from the files that are actually there, so a
// link can never name a path that is not, and the derivation can be walked by a test
// without a build. The registry in `i18n.ts` holds the globs and calls in here.
//
// The `.ts` extension on the import below is deliberate: the tests load this module
// directly under Node, which resolves relative specifiers exactly as written.
import { FULL_SLUG, parseSpecI18nId, specI18nId, specI18nPath, specI18nSlugs } from './spec-i18n.ts';

const REPOSITORY = 'https://github.com/leji-org/leji';

/** One constituent document of a one-page view, with the file that holds it. */
export interface CorrectionDocument {
   /** The specification document, as the content files and the routes name it. */
   doc: string;
   editHref: string;
}

export interface CorrectionLinks {
   /** The repository's new-issue form, with the language and the route in its title. */
   issueHref: string;
   /** The page's own source file. Null on the one-page view, which is composed from ten
    *  files and so has none; its documents carry a link each instead. */
   editHref: string | null;
   /** The one-page view's documents in reading order. Empty on every other page. */
   documents: CorrectionDocument[];
}

/** What the resolver reads: every translated route with the file it is built from, and
 *  the one-page views with the documents they are composed of. */
export interface CorrectionIndex {
   /** Locale route key -> the page or content file, relative to `src/`. */
   files: Map<string, string>;
   /** Locale route key of a one-page view -> its documents, in reading order. */
   fullViews: Map<string, string[]>;
}

/** The route one translated page file serves, keyed as the registry keys routes:
 *  `./pages/vi/quickstart.astro` is `/vi/quickstart` and `./pages/vi/index.astro` is
 *  `/vi`. The 404 is here like any other page: it is left out of the alternates and the
 *  sitemap because nobody navigates to its URL, but a reader does read it, and a reader
 *  who reads it can correct it. */
export function pageRouteKey(file: string): string {
   const key = file
      .replace(/^\.\/pages/, '')
      .replace(/\.astro$/, '')
      .replace(/\/index$/, '');
   if (!/^\/[a-z0-9-]+/.test(key)) throw new Error(`a translated page outside a locale directory: ${file}`);
   return key;
}

/** The index, from the page glob's keys and the translated specification content's. */
export function correctionIndex(pageFiles: string[], specFiles: string[]): CorrectionIndex {
   const files = new Map<string, string>();
   for (const file of pageFiles) files.set(pageRouteKey(file), file.slice('./'.length));

   const docsByLocale = new Map<string, string[]>();
   for (const file of specFiles) {
      const { locale, doc } = parseSpecI18nId(specI18nId(file));
      files.set(routeKey(specI18nPath(locale, doc)), file.slice('./'.length));
      docsByLocale.set(locale, [...(docsByLocale.get(locale) ?? []), doc]);
   }

   const fullViews = new Map<string, string[]>();
   for (const [locale, docs] of docsByLocale) {
      // A locale part way through the specification has no one-page view to link from.
      const slugs = specI18nSlugs(docs);
      if (!slugs.includes(FULL_SLUG)) continue;
      fullViews.set(
         routeKey(specI18nPath(locale, FULL_SLUG)),
         slugs.filter((slug) => slug !== FULL_SLUG),
      );
   }
   return { files, fullViews };
}

/** The route a resolver was asked about: its key, the language it is served in, and its
 *  own directory-style href, which is what the issue title names. */
export interface CorrectionRoute {
   key: string;
   locale: string;
   href: string;
}

/** The links for one translated route. A route the index cannot name a file for throws,
 *  so a page fails the build rather than shipping an invitation that leads nowhere. */
export function correctionLinksFor(index: CorrectionIndex, route: CorrectionRoute): CorrectionLinks {
   const issueHref = `${REPOSITORY}/issues/new?template=translation-correction.md&title=${encodeURIComponent(
      `[${route.locale}] ${route.href}: `,
   )}`;
   const docs = index.fullViews.get(route.key);
   if (!docs) return { issueHref, editHref: editHref(index, route.key), documents: [] };
   return {
      issueHref,
      editHref: null,
      documents: docs.map((doc) => ({ doc, editHref: editHref(index, routeKey(specI18nPath(route.locale, doc))) })),
   };
}

/** GitHub's editor for one file on the default branch. It starts a fork and a pull
 *  request for a reader with no write access, which is every reader. */
function editHref(index: CorrectionIndex, key: string): string {
   const file = index.files.get(key);
   if (!file) throw new Error(`no source file for the translated route ${key}: it cannot invite a correction`);
   return `${REPOSITORY}/edit/main/packages/site/src/${file}`;
}

/** `/vi/spec/` and `/vi/spec` are one route. The registry trims keys the same way. */
function routeKey(pathname: string): string {
   return pathname.replace(/\/+$/, '');
}
