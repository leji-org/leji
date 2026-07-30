// Leji viewer boot script. Static (no per-layer interpolation): it reads the
// layer config from the #leji-docsify-config JSON block and configures Docsify.
// Kept as a vendored file (not inline) so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which blocks any script injected
// through served Markdown content. Written alongside the page by `leji viewer`.
// Pick a readable mermaid node-text color for the layer's accent: dark text on a
// light accent, white on a dark one. Parses #rgb or #rrggbb (case-insensitive);
// an unparseable value keeps the dark default.
function lejiMermaidTextColor(accent) {
   var hex = String(accent || '').replace(/^#/, '');
   if (hex.length === 3) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
   }
   if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#1a1a1a';
   var r = parseInt(hex.slice(0, 2), 16);
   var g = parseInt(hex.slice(2, 4), 16);
   var b = parseInt(hex.slice(4, 6), 16);
   var brightness = (299 * r + 587 * g + 114 * b) / 1000;
   return brightness >= 150 ? '#1a1a1a' : '#ffffff';
}

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
   // Docsify's script execution runs a `new Function(...)` over a rendered page's
   // <script> block when window.Vue is present. Nothing here needs it, and a
   // governed document is not a place to run code from, so it is off explicitly
   // rather than left to depend on Vue's absence.
   executeScript: false,
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
      function categoryBadge(hook, vm) {
         // Top-right classification chip: the category (emoji + label) every
         // governed page carries for agents, made visible to people. Records
         // append their date; ungoverned pages read "Reference"; the boot
         // profile and agent profiles get their own labels. Resolved against
         // the live-served index so it never disagrees with the tree.
         var cfg = window.$docsify;
         if (!cfg.lejiIndexRel || !cfg.lejiCategories) return;
         hook.doneEach(function () {
            var rel = vm.route && vm.route.file ? vm.route.file : '';
            fetch('/content/' + cfg.lejiIndexRel, { cache: 'no-store' })
               .then(function (r) { return r.ok ? r.json() : null; })
               .then(function (idx) {
                  var label = null;
                  if (rel === cfg.lejiBootPath) {
                     label = '🤖 Boot profile';
                  } else if (cfg.lejiAgentsPrefix && rel.indexOf(cfg.lejiAgentsPrefix) === 0) {
                     label = cfg.lejiAgentsLabel;
                  } else if (idx && idx.entries) {
                     var prefix = null;
                     for (var i = 0; i < idx.entries.length; i++) {
                        var path = idx.entries[i].path;
                        if (path.length > rel.length && path.slice(-rel.length) === rel) {
                           prefix = path.slice(0, path.length - rel.length);
                           break;
                        }
                        if (path === rel) { prefix = ''; break; }
                     }
                     var entry = null;
                     for (var j = 0; j < idx.entries.length; j++) {
                        if (idx.entries[j].path === (prefix === null ? rel : prefix + rel)) { entry = idx.entries[j]; break; }
                     }
                     if (entry) {
                        label = cfg.lejiCategories[entry.category] || entry.category;
                        if (entry.kind === 'record') label += ' · ' + (entry.date || 'record');
                     } else {
                        label = 'Reference';
                     }
                  }
                  var el = document.querySelector('.lj-cat');
                  if (!label) { if (el) el.remove(); return; }
                  if (!el) {
                     el = document.createElement('div');
                     el.className = 'lj-cat';
                     document.body.appendChild(el);
                  }
                  el.textContent = label;
               })
               .catch(function () { /* badge is best-effort chrome */ });
         });
      },
      function sidebarLoadingState(hook) {
         // The sidebar is generated server-side per request, so on a fresh load the
         // nav element sits empty until _sidebar.md arrives (longer on large layers).
         // Show a placeholder immediately; Docsify overwrites the nav's content when
         // the compiled sidebar lands, which removes it without any cleanup hook.
         hook.mounted(function () {
            var nav = document.querySelector('.sidebar-nav');
            if (!nav || nav.children.length > 0 || nav.textContent.trim() !== '') return;
            var p = document.createElement('p');
            p.className = 'lj-nav-loading';
            p.textContent = 'Loading navigation…';
            nav.appendChild(p);
         });
      },
      function poweredByLeji(hook) {
         // A small fixed mark in the lower-right corner of the content area,
         // out of the sidebar's way. viewer.poweredBy: false removes it.
         hook.mounted(function () {
            if (window.$docsify.lejiPoweredBy === false) return;
            if (document.querySelector('.leji-powered')) return;
            var f = document.createElement('div');
            f.className = 'leji-powered';
            f.innerHTML =
               'Powered by <a href="https://leji.org" target="_blank" rel="noopener noreferrer">' +
               '<span class="spark" aria-hidden="true">✦</span> <strong>Leji</strong></a>';
            document.body.appendChild(f);
         });
      },
      function brandMermaid(hook) {
         // Theme mermaid diagrams from the layer's accent color; runs at init so
         // it lands after mermaid.min.js (loaded last) is present.
         hook.init(function () {
            if (!window.mermaid || !window.$docsify.themeColor) return;
            window.mermaid.initialize({
               startOnLoad: false,
               theme: 'base',
               themeVariables: {
                  primaryColor: window.$docsify.themeColor,
                  primaryTextColor: lejiMermaidTextColor(window.$docsify.themeColor),
                  lineColor: '#666',
                  tertiaryColor: '#f8f9fa',
               },
            });
         });
      },
   ],
});
