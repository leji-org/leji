// Leji viewer boot script. Static (no per-layer interpolation): it reads the
// layer config from the #leji-docsify-config JSON block and configures Docsify.
// Kept as a vendored file (not inline) so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which blocks any script injected
// through served Markdown content. Written alongside the page by `leji viewer`.
// Fallback mermaid node-text color for the layer's accent. The SDK computes this
// server-side and ships it in the config block (lejiMermaidTextColor), over every
// color form the manifest accepts; this covers only a viewer tree generated before
// that field existed, so it parses #rgb and #rrggbb and nothing else. WCAG relative
// luminance over linearized sRGB: whichever of #1a1a1a and #ffffff contrasts more
// with the accent, or #000000 when neither clears 4.5:1 (a mid-gray accent, where
// the extra half-stop of black is the best text color available). An unparseable
// value keeps the dark default.
function lejiMermaidTextColor(accent) {
   var hex = String(accent || '').replace(/^#/, '');
   if (hex.length === 3) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
   }
   if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#1a1a1a';
   var luminance = function (h) {
      var channel = function (i) {
         var c = parseInt(h.slice(i, i + 2), 16) / 255;
         return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
   };
   var ratio = function (a, b) {
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
   };
   var accentLuminance = luminance(hex);
   var onDark = ratio(luminance('1a1a1a'), accentLuminance);
   var onLight = ratio(luminance('ffffff'), accentLuminance);
   if (onDark < 4.5 && onLight < 4.5) return '#000000';
   return onDark >= onLight ? '#1a1a1a' : '#ffffff';
}

// Resolve a raw-HTML `<img src>` against the document that carries it, exactly as
// Docsify's relativePath routing already resolves the markdown image form. Returns
// the path under `contentBase` (query and fragment preserved) or null for a src that must be
// left as authored: empty, fragment- or query-only, root-relative, backslash-led,
// protocol-relative, any scheme reference, and any traversal escaping /content/ —
// traversal is rejected rather than clamped, because the server canonicalizes and a
// clamped path would quietly address the viewer chrome instead of the layer.
// Containment is judged on the decoded, normalized path, not the literal one,
// because the server canonicalizes percent-encoding and separators before it
// routes — an encoded `..` reads as traversal there even though URL keeps it.
// The value is first put through URL parsing's own input preprocessing — leading
// and trailing C0-control-and-space characters trimmed, then ASCII tab, LF, and
// CR removed anywhere in the value — so classification sees exactly what the
// parser sees; otherwise a padded or tab-split scheme reference slips past the
// first-character and scheme checks and gets rewritten.
function lejiResolveImgSrc(src, docDir, contentBase) {
   var origin = 'http://leji.invalid';
   var raw = String(src || '')
      .replace(/^[\x00-\x20]+/, '')
      .replace(/[\x00-\x20]+$/, '')
      .replace(/[\t\n\r]/g, '');
   if (raw === '') return null;
   var first = raw.charAt(0);
   if (first === '#' || first === '?' || first === '/' || first === '\\') return null;
   if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
   var url;
   try {
      url = new URL(raw, origin + '/content/' + (docDir ? docDir + '/' : ''));
   } catch (e) {
      return null;
   }
   if (url.origin !== origin) return null;
   if (url.pathname.indexOf('/content/') !== 0) return null;
   var decoded;
   try {
      decoded = decodeURIComponent(url.pathname);
   } catch (e) {
      return null;
   }
   var parts = decoded.replace(/\\/g, '/').split('/');
   var kept = [];
   for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.') continue;
      if (parts[i] === '..') kept.pop();
      else kept.push(parts[i]);
   }
   if (('/' + kept.join('/')).indexOf('/content/') !== 0) return null;
   // Re-based onto the content mount as this page addresses it: '/content/…' when
   // served locally, 'content/…' in an export, which the browser then resolves
   // against the page so a subpath-hosted tree still finds the file.
   return contentBase + url.pathname.slice('/content/'.length) + url.search + url.hash;
}

var lejiConfig = JSON.parse(document.getElementById('leji-docsify-config').textContent);
// Where this page addresses the layer's markdown, from the SDK's config block:
// '/content/' for the local server, 'content/' for an export. Everything the page
// fetches for itself is derived from it, so one generated value moves the whole
// chrome between the app root and a relative base. Older viewer trees carry no
// basePath in their config; they were server-flavored, so the app root is the
// correct fallback.
var lejiContentBase = typeof lejiConfig.basePath === 'string' ? lejiConfig.basePath : '/content/';

// --- theme ------------------------------------------------------------------
// The viewer follows the OS scheme until the reader chooses otherwise. The
// EFFECTIVE mode (light|dark) is written to <html data-theme>, which the theme
// CSS keys its overrides off; the reader's choice (system|light|dark) persists
// in localStorage so a manual pick survives reloads. "system" is the default
// and tracks the OS live. The theme bootstrap in the page <head>
// (assets/theme-init.js) already set the attribute before first paint; this
// module is the runtime authority — it re-applies on load (idempotent), reacts
// to OS changes while in "system", and drives the toggle button. Keep the
// storage key and the resolve rule in lockstep with that bootstrap file.
var LEJI_THEME_KEY = 'leji-viewer-theme';
var lejiThemeStore = (function () {
   try {
      window.localStorage.setItem('__leji_probe', '1');
      window.localStorage.removeItem('__leji_probe');
      return window.localStorage;
   } catch (e) {
      return null; // storage blocked (private mode, restrictive policy): no persistence
   }
})();
// The in-memory mode is the runtime authority. When storage works it starts from
// the persisted choice and writes back on every change; when storage is blocked
// it still cycles (system -> light -> dark -> system), it just cannot persist.
var lejiThemeMode = (function () {
   var v = lejiThemeStore && lejiThemeStore.getItem(LEJI_THEME_KEY);
   return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
})();
function lejiSystemDark() {
   return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function lejiReadTheme() {
   return lejiThemeMode;
}
function lejiApplyTheme(mode) {
   var effective = mode === 'system' ? (lejiSystemDark() ? 'dark' : 'light') : mode;
   document.documentElement.setAttribute('data-theme', effective);
   return effective;
}
var lejiTheme = lejiApplyTheme(lejiReadTheme());
// While in "system", a change to the OS scheme re-resolves immediately. The
// change event is also re-rendered (mermaid diagrams, the button label) so an
// already-open page follows the OS live.
if (typeof window.matchMedia === 'function') {
   var lejiSchemeMql = window.matchMedia('(prefers-color-scheme: dark)');
   var lejiOnSchemeChange = function () {
      if (lejiReadTheme() === 'system') {
         lejiTheme = lejiApplyTheme('system');
         lejiReapplyTheme();
      }
   };
   if (lejiSchemeMql.addEventListener) lejiSchemeMql.addEventListener('change', lejiOnSchemeChange);
   else if (lejiSchemeMql.addListener) lejiSchemeMql.addListener(lejiOnSchemeChange);
}
var LEJI_THEME_MARKS = { system: '◐', light: '☀', dark: '🌙' };
var LEJI_THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
function lejiThemeButtonLabel(button) {
   var mode = lejiReadTheme();
   button.textContent = LEJI_THEME_MARKS[mode] + ' ' + LEJI_THEME_LABELS[mode];
   button.setAttribute(
      'aria-label',
      'Theme: ' + LEJI_THEME_LABELS[mode] + (mode === 'system' ? ' (follows the operating system)' : ''),
   );
   button.title =
      'Theme: ' + LEJI_THEME_LABELS[mode] + (mode === 'system' ? ' — follows the operating system' : '');
}
// Everything that renders the theme, brought current after a change: the
// attribute (via lejiApplyTheme), any already-rendered mermaid diagrams, and
// the toggle button's label.
function lejiReapplyTheme() {
   if (window.lejiApplyMermaid) window.lejiApplyMermaid();
   var b = document.querySelector('.leji-theme');
   if (b) lejiThemeButtonLabel(b);
}
function lejiCycleTheme() {
   var order = ['system', 'light', 'dark'];
   var next = order[(order.indexOf(lejiReadTheme()) + 1) % order.length];
   lejiThemeMode = next;
   lejiTheme = lejiApplyTheme(next);
   if (lejiThemeStore) lejiThemeStore.setItem(LEJI_THEME_KEY, next);
   lejiReapplyTheme();
}

window.$docsify = Object.assign(lejiConfig, {
   // The viewer chrome lives at the web root; the layer's markdown is mounted under
   // the content base above. basePath points Docsify at the content mount; the alias
   // maps every nested `_sidebar.md` lookup to the single generated sidebar (so
   // nested routes do not 404), which basePath then resolves to <base>_sidebar.md.
   basePath: lejiContentBase,
   loadSidebar: '_sidebar.md',
   alias: { '/.*/_sidebar.md': '_sidebar.md' },
   // Markdown links resolve against the document that carries them, matching how
   // the same files read on disk and on any git host. Generated sidebar links are
   // emitted app-root absolute (leading slash) so they are unaffected. Without
   // this, a `../`-style link on a nested page escapes the router entirely.
   relativePath: true,
   // A missing document renders Docsify's in-app not-found message; the vendored
   // runtime's default (true) would issue a second, always-failing fetch for a
   // `_404.md` no layer ships. The primary missing-document 404 is inherent to
   // static serving.
   notFoundPage: false,
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
      function resolveImageSrc(hook, vm) {
         // relativePath resolves markdown images; a raw-HTML <img src="assets/x.svg">
         // passes through untouched and the browser resolves it against the page URL,
         // so on a nested page it 404s. Rewrite at render rather than on the way out:
         // a document's served bytes are the file's, verbatim. afterEach runs before
         // the compiled HTML is inserted, so the unresolved URL is never requested.
         hook.afterEach(function (html, next) {
            var rel = vm.route && vm.route.file ? vm.route.file : '';
            var cut = rel.lastIndexOf('/');
            var docDir = cut === -1 ? '' : rel.slice(0, cut);
            // Parsed in a detached container, never regexed over the HTML string.
            var container = document.createElement('div');
            container.innerHTML = html;
            container.querySelectorAll('img[src]').forEach(function (img) {
               var resolved = lejiResolveImgSrc(img.getAttribute('src'), docDir, lejiContentBase);
               if (resolved !== null) img.setAttribute('src', resolved);
            });
            next(container.innerHTML);
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
            fetch(lejiContentBase + cfg.lejiIndexRel, { cache: 'no-store' })
               .then(function (r) {
                  return r.ok ? r.json() : null;
               })
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
                        if (path === rel) {
                           prefix = '';
                           break;
                        }
                     }
                     var entry = null;
                     for (var j = 0; j < idx.entries.length; j++) {
                        if (idx.entries[j].path === (prefix === null ? rel : prefix + rel)) {
                           entry = idx.entries[j];
                           break;
                        }
                     }
                     if (entry) {
                        label = cfg.lejiCategories[entry.category] || entry.category;
                        if (entry.kind === 'record') label += ' · ' + (entry.date || 'record');
                     } else {
                        label = 'Reference';
                     }
                  }
                  var el = document.querySelector('.lj-cat');
                  if (!label) {
                     if (el) el.remove();
                     return;
                  }
                  if (!el) {
                     el = document.createElement('div');
                     el.className = 'lj-cat';
                     document.body.appendChild(el);
                  }
                  el.textContent = label;
               })
               .catch(function () {
                  /* badge is best-effort chrome */
               });
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
      function themeToggle(hook) {
         // A small fixed pill in the lower-right corner that cycles the theme
         // (system -> light -> dark -> system) and persists the choice. The
         // effective mode already lives on <html data-theme> from the module
         // load above; this hook only places the control and wires the click.
         hook.mounted(function () {
            if (document.querySelector('.leji-theme')) return;
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'leji-theme';
            b.title = 'Switch theme — System follows the operating system';
            lejiThemeButtonLabel(b);
            b.addEventListener('click', lejiCycleTheme);
            document.body.appendChild(b);
         });
      },
      function brandMermaid(hook) {
         // Theme mermaid diagrams from the layer's accent color; runs at init so
         // it lands after mermaid.min.js (loaded last) is present. The node-text
         // color is the SDK's, computed at generation time over every color form
         // the manifest accepts; the local fallback covers only a viewer tree
         // generated before that field shipped. The diagram surface follows the
         // EFFECTIVE theme (the <html data-theme> the theme module sets): the
         // same edges the light theme fills with the canvas take the dark reading
         // surface, and the line tone brightens, so a diagram drawn on a dark page
         // does not ship a light box with it. The config is rebuilt on every call
         // (lejiTheme is read live), and already-rendered diagrams are re-run, so
         // a theme toggle recolors the current page without a reload.
         function lejiMermaidConfig() {
            var dark = lejiTheme === 'dark';
            return {
               startOnLoad: false,
               theme: 'base',
               themeVariables: {
                  primaryColor: window.$docsify.themeColor,
                  primaryTextColor:
                     window.$docsify.lejiMermaidTextColor || lejiMermaidTextColor(window.$docsify.themeColor),
                  background: 'transparent',
                  lineColor: dark ? '#93a8a0' : '#666',
                  tertiaryColor: dark ? '#162220' : '#f7f8f5',
               },
            };
         }
         function lejiApplyMermaid() {
            if (!window.mermaid || !window.$docsify.themeColor) return;
            window.mermaid.initialize(lejiMermaidConfig());
            // Re-render the diagrams already on the page so a theme change
            // recolors them; navigation re-renders through the plugin anyway.
            if (document.querySelector('.mermaid')) {
               try {
                  window.mermaid.run({ querySelector: '.mermaid' }).catch(function () {});
               } catch (e) {}
            }
         }
         hook.init(function () {
            window.lejiApplyMermaid = lejiApplyMermaid;
            lejiApplyMermaid();
         });
      },
   ],
});
