import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { rehypeMdLinks } from './src/rehype-md-links';
import { rehypeTableScroll } from './src/rehype-table-scroll';
import { rehypeHeadingAnchors } from './src/rehype-heading-anchors';

export default defineConfig({
   site: 'https://leji.org',
   integrations: [sitemap()],
   server: { port: 21200 },
   devToolbar: { enabled: false },
   markdown: {
      rehypePlugins: [rehypeMdLinks, rehypeTableScroll, rehypeHeadingAnchors],
      shikiConfig: { theme: 'night-owl' },
   },
});
