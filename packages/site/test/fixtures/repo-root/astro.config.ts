import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

// Nothing but the `@site` alias, which is the site's `src`: the page imports the real
// repository-root helper and the real schema reader, so this builds the site's code
// rather than a copy of it.
export default defineConfig({
   devToolbar: { enabled: false },
   vite: {
      resolve: { alias: { '@site': fileURLToPath(new URL('../../../src', import.meta.url)) } },
   },
});
