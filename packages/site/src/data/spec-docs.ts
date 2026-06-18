// Single source of truth for spec documents: reading order and labels, shared by the sidebar, full view, and per-document pages.
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

// Page title for a single spec doc; the overview uses the spec's own title, others their curated label.
export function specDocTitle(id: string): string {
   if (id === 'readme') return 'The Leji Specification';
   return LABELS.get(id) ?? id.replace(/-/g, ' ');
}

export const specPath = (slug: string) => (slug === 'readme' ? '/spec/' : `/spec/${slug}/`);
