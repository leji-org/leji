import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';
import { markdownProcessorOptions } from './src/markdown-options';

export default defineConfig({
   site: 'https://leji.org',
   integrations: [sitemap()],
   server: { port: 21200 },
   devToolbar: { enabled: false },
   markdown: {
      // Astro 7's default Markdown processor. Our content transforms run as Sätteri
      // hast plugins (the unified/remark pipeline is no longer used).
      processor: satteri(markdownProcessorOptions),
      shikiConfig: { theme: 'night-owl' },
   },
});
