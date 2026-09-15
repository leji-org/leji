import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';
import { markdownProcessorOptions } from './src/markdown-options';
import lejiSyntaxTheme from './src/styles/shiki-leji.json';
import { LOCALES } from './src/i18n';

// The sitemap integration drops `404` and `500` by name at the root, but a
// locale's status pages only when its own i18n option declares the locales,
// which this site does not use. Listing a noindex page is a contradiction a
// crawler reports, so the routes are excluded here instead. English keeps the
// unprefixed routes, so its entry in this set never matches anything.
const LOCALE_STATUS_PAGES = new Set(LOCALES.map((locale) => `/${locale}/404/`));

export default defineConfig({
   site: 'https://leji.org',
   integrations: [sitemap({ filter: (page) => !LOCALE_STATUS_PAGES.has(new URL(page).pathname) })],
   devToolbar: { enabled: false },
   markdown: {
      // Astro 7's default Markdown processor. Our content transforms run as Sätteri
      // hast plugins (the unified/remark pipeline is no longer used).
      processor: satteri(markdownProcessorOptions),
      // Brand-family syntax theme: one voice with the terminal illustration and the
      // dark-surface cast; strings mint, keywords luminous brand green, constants
      // parchment, comments muted — no off-system hues on brand grounds.
      shikiConfig: { theme: lejiSyntaxTheme },
   },
});
