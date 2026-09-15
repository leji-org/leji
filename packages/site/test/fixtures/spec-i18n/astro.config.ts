import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';
import { markdownProcessorOptions } from '../../../src/markdown-options';
import lejiSyntaxTheme from '../../../src/styles/shiki-leji.json';

// The site's own markdown pipeline and sitemap integration, so what this fixture
// builds is what the site builds. `@site` is the site's `src`, which the routes, the
// layout and the components import the real implementation through.
export default defineConfig({
   site: 'https://leji.org',
   integrations: [sitemap()],
   devToolbar: { enabled: false },
   markdown: {
      processor: satteri(markdownProcessorOptions),
      shikiConfig: { theme: lejiSyntaxTheme },
   },
   vite: {
      resolve: { alias: { '@site': fileURLToPath(new URL('../../../src', import.meta.url)) } },
   },
});
