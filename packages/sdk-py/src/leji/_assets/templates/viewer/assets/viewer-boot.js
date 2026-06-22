// Leji viewer boot script. Static (no per-layer interpolation): it reads the
// layer config from the #leji-docsify-config JSON block and configures Docsify.
// Kept as a vendored file (not inline) so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which blocks any script injected
// through served Markdown content. Written alongside the page by `leji viewer`.
window.$docsify = Object.assign(JSON.parse(document.getElementById('leji-docsify-config').textContent), {
   // The viewer chrome lives at the web root; the layer's markdown is mounted under
   // /content/. basePath points Docsify at the content mount; the alias maps every
   // nested `_sidebar.md` lookup to the single generated sidebar (so nested routes do
   // not 404), which basePath then resolves to /content/_sidebar.md.
   basePath: '/content/',
   loadSidebar: '_sidebar.md',
   alias: { '/.*/_sidebar.md': '_sidebar.md' },
   subMaxLevel: 3,
   auto2top: true,
   // Collapse sibling groups; auto-expand the active trail (sidebar-collapse plugin).
   sidebarDisplayLevel: 1,
   search: {
      paths: 'auto',
      placeholder: 'Search the context layer…',
      noData: 'No matching documents.',
      depth: 6,
      namespace: 'leji-docs',
   },
   plugins: [
      function stripFrontmatter(hook) {
         // Context layer documents carry YAML frontmatter for tooling; readers shouldn't see it.
         hook.beforeEach(function (content) {
            return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
         });
      },
      function poweredByLeji(hook) {
         hook.mounted(function () {
            var sidebar = document.querySelector('.sidebar');
            if (!sidebar || sidebar.querySelector('.leji-powered')) return;
            var f = document.createElement('div');
            f.className = 'leji-powered';
            f.innerHTML =
               'Powered by <a href="https://leji.org" target="_blank" rel="noopener noreferrer">' +
               '<span class="spark" aria-hidden="true">✦</span> <strong>Leji</strong></a>';
            sidebar.appendChild(f);
         });
      },
   ],
});
