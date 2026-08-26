// A plain static host for an exported context layer, with no dependency of its
// own: the export's claim is that any static host serves it, so the export spec
// must judge it through something that behaves like one and adds nothing. The
// viewer's own `leji viewer serve` would not prove that: it generates the
// sidebar and the context index per request, which a bucket never does.
//
//   node static-server.mjs <dir> <port>
//
// GET/HEAD only, files under <dir> only, a directory resolving to its
// index.html, everything else 404.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

// Every extension the export writes, so a real render is judged: the chrome
// (html/js/css/svg), the layer's markdown and its context index, the vendored
// fonts (a woff2 served as octet-stream still renders, but a 404 would show up
// as a console error and would be this server's fault, not the export's), and
// the licence text beside them.
const CONTENT_TYPES = {
   '.html': 'text/html; charset=utf-8',
   '.js': 'text/javascript; charset=utf-8',
   '.mjs': 'text/javascript; charset=utf-8',
   '.css': 'text/css; charset=utf-8',
   '.json': 'application/json; charset=utf-8',
   '.md': 'text/markdown; charset=utf-8',
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

const [dirArg, portArg] = process.argv.slice(2);
if (!dirArg || !portArg) {
   console.error('usage: node static-server.mjs <dir> <port>');
   process.exit(2);
}
const root = fs.realpathSync(path.resolve(dirArg));
const port = Number(portArg);

/** True when a path is the served root or sits under it. */
function contained(abs) {
   return abs === root || abs.startsWith(root + path.sep);
}

/** A path with every symlink resolved, or null when it does not exist. */
function real(abs) {
   try {
      return fs.realpathSync(abs);
   } catch {
      return null;
   }
}

/**
 * The file a request addresses, or null for anything outside the served
 * directory. Containment is judged twice: once on the lexically joined path, and
 * again on the path with every symlink resolved, because `statSync` and
 * `readFileSync` both follow links and a link planted under the export would
 * otherwise hand out any file this process can read. A directory's `index.html`
 * is resolved and re-checked the same way, since it is a second path.
 */
function resolveTarget(urlPath) {
   let decoded;
   try {
      decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
   } catch {
      return null;
   }
   const requested = path.join(root, path.normalize(decoded).replace(/^(\.\.[/\\])+/, ''));
   if (!contained(requested)) return null;
   const resolved = real(requested);
   if (resolved === null || !contained(resolved)) return null;
   let stat;
   try {
      stat = fs.statSync(resolved);
   } catch {
      return null;
   }
   if (stat.isDirectory()) {
      const index = real(path.join(resolved, 'index.html'));
      if (index === null || !contained(index)) return null;
      return fs.statSync(index).isFile() ? index : null;
   }
   return stat.isFile() ? resolved : null;
}

const server = http.createServer((req, res) => {
   if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
   }
   const file = resolveTarget(req.url ?? '/');
   if (file === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
   }
   const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
   const body = fs.readFileSync(file);
   res.writeHead(200, { 'content-type': type, 'content-length': body.length });
   if (req.method === 'HEAD') res.end();
   else res.end(body);
});

server.listen(port, '127.0.0.1', () => {
   console.log(`static export → http://127.0.0.1:${port}/`);
});
