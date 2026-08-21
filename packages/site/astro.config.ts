import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';
import { markdownProcessorOptions } from './src/markdown-options';
import lejiSyntaxTheme from './src/styles/shiki-leji.json';

export default defineConfig({
   site: 'https://leji.org',
   integrations: [sitemap()],
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
