// The site footer in English: every label the footer band renders, on every page in
// every language.
//
// One typed module rather than an English locale file, for the two reasons the
// navigation labels are one. English is the page of record, so its labels are the
// definition and not a translation of anything; and this is the key inventory every
// other locale's set is checked against, so a label added here without a translation
// fails the build instead of quietly shipping English on a translated page.
//
// What is deliberately absent: the pronunciation, the two names the credit line links
// to, the contact address, and the two licence identifiers. Those read the same in
// every language, so the footer prints them literally rather than through a key
// nobody should ever translate.

export const FOOTER_LABELS = {
   /** Beside the pronunciation: what Leji is, in three words. */
   tagline: 'Open specification & tooling',
   /** The sentence under the mark. */
   description: 'The open specification for the shared context layer of AI-native teams.',
   /** The credit line, which precedes the name of the person who created Leji. */
   createdBy: 'Created by',
   /** The same line, which precedes the name of the steward. */
   stewardedBy: 'Stewarded by',
   /** What the Apache-2.0 licence covers, in the parentheses that follow the identifier;
    *  the identifier itself is a token and stays as it is. */
   codeSchemas: '(code, schemas)',
   /** What the CC-BY-4.0 licence covers, in the same shape. */
   specProse: '(spec prose)',

   /** The three links that close the line. Trust and Trademark are pages of this site,
    *  so a translated footer links the locale's own page where one exists; Security is
    *  the repository's policy file and is the same destination in every language. */
   trust: 'Trust',
   trademark: 'Trademark',
   security: 'Security',
} as const;

/** Every footer label a locale authors. */
export type FooterKey = keyof typeof FOOTER_LABELS;

/** One locale's footer. */
export type FooterStrings = Record<FooterKey, string>;

/** The inventory a locale's set is validated against. */
export const FOOTER_KEYS = Object.keys(FOOTER_LABELS) as FooterKey[];

/** English, in the shape a locale authors, so one component renders both. */
export const ENGLISH_FOOTER: FooterStrings = { ...FOOTER_LABELS };
