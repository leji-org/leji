// What goes between two sentences of the translation chrome.
//
// The note and the banner are built from separate sentences the locale authors one by
// one, so the component joins them rather than the strings file. A Latin space is the
// right join in most languages and the wrong one in Chinese and Japanese, whose full
// stop is a full-width character that carries its own trailing space: a space after it
// renders as a visible gap the language never puts there.
//
// This is a property of the language's punctuation, not of any page, so it is decided
// here from the locale rather than added as a string a locale could get wrong.

/** Locales whose sentence-ending punctuation is full width, so sentences abut. The
 *  same property decides where the emphasis-gap plugin applies, so the list is shared
 *  rather than written twice. */
export const FULL_WIDTH_PUNCTUATION = new Set(['zh-hans', 'ja']);

/** The separator to place between two rendered sentences in this locale. */
export function sentenceGap(locale: string): string {
   return FULL_WIDTH_PUNCTUATION.has(locale) ? '' : ' ';
}
