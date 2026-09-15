// The strings the shared translation chrome renders: the canonical note that every
// translated page carries under its title, and the informative banner on a translated
// specification page.
//
// This is page copy, not configuration, so a locale authors its own file here and that
// file is approved with the locale's pages. Nothing falls back to English: a locale
// with no file, or with a string missing, fails the build rather than shipping copy
// nobody approved. `en.reference.json` beside these files documents what each string
// means and what the English page says; it is outside the glob below and is never
// rendered, so it can never become that fallback.

import { CHROME_KEYS, type ChromeStrings, ENGLISH_CHROME } from '../chrome-labels';
import { ENGLISH_FOOTER, FOOTER_KEYS, type FooterStrings } from '../footer-labels';
import { ENGLISH_NAV, NAV_KEYS, type NavStrings } from '../nav-labels';
import {
   PAGE_KIND_KEYS,
   PAGE_KIND_LABELS,
   type PageKindStrings,
   SCHEMA_LABEL_KEYS,
   SCHEMA_LABELS,
   type SchemaStrings,
} from '../schema-labels';

/** The canonical note every translated page carries under its title: how it was made,
 *  which text governs, and how a reader who finds a mistake corrects it. */
export interface NoteStrings {
   /** The second sentence: which text governs where the two differ. `{link}` is the
    *  English page. */
   template: string;
   /** The text of the link to the English page. */
   linkText: string;
   /** The first sentence: how the translation was made. No placeholder. */
   made: string;
   /** The third sentence: the invitation to correct the page. `{issue}` and `{edit}`
    *  are the two links. */
   corrections: string;
   /** The same invitation on the one-page view, whose pull requests are per document
    *  rather than one for the page: `{issue}` only. */
   correctionsFull: string;
   /** The text of the link inside `corrections` and `correctionsFull` that opens a
    *  new issue. */
   issueLinkText: string;
   /** The text of the link inside `corrections`, and beside each document's heading on
    *  the one-page view, that opens the source file for editing. */
   editLinkText: string;
}

/** The banner on a translated specification page, which says the page is an
 *  informative translation and names the normative English document. */
export interface SpecBannerStrings {
   /** `{link}` is the normative English page. */
   template: string;
   /** The one-page view, which renders ten documents rather than one: `{link}` is the
    *  English one-page view and the sentence is plural. */
   fullTemplate: string;
   /** The text of the link to the normative English page. */
   linkText: string;
}

export interface TranslationStrings {
   note: NoteStrings;
   /** Present once the locale translates the specification. */
   specBanner?: SpecBannerStrings;
   /** The navigation chrome, which every locale carries in full: the header and the
    *  side-nav are on every page, so a locale missing one label would show it in
    *  English beside its own. */
   nav: NavStrings;
   /** The footer, which every locale carries in full for the same reason: it closes
    *  every page, so a locale missing one label would show it in English beside its
    *  own. */
   footer: FooterStrings;
   /** The shared chrome outside those two, which every locale carries in full for the
    *  same reason: a skip link, a header link, a runtimes label and two copy buttons
    *  are on pages every locale ships, so a locale missing one would show it in
    *  English beside its own. */
   chrome: ChromeStrings;
   /** The schema reference's own words. Present once the locale translates the schema
    *  pages; see the rule on `chromeGroup` below. */
   schema?: SchemaStrings;
   /** The classification eyebrow every page carries above its title. Same rule. */
   pageKinds?: PageKindStrings;
}

/** One file per locale. The reference file is excluded by pattern, not by convention:
 *  what is not in this glob cannot be rendered by anything. */
const FILES = import.meta.glob<TranslationStrings>(['./*.json', '!./*.reference.json'], {
   eager: true,
   import: 'default',
});

function requireStrings(locale: string, group: string, value: unknown, keys: string[]): void {
   for (const key of keys) {
      const text = (value as Record<string, unknown> | undefined)?.[key];
      if (typeof text !== 'string' || text.trim() === '') {
         throw new Error(`src/data/i18n/${locale}.json is missing ${group}.${key}`);
      }
   }
}

function rejectUnknown(locale: string, group: string, value: object, keys: readonly string[]): void {
   for (const key of Object.keys(value)) {
      if (!keys.includes(key)) throw new Error(`src/data/i18n/${locale}.json has an unknown ${group}.${key}`);
   }
}

/** The note, whole. A locale that kept a key this contract no longer has, or is missing
 *  one it gained, fails the build rather than rendering a sentence half in place. */
const NOTE_KEYS = [
   'template',
   'linkText',
   'made',
   'corrections',
   'correctionsFull',
   'issueLinkText',
   'editLinkText',
] as const;

const SPEC_BANNER_KEYS = ['template', 'fullTemplate', 'linkText'] as const;

/** The revision a translation follows is the drift gate's input and is never shown to a
 *  reader, so a strings file that still places it fails the build: the placeholder would
 *  otherwise render as its own literal text on the page. */
function rejectRevision(locale: string, group: string, value: object): void {
   for (const [key, text] of Object.entries(value)) {
      if (typeof text === 'string' && text.includes('{revision}')) {
         throw new Error(`src/data/i18n/${locale}.json places {revision} in ${group}.${key}: revisions are not shown`);
      }
   }
}

/** The locales whose own schema reference exists, read off the pages themselves. Two
 *  chrome groups are optional until a locale has one and required the moment it does,
 *  so this is the evidence that decides which. */
const SCHEMA_PAGES = import.meta.glob('../../pages/*/schemas/*.astro');
const TRANSLATES_SCHEMAS = new Set(Object.keys(SCHEMA_PAGES).map((file) => file.split('/')[3]));

/** A chrome group whose reach is wider than the pages that introduced it.
 *
 *  `schema` and `pageKinds` are rendered by two shared components, so they appear on
 *  pages every locale already ships: a locale that has not translated the schema
 *  reference yet has no approved wording for them, and inventing one for it is not this
 *  file's call. So the group is optional while the locale has no `pages/<locale>/schemas/`
 *  directory, and English (the page of record) stands in those two places until the
 *  locale has schema reference pages. The moment that directory exists the group is
 *  required and checked whole, exactly like `nav`: from then on nothing on a page of
 *  that locale is rendered in a language its reader did not choose. */
function chromeGroup<T extends Record<string, string>>(
   locale: string,
   name: string,
   english: T,
   keys: readonly string[],
   authored: T | undefined,
): T {
   if (!authored) {
      if (TRANSLATES_SCHEMAS.has(locale)) {
         throw new Error(
            `src/data/i18n/${locale}.json is missing ${name}: a locale with schema pages carries it whole`,
         );
      }
      return english;
   }
   requireStrings(locale, name, authored, [...keys]);
   rejectUnknown(locale, name, authored, keys);
   rejectRevision(locale, name, authored);
   return authored;
}

/** The schema reference's chrome for one locale: the field table's words, and the
 *  phrases that frame the schema's own type tokens. */
export function schemaLabels(locale: string): SchemaStrings {
   if (locale === 'en') return SCHEMA_LABELS;
   return chromeGroup(locale, 'schema', SCHEMA_LABELS, SCHEMA_LABEL_KEYS, translationStrings(locale).schema);
}

/** The page classification eyebrow for one locale. */
export function pageKindLabels(locale: string): PageKindStrings {
   if (locale === 'en') return PAGE_KIND_LABELS;
   return chromeGroup(locale, 'pageKinds', PAGE_KIND_LABELS, PAGE_KIND_KEYS, translationStrings(locale).pageKinds);
}

/** The strings for one locale. */
export function translationStrings(locale: string): TranslationStrings {
   const strings = FILES[`./${locale}.json`];
   if (!strings) throw new Error(`no translation strings for ${locale}: add src/data/i18n/${locale}.json`);
   requireStrings(locale, 'note', strings.note, [...NOTE_KEYS]);
   rejectUnknown(locale, 'note', strings.note, NOTE_KEYS);
   rejectRevision(locale, 'note', strings.note);
   if (strings.specBanner) {
      requireStrings(locale, 'specBanner', strings.specBanner, [...SPEC_BANNER_KEYS]);
      rejectUnknown(locale, 'specBanner', strings.specBanner, SPEC_BANNER_KEYS);
      rejectRevision(locale, 'specBanner', strings.specBanner);
   }
   return strings;
}

/** The navigation chrome for one locale. English is the page of record and its labels
 *  are the definition, in `nav-labels.ts`, so English never reads a locale file at all.
 *  Every other locale carries the whole set: a missing, blank, or unknown key fails the
 *  build, and so does a specification document the sidebar would have no name for. The
 *  labels never fall back to English, only the link targets do, and that is the
 *  registry's business rather than this file's. */
export function navStrings(locale: string): NavStrings {
   if (locale === 'en') return ENGLISH_NAV;
   const { nav } = translationStrings(locale);
   if (!nav) throw new Error(`src/data/i18n/${locale}.json is missing nav`);
   requireStrings(locale, 'nav', nav, NAV_KEYS);
   rejectUnknown(locale, 'nav', nav, [...NAV_KEYS, 'specDocs']);
   const docs = Object.keys(ENGLISH_NAV.specDocs);
   if (!nav.specDocs) throw new Error(`src/data/i18n/${locale}.json is missing nav.specDocs`);
   requireStrings(locale, 'nav.specDocs', nav.specDocs, docs);
   rejectUnknown(locale, 'nav.specDocs', nav.specDocs, docs);
   return nav;
}

/** The footer for one locale, on the same terms as the navigation chrome above: English
 *  is the page of record and its labels are the definition, in `footer-labels.ts`, so
 *  English never reads a locale file at all. Every other locale carries the whole set,
 *  and a missing, blank, or unknown key fails the build. The labels never fall back to
 *  English; the two link targets do, and that is the registry's business rather than
 *  this file's. */
export function footerStrings(locale: string): FooterStrings {
   if (locale === 'en') return ENGLISH_FOOTER;
   const { footer } = translationStrings(locale);
   if (!footer) throw new Error(`src/data/i18n/${locale}.json is missing footer`);
   requireStrings(locale, 'footer', footer, FOOTER_KEYS);
   rejectUnknown(locale, 'footer', footer, FOOTER_KEYS);
   return footer;
}

/** The shared chrome for one locale, on the same terms as the navigation chrome and the
 *  footer above: English is the page of record and its labels are the definition, in
 *  `chrome-labels.ts`, so English never reads a locale file at all. Every other locale
 *  carries the whole set, and a missing, blank, or unknown key fails the build. */
export function chromeStrings(locale: string): ChromeStrings {
   if (locale === 'en') return ENGLISH_CHROME;
   const { chrome } = translationStrings(locale);
   if (!chrome) throw new Error(`src/data/i18n/${locale}.json is missing chrome`);
   requireStrings(locale, 'chrome', chrome, CHROME_KEYS);
   rejectUnknown(locale, 'chrome', chrome, CHROME_KEYS);
   return chrome;
}

/** The banner strings, which a locale authors when it translates the specification. */
export function specBannerStrings(locale: string): SpecBannerStrings {
   const { specBanner } = translationStrings(locale);
   if (!specBanner) {
      throw new Error(`src/data/i18n/${locale}.json has no specBanner: a translated specification page needs one`);
   }
   return specBanner;
}

/** A sentence split into its literal text and its placeholders, so a component can
 *  render the links a sentence contains without ever treating a strings file as
 *  markup. */
export function templateParts(template: string): string[] {
   return template.split(/(\{link\}|\{issue\}|\{edit\})/);
}
