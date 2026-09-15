// The shape every locale's translated specification is built from: one route per
// translated document, plus the locale's one-page view once the locale has them all.
//
// A translated specification page is an informative rendering of the English
// document it names, never a second source of the normative text, which stays the
// single-sourced English `spec/*.md`. So the pages carry the translation banner and
// emit no article metadata that would present them as the specification itself.
//
// Everything here is pure but for the two functions that read the collection, which
// keeps the module loadable on its own: the translation registry imports it, and the
// registry is read while the build configuration loads, before `astro:content` exists.
//
// The `.ts` extension on the import below is deliberate: the tests load this module
// directly under Node, which resolves relative specifiers exactly as written.
import { SPEC_DOCS, specDocTitle } from './data/spec-docs.ts';

/** A `specI18n` collection entry, in the shape this module reads. */
export interface SpecI18nEntry {
   /** `<locale>/<doc>`. */
   id: string;
   /** `source` is the git blob sha of the English document this translation follows. */
   data: { source: string };
   body?: string;
}

/** The slug of the locale's one-page view, which is a generated route rather than a
 *  page of its own: a locale that is missing a document never emits it. */
export const FULL_SLUG = 'full';

const SPEC_DOC_IDS = new Set(SPEC_DOCS.map((doc) => doc.id));

/** The parts of a translated specification document's id. This is the one parser:
 *  the collection, the route builder and the translation registry all read ids
 *  through it, so a malformed id or a document the specification does not have fails
 *  the build instead of advertising a route nobody can reach. */
export function parseSpecI18nId(id: string): { locale: string; doc: string } {
   const parts = /^([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(id);
   if (!parts) throw new Error(`translated specification id is not <locale>/<doc>: ${id}`);
   const [, locale, doc] = parts;
   if (!SPEC_DOC_IDS.has(doc)) throw new Error(`translated specification id names no specification document: ${id}`);
   return { locale, doc };
}

/** The collection id of a content file, which lives at `<locale>/spec/<doc>.md`. */
export function specI18nId(file: string): string {
   const parts = /(?:^|\/)([^/]+)\/spec\/([^/]+)\.md$/.exec(file);
   if (!parts) throw new Error(`translated specification content is not <locale>/spec/<doc>.md: ${file}`);
   return `${parts[1]}/${parts[2]}`;
}

/** `/<locale>/spec/…`, which mirrors the English route tree beneath the prefix. */
export function specI18nPath(locale: string, slug: string): string {
   return slug === 'readme' ? `/${locale}/spec/` : `/${locale}/spec/${slug}/`;
}

/** The English route a translated specification slug mirrors, without its trailing
 *  slash: the key the translation registry indexes by. */
function englishSpecRouteKey(slug: string): string {
   return slug === 'readme' ? '/spec' : `/spec/${slug}`;
}

/** The slugs one locale's route emits, in reading order, from the documents it has.
 *
 *  The one-page view is emitted only when the locale's documents are exactly the
 *  specification's, so a locale part way through translating never advertises a
 *  one-page view with documents missing from it. A document that is not in the
 *  specification, or translated twice, fails the build rather than being dropped. */
export function specI18nSlugs(docs: string[]): string[] {
   const present = new Set<string>();
   for (const doc of docs) {
      if (!SPEC_DOC_IDS.has(doc))
         throw new Error(`translated specification document is not in the specification: ${doc}`);
      if (present.has(doc)) throw new Error(`translated specification document appears twice in one locale: ${doc}`);
      present.add(doc);
   }
   const slugs = SPEC_DOCS.filter((doc) => present.has(doc.id)).map((doc) => doc.id);
   return present.size === SPEC_DOCS.length ? [...slugs, FULL_SLUG] : slugs;
}

/** Every route the translated specification content adds, read from the content file
 *  paths. The site's registry and the build fixture both index translations with it. */
export function specTranslationRoutes(files: string[]): { locale: string; routeKey: string }[] {
   const byLocale = new Map<string, string[]>();
   for (const file of files) {
      const { locale, doc } = parseSpecI18nId(specI18nId(file));
      byLocale.set(locale, [...(byLocale.get(locale) ?? []), doc]);
   }
   return [...byLocale].flatMap(([locale, docs]) =>
      specI18nSlugs(docs).map((slug) => ({ locale, routeKey: englishSpecRouteKey(slug) })),
   );
}

/** What one locale's specification route renders. */
export interface SpecI18nPageProps {
   locale: string;
   /** The document this page renders, or null on the one-page view. */
   entry: SpecI18nEntry | null;
   /** Every document in reading order, on the one-page view; null otherwise. */
   entries: SpecI18nEntry[] | null;
}

/** The static paths for one locale's specification route. A locale with no
 *  translated documents yet emits nothing at all, which is what keeps its route file
 *  inert until its content lands. */
export async function getSpecI18nStaticPaths(
   locale: string,
): Promise<{ params: { slug: string | undefined }; props: SpecI18nPageProps }[]> {
   const { getCollection } = await import('astro:content');
   const mine = ((await getCollection('specI18n')) as unknown as SpecI18nEntry[]).filter(
      (entry) => parseSpecI18nId(entry.id).locale === locale,
   );
   const byDoc = new Map(mine.map((entry) => [parseSpecI18nId(entry.id).doc, entry]));
   return specI18nSlugs(mine.map((entry) => parseSpecI18nId(entry.id).doc)).map((slug) =>
      slug === FULL_SLUG
         ? {
              params: { slug: FULL_SLUG },
              props: { locale, entry: null, entries: SPEC_DOCS.map((doc) => byDoc.get(doc.id)!) },
           }
         : {
              params: { slug: slug === 'readme' ? undefined : slug },
              props: { locale, entry: byDoc.get(slug)!, entries: null },
           },
   );
}

/** The rendered body of one translated document. Here rather than in each locale's
 *  route file so that nothing outside this module has to reach into the collection to
 *  render what this module handed it. */
export async function renderSpecI18nEntry(entry: SpecI18nEntry) {
   const { render } = await import('astro:content');
   return render(entry as never);
}

/** The one-page view's sections, composed exactly as the English one-page view is. The
 *  body is handed over with the place it was collected from, because a body on its own
 *  says nothing about the language it is in and the link rewriter has to know. The
 *  collection's own base is `src/content/i18n`, so the path below is where the document
 *  lives beside this module in the source tree; what reads it reads the locale segment,
 *  not the file, which a bundled build has moved. */
export async function buildSpecI18nFull(locale: string, entries: SpecI18nEntry[]) {
   const { renderSpecSections } = await import('./spec-full.ts');
   return renderSpecSections(
      entries.map((entry) => {
         const { doc } = parseSpecI18nId(entry.id);
         return {
            id: doc,
            label: specDocTitle(doc),
            href: specI18nPath(locale, doc),
            body: entry.body ?? '',
            fileURL: new URL(`./content/i18n/${locale}/spec/${doc}.md`, import.meta.url),
         };
      }),
   );
}
