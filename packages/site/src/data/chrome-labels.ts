// The shared chrome in English: the words the components that sit on pages in every
// language render outside the navigation band and the footer, visible text and
// accessible labels alike.
//
// One typed module rather than an English locale file, for the two reasons the
// navigation labels are one. English is the page of record, so its labels are the
// definition and not a translation of anything; and this is the key inventory every
// other locale's set is checked against, so a label added here without a translation
// fails the build instead of quietly shipping English on a translated page.
//
// Some of these reach a browser rather than the server: a copy button renames itself
// while the feedback shows, and the scheme control renames itself as a reader cycles
// through the three states, so each component hands its words to its script through
// data attributes and the script carries none of its own.

export const CHROME_LABELS = {
   /** The first link on every page, which jumps past the header to the content. */
   skipToContent: 'Skip to content',
   /** The header's link to the repository, as a reader sees it. */
   source: 'Source',
   /** The same link's accessible name, which says where it leads. */
   sourceRepository: 'Source repository on GitHub',
   /** The label over the runtimes the CLI is published for. */
   supportedRuntimes: 'Supported runtimes',
   /** The install tabs, as a tab list: one tab per runtime. */
   install: 'Install Leji',
   /** The button that copies the selected install command. */
   copyCommand: 'Copy install command',
   /** The button that copies a code block, where the page names no command of its own. */
   copyCode: 'Copy to clipboard',
   /** What either button is called for the moment after it has copied. */
   copied: 'Copied',
   /** The control that chooses how the site is painted, as a screen reader announces
    * it; the state name below follows it, so the two are read as one name. */
   colorScheme: 'Color scheme',
   /** That control's first state, in which the operating system decides. */
   schemeSystem: 'System',
   /** Its second state: the light scheme, whatever the operating system asks for. */
   schemeLight: 'Light',
   /** Its third state: the dark scheme, on the same terms. */
   schemeDark: 'Dark',
} as const;

/** Every shared-chrome label a locale authors. */
export type ChromeKey = keyof typeof CHROME_LABELS;

/** One locale's shared chrome. */
export type ChromeStrings = Record<ChromeKey, string>;

/** The inventory a locale's set is validated against. */
export const CHROME_KEYS = Object.keys(CHROME_LABELS) as ChromeKey[];

/** English, in the shape a locale authors, so one component renders both. */
export const ENGLISH_CHROME: ChromeStrings = { ...CHROME_LABELS };
