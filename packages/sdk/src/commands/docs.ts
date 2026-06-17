import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { type Finding } from '../lib/findings.js';
import { stripSlash } from '../lib/fsx.js';
import { type Manifest, CATEGORY_IDS } from '../lib/manifest.js';
import { templatesDir } from '../lib/schemas.js';
import { generateIndex } from './indexgen.js';

/** Preview-port precedence: explicit --port, then manifest docs.port, then 5354 (LEJI on a phone keypad). */
export function resolveDocsPort(manifest: Manifest, flagPort?: number): number {
   return flagPort ?? manifest.docs?.port ?? 5354;
}

export interface DocsResult {
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

/**
 * Project a deterministic Docsify sidebar from the live index: categories in
 * their canonical order, entries sorted by path, paths relative to rootPath.
 */
export function buildSidebar(manifest: Manifest, entries: { path: string; title: string; category: string }[]): string {
   // Ungrouped entries (the boot profile) sit above a divider; the category
   // groups follow below it, giving the viewer a two-tier sidebar.
   const topLines: string[] = [];
   const boot = relativeToRoot(manifest.bootProfilePath, manifest.rootPath);
   if (boot) topLines.push(`- [Boot profile](${boot})`);
   const groupLines: string[] = [];
   for (const category of CATEGORY_IDS) {
      const inCategory = entries
         .filter((e) => e.category === category)
         .map((e) => ({ ...e, rel: relativeToRoot(e.path, manifest.rootPath) }))
         .filter((e): e is typeof e & { rel: string } => e.rel !== null);
      if (inCategory.length === 0) continue;
      groupLines.push(`- ${CATEGORY_LABELS[category]}`);
      for (const entry of inCategory) {
         groupLines.push(`  - [${entry.title}](${entry.rel})`);
      }
   }
   const sections = [topLines, groupLines].filter((s) => s.length > 0).map((s) => s.join('\n'));
   return sections.join('\n\n---\n\n') + '\n';
}

/**
 * Generate the static docs viewer into the context root: a Docsify
 * `index.html` (frontmatter-stripping hook included) and a `_sidebar.md`
 * projected from the index. Presentation is non-normative; this is the
 * reference projection of context-index.json into a browsable surface.
 */
export function generateDocs(root: string, manifest: Manifest): DocsResult {
   const result = generateIndex(root, manifest);
   const entries = result.index?.entries ?? [];

   const boot = relativeToRoot(manifest.bootProfilePath, manifest.rootPath) ?? 'boot-profile.md';
   const html = fs
      .readFileSync(path.join(templatesDir(), 'docs-viewer.html'), 'utf8')
      .replaceAll('{{LEJI_NAME_HTML}}', htmlEscape(manifest.name))
      .replaceAll('{{DOCSIFY_CONFIG}}', jsonForScript({ name: manifest.name, homepage: boot }));
   const sidebar = buildSidebar(manifest, entries);

   const rootDir = stripSlash(manifest.rootPath) || '.';
   const written: string[] = [];
   for (const [name, content] of [
      ['index.html', html],
      ['_sidebar.md', sidebar],
   ] as const) {
      const rel = rootDir === '.' ? name : `${rootDir}/${name}`;
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      written.push(rel);
   }

   // Copy every vendored viewer asset (Docsify core, theme, and the search +
   // sidebar-collapse plugins) alongside the generated page so nothing loads
   // from a remote CDN. The provenance note is documentation, never shipped.
   const assetsSrc = path.join(templatesDir(), 'docs-viewer-assets');
   const assetsRel = rootDir === '.' ? 'docs-viewer-assets' : `${rootDir}/docs-viewer-assets`;
   const assetsAbs = path.join(root, assetsRel);
   fs.mkdirSync(assetsAbs, { recursive: true });
   for (const asset of fs.readdirSync(assetsSrc).sort()) {
      if (asset === 'PROVENANCE.txt' || asset.startsWith('.')) continue;
      const bytes = fs.readFileSync(path.join(assetsSrc, asset));
      fs.writeFileSync(path.join(assetsAbs, asset), bytes);
      written.push(`${assetsRel}/${asset}`);
   }

   return { written, findings: result.findings, entries: entries.length };
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
 * Serve the repository root as a static site, bound to 127.0.0.1 (a local
 * preview, never hosting). Mirrors Python's stdlib http.server, so both SDKs
 * behave identically. Returns the listening server; port 0 picks a free port.
 */
export function serveDocs(root: string, port: number): Promise<http.Server> {
   const rootAbs = fs.realpathSync(path.resolve(root));
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
      try {
         const rel = path.normalize(urlPath).replace(/^([/\\])+/, '');
         // Refuse any dotfile or VCS-internal segment outright.
         if (rel.split(/[/\\]/).some((seg) => seg === '.git' || (seg.startsWith('.') && seg !== '.' && seg !== ''))) {
            res.writeHead(404).end('not found');
            return;
         }
         let abs = path.resolve(rootAbs, rel);
         // Lexical containment first (catches non-existent escaping paths).
         if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
            res.writeHead(403).end('forbidden');
            return;
         }
         if (fs.statSync(abs).isDirectory()) {
            // Redirect a directory request without a trailing slash so the
            // viewer's relative asset paths resolve (e.g. /docs -> /docs/).
            if (!urlPath.endsWith('/')) {
               res.writeHead(301, { Location: urlPath + '/' }).end();
               return;
            }
            abs = path.join(abs, 'index.html');
         }
         // Symlink containment: the resolved target must stay under the root.
         const real = fs.realpathSync(abs);
         if (real !== rootAbs && !real.startsWith(rootAbs + path.sep)) {
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
   });
   return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server));
   });
}
