import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { type Finding, finding } from '../lib/findings.js';
import { isFile, readText, resolvedWithinRoot, stripSlash } from '../lib/fsx.js';
import { type Manifest, CATEGORY_IDS } from '../lib/manifest.js';
import { templatesDir } from '../lib/schemas.js';
import { generateIndex } from './indexgen.js';

/** Preview-port precedence: explicit --port, then manifest viewer.port, then 5354 (LEJI on a phone keypad). */
export function resolveViewerPort(manifest: Manifest, flagPort?: number): number {
   return flagPort ?? manifest.viewer?.port ?? 5354;
}

export interface ViewerResult {
   written: string[];
   findings: Finding[];
   entries: number;
}

const CATEGORY_LABELS: Record<string, string> = {
   domain: 'Domain',
   system: 'System',
   practice: 'Practice',
   governance: 'Governance',
   decisions: 'Decisions',
};

// The boot profile is the top-level entry above the category groups; it carries
// the robot emoji to match the emoji'd category groups below it.
const BOOT_EMOJI = '🤖';

// Default emoji shown beside each category group in the sidebar; overridable per
// group via manifest viewer.categoryEmojis. Baked identically into every SDK so the
// generated sidebar stays byte-identical.
const CATEGORY_EMOJI: Record<string, string> = {
   domain: '📖',
   system: '⚙️',
   practice: '🛠️',
   governance: '🛡️',
   decisions: '🧭',
};

/** Vendored assets loaded only when mermaid is enabled; skipped otherwise. */
const MERMAID_ASSETS = new Set(['mermaid.min.js', 'docsify-mermaid.js']);

/** The Leji brand blue, the viewer's default accent when no viewer.theme.primary is set. */
const DEFAULT_THEME_COLOR = '#223F93';
const DEFAULT_LOGO = '/assets/leji-logo.svg';

/** Resolve the viewer logo URL: a configured path is served from the content mount
 * (or used as-is when absolute); unset falls back to the vendored Leji mark. */
function resolveLogo(logo: string | undefined): string {
   if (!logo) return DEFAULT_LOGO;
   if (logo.startsWith('/') || /^https?:\/\//.test(logo)) return logo;
   return `/content/${stripSlash(logo)}`;
}

/** Escape text for safe interpolation into HTML element/attribute content. */
function htmlEscape(s: string): string {
   return s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
}

/**
 * Serialize a value to JSON safe to embed inside a `<script type="application/json">`
 * block: neutralize a closing tag and the two JS line terminators U+2028/U+2029.
 */
function jsonForScript(value: unknown): string {
   return JSON.stringify(value)
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e')
      .replaceAll('&', '\\u0026')
      .replaceAll(' ', '\\u2028')
      .replaceAll(' ', '\\u2029');
}

function relativeToRoot(relPath: string, rootPath: string): string | null {
   const base = stripSlash(rootPath);
   if (base === '' || base === '.') return relPath;
   if (relPath.startsWith(base + '/')) return relPath.slice(base.length + 1);
   return null; // outside the context root: not servable from the viewer
}

/** Escape a string for Markdown link text (`[...]`): backslash, brackets. */
function mdLinkText(s: string): string {
   return s.replace(/[\\[\]]/g, '\\$&');
}

/** Escape a string for a Markdown link destination (`(...)`): backslash, parens. */
function mdLinkDest(s: string): string {
   return s.replace(/[\\()]/g, '\\$&');
}

/**
 * Project a deterministic Docsify sidebar from the live index: categories in
 * their canonical order, entries sorted by path, paths relative to rootPath.
 */
export function buildSidebar(manifest: Manifest, entries: { path: string; title: string; category: string }[]): string {
   // Ungrouped entries (the boot profile) sit above a divider; the category
   // groups follow below it, giving the viewer a two-tier sidebar.
   const topLines: string[] = [];
   const boot = relativeToRoot(manifest.bootProfilePath, manifest.rootPath);
   // The emoji goes inside the link text so the whole label stays on one line (the
   // sidebar renders links as block elements; an emoji outside would wrap above).
   if (boot) topLines.push(`- [${BOOT_EMOJI} Boot profile](${mdLinkDest(boot)})`);
   const groupLines: string[] = [];
   for (const category of CATEGORY_IDS) {
      const inCategory = entries
         .filter((e) => e.category === category)
         .map((e) => ({ ...e, rel: relativeToRoot(e.path, manifest.rootPath) }))
         .filter((e): e is typeof e & { rel: string } => e.rel !== null);
      if (inCategory.length === 0) continue;
      const emoji = manifest.viewer?.categoryEmojis?.[category] ?? CATEGORY_EMOJI[category];
      groupLines.push(`- ${emoji} ${CATEGORY_LABELS[category]}`);
      for (const entry of inCategory) {
         groupLines.push(`  - [${mdLinkText(entry.title)}](${mdLinkDest(entry.rel)})`);
      }
   }
   const sections = [topLines, groupLines].filter((s) => s.length > 0).map((s) => s.join('\n'));
   return sections.join('\n\n---\n\n') + '\n';
}

// The overview homepage is seeded once and then user-owned. The layer map lives
// between these markers; `leji viewer` regenerates only the marked block, leaving
// the surrounding prose untouched.
const MAP_START = '<!-- leji:generated-map:start -->';
const MAP_END = '<!-- leji:generated-map:end -->';

/** A mermaid id from a slug: safe characters only, never colliding with `boot`. */
function mermaidId(slug: string): string {
   return 'n_' + slug.replace(/[^a-zA-Z0-9]/g, '_');
}
/** A mermaid node label: drop the characters that would break `["..."]`, and
 * collapse newlines so a multi-line title can't break out of the node. */
function mermaidLabel(text: string): string {
   return text.replace(/["[\]]/g, '').replace(/[\r\n]+/g, ' ');
}

/** A deterministic mermaid flowchart of the layer: boot profile -> categories ->
 * documents, derived from the live index in canonical order. */
export function buildLayerMap(
   manifest: Manifest,
   entries: { id: string; path: string; title: string; category: string }[],
): string {
   const lines = ['flowchart TD', `  boot["${BOOT_EMOJI} Boot profile"]`];
   for (const category of CATEGORY_IDS) {
      const inCategory = entries.filter((e) => e.category === category);
      if (inCategory.length === 0) continue;
      const emoji = manifest.viewer?.categoryEmojis?.[category] ?? CATEGORY_EMOJI[category];
      const catId = 'cat_' + category;
      lines.push(`  ${catId}["${emoji} ${CATEGORY_LABELS[category]}"]`);
      lines.push(`  boot --> ${catId}`);
      for (const entry of inCategory) {
         const id = mermaidId(entry.id);
         lines.push(`  ${id}["${mermaidLabel(entry.title)}"]`);
         lines.push(`  ${catId} --> ${id}`);
      }
   }
   return lines.join('\n');
}

function mapBlock(manifest: Manifest, entries: IndexEntryLite[]): string {
   return `${MAP_START}\n\`\`\`mermaid\n${buildLayerMap(manifest, entries)}\n\`\`\`\n${MAP_END}`;
}

type IndexEntryLite = { id: string; path: string; title: string; category: string };

/** The starter overview/home page: a short explainer the owner can edit freely,
 * plus the auto-generated layer map inside the regen markers. */
function buildOverviewSeed(manifest: Manifest, entries: IndexEntryLite[]): string {
   return `# ${manifest.name}

This is the **Leji context layer** for \`${manifest.name}\`: the shared, validated context
people and coding agents read before working in this repository. Start with the boot
profile, then browse the categories in the sidebar.

This page is yours to edit. The map below is regenerated by \`leji viewer\` between the
markers; the prose around it is left untouched.

${mapBlock(manifest, entries)}

- Write a \`\`\`mermaid code block in any document and it renders as a diagram here.
- Run \`leji conformance\` to see the level this layer claims and verifies.
`;
}

/**
 * Generate the static viewer into the context root: a Docsify
 * `index.html` (frontmatter-stripping hook included) and a `_sidebar.md`
 * projected from the index. Presentation is non-normative; this is the
 * reference projection of context-index.json into a browsable surface.
 */
export function generateViewer(root: string, manifest: Manifest): ViewerResult {
   const result = generateIndex(root, manifest);
   const entries = result.index?.entries ?? [];

   // The logo + name render as the Docsify sidebar title. The logo is raw HTML inside
   // `name` (an <img> resolved relative to the served page) rather than Docsify's own
   // `logo` option, which prepends basePath (/content/) and would 404 the asset. The
   // name is HTML-escaped; the strict CSP (script-src 'self') neutralizes any handler.
   const logoUrl = htmlEscape(resolveLogo(manifest.viewer?.logo));
   const nameHtml =
      `<img src="${logoUrl}" alt="" style="height:1.7rem;vertical-align:middle;margin-right:0.45rem" />` +
      htmlEscape(manifest.name);
   // Mermaid is on unless explicitly disabled. When off, the two mermaid scripts are
   // omitted from the page and their assets are not copied (a leaner, ~3MB-smaller viewer).
   const mermaidEnabled = manifest.viewer?.mermaid !== false;
   const mermaidScripts = mermaidEnabled
      ? '\n      <script src="assets/mermaid.min.js"></script>' +
        '\n      <script src="assets/docsify-mermaid.js"></script>'
      : '';
   const html = fs
      .readFileSync(path.join(templatesDir(), 'viewer', 'index.html'), 'utf8')
      .replaceAll('{{LEJI_NAME_HTML}}', htmlEscape(manifest.name))
      .replaceAll(
         '{{DOCSIFY_CONFIG}}',
         jsonForScript({
            name: nameHtml,
            homepage: 'overview.md',
            themeColor: manifest.viewer?.theme?.primary ?? DEFAULT_THEME_COLOR,
         }),
      )
      .replaceAll('{{MERMAID_SCRIPTS}}', mermaidScripts);
   const sidebar = buildSidebar(manifest, entries);

   const rootDir = stripSlash(manifest.rootPath) || '.';
   const rootAbs = path.resolve(root);
   const findings: Finding[] = [...result.findings];
   const written: string[] = [];

   // Refuse to write through a symlink that escapes the layer root (a symlinked
   // content root, or a pre-placed target file). resolvedWithinRoot resolves the
   // nearest existing ancestor, so a not-yet-existing target under a symlinked
   // directory is caught before mkdir/write can escape.
   const writeWithin = (rel: string, content: string | Buffer): void => {
      const abs = path.join(root, rel);
      if (!resolvedWithinRoot(rootAbs, abs)) {
         findings.push(finding('artifact-parse', 'error', `viewer path ${rel} resolves outside the layer root`, rel));
         return;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      written.push(rel);
   };

   // The viewer is contained under rootPath/.leji/viewer/ (gitignored), so it never
   // collides with the user's own files in the context root and keeps the layer clean.
   const viewerDir = rootDir === '.' ? '.leji/viewer' : `${rootDir}/.leji/viewer`;
   for (const [name, content] of [
      ['index.html', html],
      ['_sidebar.md', sidebar],
   ] as const) {
      writeWithin(`${viewerDir}/${name}`, content);
   }

   // Copy every vendored viewer asset (Docsify core, theme, and the search +
   // sidebar-collapse plugins) alongside the generated page so nothing loads
   // from a remote CDN. The provenance note is documentation, never shipped.
   const assetsSrc = path.join(templatesDir(), 'viewer', 'assets');
   const assetsRel = `${viewerDir}/assets`;
   for (const asset of fs.readdirSync(assetsSrc).sort()) {
      if (asset === 'PROVENANCE.txt' || asset.startsWith('.')) continue;
      if (!mermaidEnabled && MERMAID_ASSETS.has(asset)) continue;
      const bytes = fs.readFileSync(path.join(assetsSrc, asset));
      writeWithin(`${assetsRel}/${asset}`, bytes);
   }

   // The overview/home page is committed, user-owned content (not viewer chrome):
   // seeded once and never overwritten. On regeneration, only the marked map block
   // is refreshed; if the owner removed the markers, the page is left entirely alone.
   const overviewRel = rootDir === '.' ? 'overview.md' : `${rootDir}/overview.md`;
   const overviewAbs = path.join(root, overviewRel);
   if (!isFile(overviewAbs)) {
      writeWithin(overviewRel, buildOverviewSeed(manifest, entries));
   } else if (resolvedWithinRoot(rootAbs, overviewAbs)) {
      const existing = readText(overviewAbs);
      const start = existing.indexOf(MAP_START);
      const end = existing.indexOf(MAP_END);
      if (start >= 0 && end > start) {
         const updated = existing.slice(0, start) + mapBlock(manifest, entries) + existing.slice(end + MAP_END.length);
         if (updated !== existing) fs.writeFileSync(overviewAbs, updated);
      } else {
         findings.push(
            finding(
               'overview-markers-missing',
               'warning',
               'overview.md has no generated-map markers; left as-is (map not refreshed)',
               overviewRel,
            ),
         );
      }
   }

   return { written, findings, entries: entries.length };
}

/** Protect-your-context warning shown by `leji viewer build` and embedded in the exported index.html. */
export const PROTECT_WARNING =
   'This is your context layer (identity, invariants, decisions, sometimes sensitive internal knowledge). Host the exported folder behind internal authentication, not a public or shared bucket where it could be indexed or leaked.';

export interface BuildResult {
   out: string;
   findings: Finding[];
}

/**
 * Export a self-contained static viewer into `outRel`: the same URL contract the
 * local server materializes (chrome at the web root, the layer's markdown under
 * /content/), so any static host serves it as-is. Regenerates the viewer first,
 * then copies the contained chrome and the content docs into a clean output dir.
 * The exported index.html carries the protect-your-context warning as a comment.
 */
export function buildViewer(root: string, manifest: Manifest, outRel?: string): BuildResult {
   const gen = generateViewer(root, manifest);
   const rootAbs = path.resolve(root);
   const rootDir = stripSlash(manifest.rootPath) || '.';
   const contentAbs = rootDir === '.' ? rootAbs : path.join(rootAbs, rootDir);
   const outAbs = outRel === undefined ? path.join(contentAbs, '.leji', 'viewer-dist') : path.resolve(rootAbs, outRel);
   const outDisplay = path.relative(rootAbs, outAbs);

   // Never run the destructive export when generation failed (e.g. a symlinked
   // rootPath escaping the layer): the viewer was not written, and the rm -rf below
   // would otherwise delete an escaped output path.
   if (gen.findings.some((f) => f.severity === 'error')) {
      return { out: outDisplay, findings: gen.findings };
   }
   // Contain the output (custom or default) before the rm -rf: it must stay inside
   // the repo and not be the repo or context root.
   if (outAbs === rootAbs || outAbs === contentAbs || !resolvedWithinRoot(rootAbs, outAbs)) {
      throw new Error(
         `refusing to build the viewer into "${outRel ?? outDisplay}": --out must be a path inside the repository, and not the repository root or the context root`,
      );
   }
   const viewerAbs = path.join(contentAbs, '.leji', 'viewer');
   const outContent = path.join(outAbs, 'content');

   // Clean rebuild so a removed source file never lingers in the export.
   fs.rmSync(outAbs, { recursive: true, force: true });
   fs.mkdirSync(outContent, { recursive: true });

   // Copy the content root to /content, skipping .leji and symlinks (an export is a
   // self-contained snapshot; a symlink could pull in outside content). An explicit
   // walk, not fs.cpSync, so the default output dir under the content root isn't
   // copied into itself.
   const copyContent = (rel: string): void => {
      const srcDir = rel === '' ? contentAbs : path.join(contentAbs, rel);
      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
         if (rel === '' && entry.name === '.leji') continue;
         if (entry.isSymbolicLink()) continue;
         const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
         if (entry.isDirectory()) {
            fs.mkdirSync(path.join(outContent, childRel), { recursive: true });
            copyContent(childRel);
         } else if (entry.isFile()) {
            fs.copyFileSync(path.join(contentAbs, childRel), path.join(outContent, childRel));
         }
      }
   };
   copyContent('');
   // The generated sidebar is served as if at the content root.
   fs.copyFileSync(path.join(viewerAbs, '_sidebar.md'), path.join(outContent, '_sidebar.md'));
   // The viewer assets at the web root.
   fs.cpSync(path.join(viewerAbs, 'assets'), path.join(outAbs, 'assets'), { recursive: true });
   // index.html at the web root, with the protect-your-context warning prepended.
   const indexHtml = fs.readFileSync(path.join(viewerAbs, 'index.html'), 'utf8');
   fs.writeFileSync(
      path.join(outAbs, 'index.html'),
      `<!--\n  Leji viewer (leji viewer build).\n  ${PROTECT_WARNING}\n-->\n${indexHtml}`,
   );

   return { out: outDisplay, findings: gen.findings };
}

const CONTENT_TYPES: Record<string, string> = {
   '.html': 'text/html; charset=utf-8',
   '.md': 'text/markdown; charset=utf-8',
   '.js': 'text/javascript; charset=utf-8',
   '.mjs': 'text/javascript; charset=utf-8',
   '.css': 'text/css; charset=utf-8',
   '.json': 'application/json; charset=utf-8',
   '.svg': 'image/svg+xml',
   '.png': 'image/png',
   '.jpg': 'image/jpeg',
   '.jpeg': 'image/jpeg',
   '.gif': 'image/gif',
   '.ico': 'image/x-icon',
   '.txt': 'text/plain; charset=utf-8',
   '.woff': 'font/woff',
   '.woff2': 'font/woff2',
};

/**
 * Serve the viewer at the web root, bound to 127.0.0.1 (a local preview, never
 * hosting). A virtual mount, no symlinks: the contained viewer chrome
 * (rootPath/.leji/viewer/) is served at `/`, and the layer's markdown
 * (rootPath/) under `/content/`. So `/` -> viewer/index.html,
 * `/assets/*` -> viewer/..., `/content/_sidebar.md` -> the generated
 * sidebar in viewer/, and `/content/*` -> the real content docs. The internal
 * .leji path is reachable only through these mounts, never by a direct URL.
 * Returns the listening server; port 0 picks a free port.
 */
export function serveViewer(root: string, port: number, rootRel = ''): Promise<http.Server> {
   const rootAbs = fs.realpathSync(path.resolve(root));
   const base = stripSlash(rootRel);
   const contentAbs = base && base !== '.' ? path.join(rootAbs, base) : rootAbs;
   const viewerAbs = path.join(contentAbs, '.leji', 'viewer');

   // Serve `sub` (a clean relative path) from under `mountRoot`; '' -> index.html.
   // realpath-contains the resolved target under its mount so a symlink can't escape.
   const serveFrom = (res: http.ServerResponse, mountRoot: string, sub: string): void => {
      let abs = sub === '' ? path.join(mountRoot, 'index.html') : path.join(mountRoot, sub);
      if (abs !== mountRoot && !abs.startsWith(mountRoot + path.sep)) {
         res.writeHead(403).end('forbidden');
         return;
      }
      try {
         if (fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
         const real = fs.realpathSync(abs);
         if (real !== mountRoot && !real.startsWith(mountRoot + path.sep)) {
            res.writeHead(403).end('forbidden');
            return;
         }
         const body = fs.readFileSync(abs);
         res.writeHead(200, {
            'content-type': CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
         });
         res.end(body);
      } catch {
         res.writeHead(404).end('not found');
      }
   };

   const server = http.createServer((req, res) => {
      let urlPath: string;
      try {
         // A malformed percent-encoding (e.g. GET /%E0%A4%A) throws URIError;
         // answer 400 rather than letting it crash the server.
         urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      } catch {
         res.writeHead(400).end('bad request');
         return;
      }
      const rel = path.normalize(urlPath).replace(/^([/\\])+/, '');
      // Refuse any dotfile or VCS-internal segment in the REQUEST path: the .leji
      // viewer dir is reached only through the mounts below, never by direct URL.
      if (rel.split(/[/\\]/).some((seg) => seg === '.git' || (seg.startsWith('.') && seg !== '.' && seg !== ''))) {
         res.writeHead(404).end('not found');
         return;
      }
      // The generated sidebar lives in the viewer dir but is served as if at the
      // content root, so Docsify's basePath /content/ + _sidebar alias resolve it.
      if (rel === 'content/_sidebar.md') {
         serveFrom(res, viewerAbs, '_sidebar.md');
         return;
      }
      if (rel === 'content' || rel.startsWith('content/')) {
         serveFrom(res, contentAbs, rel === 'content' ? '' : rel.slice('content/'.length));
         return;
      }
      // Everything else (`/`, /index.html, /assets/*) is viewer chrome.
      serveFrom(res, viewerAbs, rel);
   });
   return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server));
   });
}

/**
 * Best-effort open of `url` in the default browser, used by `--open` / `leji view`.
 * Never throws and never blocks: a missing opener is a silent no-op, since opening
 * the browser is a convenience, not part of serving.
 */
export function openBrowser(url: string): void {
   const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
   const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
   try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
   } catch {
      /* opening the browser is best-effort */
   }
}
