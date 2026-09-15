// The site's navigation chrome in English: every label the header menu band and the
// section side-nav render, visible text and accessible labels alike, plus the sidebar's
// name for each specification document.
//
// One typed module rather than an English locale file, for two reasons. English is the
// page of record, so its labels are the definition and not a translation of anything;
// and this is the key inventory every other locale's set is checked against, so a label
// added here without a translation fails the build instead of quietly shipping English
// on a translated page.
//
// Keys are one per label, not one per destination: two places sharing a key share it
// only where the word plays the same part, because a language that inflects it will not
// have a heading and a link stay identical the way English does.

import { SPEC_DOCS } from './spec-docs';

export const NAV_LABELS = {
   /** The logo, which leads to the home page in the language being read. */
   home: 'Leji home',
   /** The button that opens the menu band where the header is collapsed. */
   openMenu: 'Open menu',
   /** The header's menu band, as a navigation landmark. */
   primary: 'Primary',
   /** The section side-nav, as a navigation landmark. */
   documentation: 'Documentation',
   /** The language selector, which names the language being read. `{language}` is
    *  that language named in its own tongue, so it is never itself translated. */
   language: 'Language: {language}',

   /** The menu band. */
   quickstart: 'Quickstart',
   spec: 'Spec',
   adopt: 'Adopt',
   adoptionGuide: 'Adoption guide',
   federation: 'Federation',
   reference: 'Reference',
   manifest: 'Manifest',
   schemas: 'Schemas',
   cli: 'CLI',
   mcp: 'MCP server',
   rationale: 'Rationale',

   /** The side-nav: its three group headings, then the entries the menu band has no
    *  label for. `specification` is the heading over the documents, which the band's
    *  shorter `spec` link cannot stand in for; `manifestFile` names the file the page
    *  documents, where the band names the concept. */
   specification: 'Specification',
   resources: 'Resources',
   onePage: 'One page',
   manifestFile: 'Manifest (leji.json)',
   agentReady: 'Agent-ready',
   aiNative: 'AI-native teams',
   trust: 'Trust',
   translation: 'Translation',
} as const;

/** Every label a locale authors. */
export type NavKey = keyof typeof NAV_LABELS;

/** One locale's navigation chrome: every label above, plus the side-nav's name for
 *  each specification document, keyed by its `SPEC_DOCS` id. */
export type NavStrings = Record<NavKey, string> & { specDocs: Record<string, string> };

/** The inventory a locale's set is validated against. */
export const NAV_KEYS = Object.keys(NAV_LABELS) as NavKey[];

/** English, in the shape a locale authors, so both components render one thing. */
export const ENGLISH_NAV: NavStrings = {
   ...NAV_LABELS,
   specDocs: Object.fromEntries(SPEC_DOCS.map((doc) => [doc.id, doc.label])),
};
