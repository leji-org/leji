// Single source of truth for the spec documents: their canonical reading order
// and curated labels. Imported by the sidebar (SectionNav), the consolidated
// one-page view (spec/full.astro), and the per-document pages (spec/[...slug])
// so titles, navigation, and ordering never drift apart.
export interface SpecDoc {
   id: string;
   label: string;
}

export const SPEC_DOCS: SpecDoc[] = [
   { id: 'readme', label: 'Overview & vocabulary' },
   { id: 'context-layer', label: 'The context layer' },
   { id: 'content-categories', label: 'Content categories' },
   { id: 'boot-profile', label: 'The boot profile' },
   { id: 'machine-readable-surface', label: 'Machine-readable surface' },
   { id: 'decisions', label: 'Decisions' },
   { id: 'governance', label: 'Governance' },
   { id: 'distribution', label: 'Distribution' },
   { id: 'conformance', label: 'Conformance' },
   { id: 'versioning', label: 'Versioning' },
];

const LABELS = new Map(SPEC_DOCS.map((d) => [d.id, d.label]));

// The page title for a single spec document. The overview reads as the spec's
// own front page; every other doc uses its curated label.
export function specDocTitle(id: string): string {
   if (id === 'readme') return 'The Leji Specification';
   return LABELS.get(id) ?? id.replace(/-/g, ' ');
}

export const specPath = (slug: string) => (slug === 'readme' ? '/spec/' : `/spec/${slug}/`);
