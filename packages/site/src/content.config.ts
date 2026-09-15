import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { specI18nId } from './spec-i18n';

// Single-sourced from ../spec, loaded in place (nothing is copied).
const spec = defineCollection({
   loader: glob({ pattern: '*.md', base: '../../spec' }),
   schema: z.object({}).passthrough(),
});

const rationale = defineCollection({
   loader: glob({ pattern: 'README.md', base: '../../rationale' }),
   schema: z.object({}).passthrough(),
});

const adoption = defineCollection({
   loader: glob({ pattern: 'README.md', base: '../../adoption' }),
   schema: z.object({}).passthrough(),
});

// Translated renderings of the specification, one document per file, site-owned and
// informative. They never enter ../spec, which stays the single normative source.
//
// `source` is the git blob sha of the English document a translation follows, and it
// is what the drift check compares against the current blob, so it is required and
// checked here rather than trusted. The id is `<locale>/<doc>` so that everything
// reading this collection can name a document and a language in one string.
//
// Exported so the build fixture can declare the same collection over its own content.
export const specI18n = defineCollection({
   loader: glob({
      pattern: '*/spec/*.md',
      base: './src/content/i18n',
      generateId: ({ entry }) => specI18nId(entry),
   }),
   schema: z
      .object({
         source: z.string().regex(/^[0-9a-f]{40}$/, 'source must be the 40-character git blob sha of the English page'),
      })
      .passthrough(),
});

export const collections = { spec, rationale, adoption, specI18n };
