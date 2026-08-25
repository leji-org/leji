import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { finding } from '../lib/findings.js';
import { openVerifiedSource, resolvedPath, resolvedWithinRoot, stripSlash, walkTree } from '../lib/fsx.js';
import { VIEWER_REL, servablePath, writableTarget } from '../lib/layout.js';
import { type Manifest, effectiveIndexPath, loadManifest } from '../lib/manifest.js';
import { generateIndex } from './indexgen.js';
import {
   type IndexEntryLite,
   ACTIVE_EXTENSIONS,
   OVERVIEW_REL,
   assembleSidebar,
   declaresInherits,
   relativeToRoot,
   renderOverview,
   resolvedProfilePage,
   unresolvedProfilePage,
} from './viewer.js';

/**
 * The local preview server: the ONE module that speaks HTTP. The export pipeline
 * lives in `export.ts` and the chrome generation in `viewer.ts`, neither of which
 * imports this file or any network module — that separation is what makes the
 * export's no-network guarantee checkable by a module-graph test rather than by
 * reading the code.
 */

/** The SPA shell's policy, sent as a response header on every chrome response so
 * it holds for documents reached outside the shell too. Mirrors the meta in
 * templates/viewer/index.html; keep the two in step. */
const CSP_CHROME =
   "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'";

/** The policy for everything served out of the layer itself. `sandbox` with no
 * tokens puts a /content/ document in an opaque origin with scripting off, so a
 * governed file framed or opened directly is inert rather than same-origin code. */
const CSP_CONTENT = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox";

/** The host names the local preview answers to. A missing Host is accepted (an
 * HTTP/1.0 client omits it); anything else is a request that reached the loopback
 * socket under somebody else's name. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when the Host header names the loopback interface: hostname only, since
 * the port a request arrives on is already fixed by the loopback bind. */
export function loopbackHost(host: string | undefined): boolean {
   if (host === undefined || host === '') return true;
   const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
   return LOOPBACK_HOSTS.has(name.toLowerCase());
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
 * A request URL path as a clean relative route key. Separators fold to `/` and
 * the path is cleaned against a root, so one request has one route key on any
 * platform — `path.normalize` follows the host and answered differently on
 * Windows, missing every `content/` route test. Canonicalization only; the mount
 * enforces containment.
 */
export function urlPathToRel(urlPath: string): string {
   const cleaned = path.posix.normalize('/' + urlPath.replaceAll('\\', '/'));
   // Trimmed by index rather than by regex. `normalize` has already collapsed every
   // run of separators, so an anchored `/\/+$/` could only ever match one character
   // here, but that is an invariant of another function: a linear scan holds on its
   // own and does not read as a polynomial regex over a request path.
   let start = 0;
   let end = cleaned.length;
   while (start < end && cleaned.charCodeAt(start) === 47) start++;
   while (end > start && cleaned.charCodeAt(end - 1) === 47) end--;
   return cleaned.slice(start, end);
}

/**
 * Serve the viewer at the web root, bound to 127.0.0.1 (local preview, never
 * hosting). Two virtual mounts and nothing else — the servable roots: chrome
 * (`.leji/viewer/`) at `/`, layer markdown (`rootPath/`) under `/content/`;
 * `/content/_sidebar.md` maps to the generated sidebar in viewer/. Everything else
 * under `.leji/` is denied by name, so the private roles are unreachable however
 * the request is spelled and whatever a symlink under the content root points at.
 * Returns the listening server; port 0 picks free.
 *
 * `opts.entries` is an index snapshot for the initial layer map: a caller that has
 * just generated the viewer hands over what it projected, and a caller that passes
 * none gets one live generation at startup instead.
 */
export function serveViewer(
   root: string,
   port: number,
   rootRel = '',
   opts: { log?: (line: string) => void; entries?: IndexEntryLite[] } = {},
): Promise<http.Server> {
   const rootAbs = fs.realpathSync(path.resolve(root));
   const base = stripSlash(rootRel);
   const contentAbs = base && base !== '.' ? path.join(rootAbs, base) : rootAbs;
   // The CLI passes a validated rootPath, but a direct SDK caller could pass an
   // escaping rootRel (e.g. ".."); refuse to mount content outside the layer root.
   if (!resolvedWithinRoot(rootAbs, contentAbs)) {
      throw new Error(`viewer root "${rootRel}" escapes the layer root`);
   }
   const viewerAbs = path.join(rootAbs, VIEWER_REL);
   // The content mount as it really is on disk: the boundary a resolved source is
   // judged against has to be resolved itself, or a symlinked `rootPath` component
   // would put every legitimate document outside its own mount.
   const contentReal = resolvedPath(contentAbs) ?? contentAbs;
   /** True when a RESOLVED path lies under the content mount. */
   const withinContent = (resolved: string): boolean => resolved.startsWith(contentReal + path.sep);

   // Serve `sub` (a clean relative path) from under `mountRoot`; '' -> index.html.
   // realpath-contains the resolved target under its mount so a symlink can't escape.
   // `inert` marks the layer's own content mount, whose files are never given an
   // active content type however they are named.
   const serveFrom = (res: http.ServerResponse, mountRoot: string, sub: string, inert = false): void => {
      let abs = sub === '' ? path.join(mountRoot, 'index.html') : path.join(mountRoot, sub);
      if (abs !== mountRoot && !abs.startsWith(mountRoot + path.sep)) {
         res.writeHead(403).end('forbidden');
         return;
      }
      // The servable-roots whitelist: under `.leji/`, only `viewer/` is servable.
      // Judged by name on the requested path and again on the resolved one, so a
      // symlink under the content root cannot reach a private role either.
      if (!servablePath(rootAbs, abs)) {
         res.writeHead(404).end('not found');
         return;
      }
      try {
         if (fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
         const real = fs.realpathSync(abs);
         if (real !== mountRoot && !real.startsWith(mountRoot + path.sep)) {
            res.writeHead(403).end('forbidden');
            return;
         }
         if (!servablePath(rootAbs, real)) {
            res.writeHead(404).end('not found');
            return;
         }
         const body = fs.readFileSync(real);
         const ext = path.extname(real).toLowerCase();
         res.writeHead(200, {
            'content-type':
               inert && ACTIVE_EXTENSIONS.has(ext)
                  ? 'text/plain; charset=utf-8'
                  : (CONTENT_TYPES[ext] ?? 'application/octet-stream'),
         });
         res.end(body);
      } catch {
         res.writeHead(404).end('not found');
      }
   };

   // Live-sidebar cache, invalidated by a tree fingerprint: one stat pass over
   // leji.json + every markdown file under the content root (paths, mtimes,
   // sizes — no content reads). The common unchanged-tree reload serves the
   // cached string at stat cost; any create, delete, or edit still lands on the
   // very next fetch. walkTree skips dotdirs, so the viewer's own artifacts
   // never invalidate the cache.
   let sidebarCache: {
      key: string;
      body: string;
      indexJson: string | null;
      manifest: Manifest;
      entries: IndexEntryLite[];
   } | null = null;
   const treeFingerprint = (): string => {
      const parts: string[] = [];
      const add = (rel: string): void => {
         try {
            const st = fs.statSync(path.join(rootAbs, rel));
            parts.push(`${rel}\u0000${st.mtimeMs}\u0000${st.size}`);
         } catch {
            parts.push(`${rel}\u0000gone`);
         }
      };
      add('leji.json');
      for (const rel of walkTree(rootAbs, base || '.')) add(rel);
      return parts.join('\n');
   };

   /** One live index generation behind every generated route, cached by the same
    * fingerprint: the sidebar, the served context index, and the overview map are
    * projections of ONE index per tree state, never of three. Null when the layer
    * cannot be indexed right now (no manifest, an error finding, or a generator that
    * threw), which is each route's cue to fall back. */
   const liveIndex = (cachedKey?: string): { manifest: Manifest; entries: IndexEntryLite[] } | null => {
      try {
         // Inside the guard, never in a default argument: a fingerprint pass over an
         // unreadable tree throws like anything else here, and that is a fallback.
         const key = cachedKey ?? treeFingerprint();
         if (sidebarCache !== null && sidebarCache.key === key) {
            return { manifest: sidebarCache.manifest, entries: sidebarCache.entries };
         }
         const { manifest } = loadManifest(rootAbs);
         if (manifest === null) return null;
         const idx = generateIndex(rootAbs, manifest);
         if (idx.findings.some((f) => f.severity === 'error')) return null;
         const entries = idx.index?.entries ?? [];
         sidebarCache = {
            key,
            body: assembleSidebar(rootAbs, manifest, entries, []),
            indexJson: idx.index ? JSON.stringify(idx.index, null, 2) + '\n' : null,
            manifest,
            entries,
         };
         return { manifest, entries };
      } catch {
         return null;
      }
   };

   // The layer map is process state, not a file. The overview route renders it into
   // the page's markers per fetch, from the live index above; the last index that
   // generated cleanly is kept, so a tree caught mid-edit still shows the map it last
   // had rather than a page with a hole in it. The initial one is computed here, by
   // the same generation the sidebar route makes per fetch, unless the caller handed
   // over the snapshot its own generation just produced.
   let lastGoodMap: { manifest: Manifest; entries: IndexEntryLite[] } | null = ((): {
      manifest: Manifest;
      entries: IndexEntryLite[];
   } | null => {
      if (opts.entries === undefined) return liveIndex();
      try {
         const { manifest } = loadManifest(rootAbs);
         return manifest === null ? null : { manifest, entries: opts.entries };
      } catch {
         return null;
      }
   })();

   const server = http.createServer((req, res) => {
      // Access log: one terse line per request, after the status is known.
      if (opts.log) {
         res.on('finish', () => opts.log!(`${req.method ?? 'GET'} ${req.url ?? '/'} ${res.statusCode}`));
      }
      // Policy headers ride every response, not just the SPA shell: a document
      // served straight out of /content/ is same-origin and would otherwise run
      // with no policy at all. Set before any write; the content mount downgrades
      // to the inert policy once the route is known.
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', CSP_CHROME);
      // Loopback binding alone does not stop DNS rebinding: a hostile page whose
      // name resolves to 127.0.0.1 reaches this server with its own Host. Only the
      // loopback names the viewer is actually addressed by are answered. The port is
      // deliberately not part of the test: a rebound request carries the right port
      // anyway, so matching it adds nothing. Don't "fix" this by checking it.
      if (!loopbackHost(req.headers.host)) {
         res.writeHead(403).end('forbidden');
         return;
      }
      let urlPath: string;
      try {
         // Concatenated, not resolved against a base: a target beginning with "//"
         // parses as protocol-relative, which moves its first segment into the host
         // and loses it. A malformed percent-encoding (e.g. GET /%E0%A4%A) throws
         // URIError; answer 400 rather than letting it crash the server.
         urlPath = decodeURIComponent(new URL('http://localhost' + (req.url ?? '/')).pathname);
      } catch {
         res.writeHead(400).end('bad request');
         return;
      }
      const rel = urlPathToRel(urlPath);
      if (rel === 'content' || rel.startsWith('content/')) res.setHeader('content-security-policy', CSP_CONTENT);
      // Refuse any dotfile or VCS-internal segment in the request path: the .leji
      // viewer dir is reached only through the mounts below, never by direct URL.
      if (rel.split(/[/\\]/).some((seg) => seg === '.git' || (seg.startsWith('.') && seg !== '.' && seg !== ''))) {
         res.writeHead(404).end('not found');
         return;
      }
      // The generated sidebar lives in the viewer dir but is served as if at the
      // content root, so Docsify's basePath /content/ + _sidebar alias resolves it.
      // Docsify fetches it once per page load, so it is rebuilt from the live tree
      // on every request: a long-running server never shows a deleted or moved
      // document. When the tree is mid-edit and will not index cleanly, fall back
      // to the last generated artifact rather than failing the dashboard.
      if (rel === 'content/_sidebar.md') {
         if (liveIndex() !== null && sidebarCache !== null) {
            res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
            res.end(sidebarCache.body);
            return;
         }
         serveFrom(res, viewerAbs, '_sidebar.md');
         return;
      }
      // The stored context index is served live (same fingerprint cache as the
      // sidebar), so per-page classification badges never disagree with the tree.
      if (rel.startsWith('content/')) {
         try {
            const { manifest } = loadManifest(rootAbs);
            const idxRel = manifest ? relativeToRoot(effectiveIndexPath(manifest), manifest.rootPath) : null;
            if (manifest && idxRel !== null && rel === `content/${idxRel}`) {
               const key = treeFingerprint();
               liveIndex(key);
               if (sidebarCache !== null && sidebarCache.key === key && sidebarCache.indexJson !== null) {
                  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                  res.end(sidebarCache.indexJson);
                  return;
               }
            }
         } catch {
            // fall through to the stored artifact
         }
      }
      // The generated Manifest page lives in the viewer dir (gitignored chrome) but
      // is linked from the sidebar and fetched under the content root, like
      // _sidebar.md. Reserved underscore name; served from the last generation.
      if (rel === 'content/_manifest.md') {
         serveFrom(res, viewerAbs, '_manifest.md');
         return;
      }
      // The overview homepage is served RENDERED: the source bytes with the layer map
      // substituted between the author's markers, so the counts a reader sees are the
      // ones the tree has right now and the committed file is never rewritten to say
      // so. The route is a content route first: it makes every check `serveFrom` makes
      // on this path, with the same answers, plus the generation guards (repository
      // containment, no private `.leji/` role), because this is the one content path
      // the tool also writes.
      //
      // EVERY one of those checks is bound to the VERIFIED target, not to a path
      // resolved beforehand: the guarded read judges the resolved location, opens it,
      // proves the descriptor is that same regular file, and the bytes come from that
      // descriptor. A pre-read `realpath` plus a separate read leaves the window this
      // closes: a link swapped in between resolves somewhere else (inside the
      // repository, outside the content mount) and the read follows it past a check
      // that judged the old target.
      if (rel === `content/${OVERVIEW_REL}`) {
         const abs = path.join(contentAbs, OVERVIEW_REL);
         // By name first, exactly as `serveFrom` does, before anything is resolved.
         if (!servablePath(rootAbs, abs)) {
            res.writeHead(404).end('not found');
            return;
         }
         const resolvedRoot = resolvedPath(rootAbs) ?? rootAbs;
         let source: Buffer | null = null;
         let landed: string | null = null;
         try {
            const { fd, real } = openVerifiedSource(
               abs,
               (resolved) =>
                  withinContent(resolved) &&
                  servablePath(rootAbs, resolved) &&
                  writableTarget(resolvedRoot, resolved, null).ok,
            );
            landed = real;
            if (fd !== null) {
               try {
                  source = fs.readFileSync(fd);
               } finally {
                  fs.closeSync(fd);
               }
            }
         } catch {
            source = null;
         }
         if (source === null) {
            // The refusal names where the source resolves NOW: outside the content
            // mount is the mount's own answer (403), and everything else (a private
            // role, a directory, an absent or unresolvable entry) is a plain miss.
            res.writeHead(landed !== null && !withinContent(landed) ? 403 : 404).end(
               landed !== null && !withinContent(landed) ? 'forbidden' : 'not found',
            );
            return;
         }
         // A live generation that fails outright (an unreadable content root, an
         // invalid manifest, a document the walk cannot read) serves the last map that
         // did generate; before the first one ever did, the source bytes as they are.
         // A source without markers is served unchanged whatever the index says.
         const index = liveIndex();
         if (index !== null) lastGoodMap = index;
         const map = index ?? lastGoodMap;
         const rendered = map === null ? null : renderOverview(source.toString('utf8'), map.manifest, map.entries);
         res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
         res.end(rendered !== null && rendered.markersFound ? rendered.text : source);
         return;
      }
      if (rel === 'content' || rel.startsWith('content/')) {
         const sub = rel === 'content' ? '' : rel.slice('content/'.length);
         // An agent profile that declares `inherits` is served resolved: the file
         // on disk is one half, and presenting it as the effective profile is the
         // thing a consumer must not do. So this branch fails closed. If anything
         // at all goes wrong, a file that declares `inherits` still gets a findings
         // page; only a file that is not half a profile falls through to disk.
         if (sub.endsWith('.md')) {
            const repoRel = base && base !== '.' ? `${base}/${sub}` : sub;
            let page: string | null = null;
            try {
               const { manifest } = loadManifest(rootAbs);
               page = manifest === null ? null : resolvedProfilePage(rootAbs, manifest, repoRel);
               if (page === null && manifest === null && declaresInherits(rootAbs, repoRel)) {
                  page = unresolvedProfilePage(repoRel, [
                     finding('artifact-parse', 'error', 'the layer manifest could not be read', 'leji.json'),
                  ]);
               }
            } catch (e) {
               page = declaresInherits(rootAbs, repoRel)
                  ? unresolvedProfilePage(repoRel, [
                       finding(
                          'artifact-parse',
                          'error',
                          `the viewer could not resolve this profile: ${(e as Error).message}`,
                          repoRel,
                       ),
                    ])
                  : null;
            }
            if (page !== null) {
               res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
               res.end(page);
               return;
            }
         }
         serveFrom(res, contentAbs, sub, true);
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
 * Best-effort open of `url` in the default browser (`--open` / `leji view`). Never
 * throws or blocks; a missing opener is a silent no-op.
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
