// Placeholder strings. The fixture proves the machinery, never a locale's copy, so
// these are English and deliberately not any locale's approved wording.
import type { NoteStrings, SpecBannerStrings } from '@site/data/i18n';

export const SPEC_BANNER: SpecBannerStrings = {
   template: 'Informative translation of {link} on the frozen 1.0 line.',
   fullTemplate: 'Informative translation of {link} on the frozen 1.0 line.',
   linkText: 'the normative English page',
};

export const NOTE: NoteStrings = {
   template: 'This page translates {link}.',
   linkText: 'the English page',
   made: 'Made with a multi-agent workflow.',
   corrections: 'Please {issue} or {edit}.',
   correctionsFull: 'Please {issue}, or use the link beside each heading.',
   issueLinkText: 'file an issue',
   editLinkText: 'open a pull request',
};
