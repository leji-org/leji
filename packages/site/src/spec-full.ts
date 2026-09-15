// The one-page view of the specification, shared by the English page and by every
// translation of it. Ten documents, each authored to stand on its own page, have to
// compose into one page that still has a single <h1> and fragment ids nobody has to
// disambiguate. That composition is the same in every language, so it lives here
// rather than once per locale.
import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri';
import { markdownRenderOptions } from './markdown-options';

/** A document to compose, in the order it should appear on the page. */
export interface SpecSectionSource {
   id: string;
   label: string;
   /** The document's own page, which is where its per-heading anchors live. */
   href: string;
   /** The markdown body, as the collection stores it. */
   body: string;
   /** The file the body came from, where there is one. The link rewriter reads the
    *  document's language off it, so a translated section links the reader's own copy
    *  of a page rather than the English one. */
   fileURL?: URL;
}

/** One composed section, ready to place on the page. */
export interface SpecSection extends Omit<SpecSectionSource, 'body' | 'fileURL'> {
   html: string;
}

// Each source doc opens with its own <h1>; demote those to <h2> (and shift deeper headings down) so the page keeps one <h1> and a valid outline.
const shiftHeadings = (html: string) =>
   html.replace(/<(\/?)(h[1-5])\b/gi, (_m, slash: string, tag: string) => {
      const level = Number(tag[1]);
      return `<${slash}h${level + 1}`;
   });

// Each source document is rendered independently, so headings that repeat across
// documents ("Requirements", "Notes (non-normative)") would mint the same id more
// than once on this combined page. Namespace every id and every same-page link
// that targets one by its document, so fragments stay unique and resolvable.
const namespaceIds = (html: string, docId: string) =>
   html
      .replace(/\bid="([^"]+)"/g, (_m, id: string) => `id="${docId}--${id}"`)
      .replace(/\bhref="#([^"]+)"/g, (_m, id: string) => `href="#${docId}--${id}"`);

// Building the processor is the expensive part, and every one-page view on the site
// renders through the same pipeline, so the build pays for it once.
let processor: Promise<Awaited<ReturnType<typeof createSatteriMarkdownProcessor>>> | undefined;

/** Render the given documents as sections of one page, in the order given. */
export async function renderSpecSections(docs: SpecSectionSource[]): Promise<SpecSection[]> {
   processor ??= createSatteriMarkdownProcessor(markdownRenderOptions);
   const markdown = await processor;
   return Promise.all(
      docs.map(async ({ id, label, href, body, fileURL }) => ({
         id,
         label,
         href,
         html: namespaceIds(shiftHeadings((await markdown.render(body, { fileURL })).code), id),
      })),
   );
}
