// Theme bootstrap for the Leji viewer. Loaded synchronously in <head> so it runs
// before any body paint: it resolves the effective theme — the reader's persisted
// choice (system|light|dark), else the OS scheme — and writes it to
// <html data-theme>. The first paint is therefore already the right theme: no
// light flash for a dark reader, and no wrong-theme flash for a reader who chose
// otherwise. viewer-boot.js owns the runtime toggle (it re-applies the same
// attribute on load and reacts to OS changes); this file exists only to beat the
// first paint. Keep the storage key and the resolve rule in lockstep with the
// boot script's theme module.
(function () {
   var KEY = 'leji-viewer-theme';
   var mode = 'system';
   try {
      var v = window.localStorage.getItem(KEY);
      if (v === 'light' || v === 'dark' || v === 'system') mode = v;
   } catch (e) {
      // storage blocked: fall through to the OS scheme
   }
   var systemDark =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
   var effective = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
   document.documentElement.setAttribute('data-theme', effective);
})();