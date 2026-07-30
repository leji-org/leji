import * as fs from 'node:fs';
import * as path from 'node:path';

export function toPosix(p: string): string {
   return p.split(path.sep).join('/');
}

export function exists(abs: string): boolean {
   return fs.existsSync(abs);
}

export function isDir(abs: string): boolean {
   try {
      return fs.statSync(abs).isDirectory();
   } catch {
      return false;
   }
}

export function isFile(abs: string): boolean {
   try {
      return fs.statSync(abs).isFile();
   } catch {
      return false;
   }
}

export function readText(abs: string): string {
   return fs.readFileSync(abs, 'utf8');
}

/**
 * Read a declared file's text, only if it is a regular file whose real path stays
 * within `rootAbs`. Returns null when missing, not a regular file, or symlinked
 * out of root. Use for every manifest-declared path so a hostile layer cannot use
 * a symlink to redirect a reader (CLI, or MCP exposing reads to an agent) out.
 */
export function readTextWithin(rootAbs: string, abs: string): string | null {
   if (!isFile(abs) || !realpathWithin(rootAbs, abs)) return null;
   return readText(abs);
}

/**
 * True when `abs` resolves (following symlinks) within `rootAbs`. Escaping
 * symlinks are rejected; a non-existent path cannot escape, so it is allowed.
 */
export function realpathWithin(rootAbs: string, abs: string): boolean {
   let resolvedRoot: string;
   try {
      resolvedRoot = fs.realpathSync(rootAbs);
   } catch {
      return false;
   }
   let real: string;
   try {
      real = fs.realpathSync(abs);
   } catch {
      return true; // non-existent target cannot point outside via a symlink
   }
   return real === resolvedRoot || real.startsWith(resolvedRoot + path.sep);
}

/**
 * True when `abs` resolves (following symlinks) within `rootAbs`, even when `abs`
 * does not yet exist. Unlike `realpathWithin`, a non-existent target is checked
 * via its nearest existing ancestor, so a symlinked ancestor that escapes root is
 * caught before a write creates the file under it.
 */
export function resolvedWithinRoot(rootAbs: string, abs: string): boolean {
   let real: string;
   try {
      real = fs.realpathSync(abs); // path exists (e.g. overwrite target / vendor file)
   } catch {
      // Does not exist yet: resolve the nearest existing ancestor, then re-append.
      let p = path.dirname(abs);
      while (!fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
      try {
         real = path.join(fs.realpathSync(p), path.relative(p, abs));
      } catch {
         return false;
      }
   }
   let realRoot: string;
   try {
      realRoot = fs.realpathSync(rootAbs);
   } catch {
      return false;
   }
   return real === realRoot || real.startsWith(realRoot + path.sep);
}

/**
 * Recursively collect markdown files under a declared path (file or directory) as
 * repo-root-relative POSIX paths, sorted. Symlink-escaping entries are excluded.
 */
export function walkMd(root: string, relPath: string): string[] {
   const rootAbs = path.resolve(root);
   const abs = path.join(root, relPath);
   if (isFile(abs)) {
      return relPath.endsWith('.md') && realpathWithin(rootAbs, abs) ? [toPosix(relPath)] : [];
   }
   if (!isDir(abs)) return [];
   const out: string[] = [];
   const stack: string[] = [abs];
   while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
         if (entry.name.startsWith('.')) continue;
         const full = path.join(dir, entry.name);
         if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            if (!realpathWithin(rootAbs, full)) continue;
            stack.push(full);
         } else if (entry.isFile() && entry.name.endsWith('.md')) {
            if (!realpathWithin(rootAbs, full)) continue;
            out.push(toPosix(path.relative(root, full)));
         }
      }
   }
   return out.sort();
}

/**
 * All markdown files under a context path, repo-relative POSIX, sorted. Used by
 * the viewer sidebar; shares walkMd's dotfile/node_modules skip and symlink
 * containment, so the `.leji` viewer dir is never traversed.
 */
export function walkTree(root: string, relPath: string): string[] {
   return walkMd(root, relPath);
}

/** Normalize a declared directory path for prefix comparison: no trailing slash. */
export function stripSlash(p: string): string {
   return p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Join a sub-path under a context root with POSIX semantics, treating `.` or
 * empty root as the repo root: `joinUnderRoot('.', 'context/')` is `context/`,
 * never the hidden `.context/` a bare concatenation would produce.
 */
export function joinUnderRoot(rootPath: string, sub: string): string {
   const base = stripSlash(rootPath);
   return base === '' || base === '.' ? sub : `${base}/${sub}`;
}

/** True when relPath is the declared path itself or falls under it (POSIX). */
export function underPath(relPath: string, declared: string): boolean {
   const base = stripSlash(declared);
   if (base === '' || base === '.') return true; // root: everything is under it
   return relPath === base || relPath.startsWith(base + '/');
}
