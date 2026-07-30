import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

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

export const collections = { spec, rationale, adoption };
