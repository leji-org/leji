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
 * True when `abs` resolves (following symlinks) to a path that remains within
 * `rootAbs` (itself resolved). Symlinks that escape the served/scanned root are
 * rejected. A path that does not yet exist cannot escape, so it is allowed.
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
      // Non-existent target: it cannot point outside via a symlink.
      return true;
   }
   return real === resolvedRoot || real.startsWith(resolvedRoot + path.sep);
}

/**
 * Recursively collect markdown files under a declared path (file or directory),
 * returned as repository-root-relative POSIX paths, sorted. Entries whose real
 * path (after resolving symlinks) escapes `root` are excluded.
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

/** Normalize a declared directory path for prefix comparison: no trailing slash. */
export function stripSlash(p: string): string {
   return p.endsWith('/') ? p.slice(0, -1) : p;
}

/** True when relPath is the declared path itself or falls under it (POSIX). */
export function underPath(relPath: string, declared: string): boolean {
   const base = stripSlash(declared);
   // An empty or "." root means the repository root: everything is under it.
   if (base === '' || base === '.') return true;
   return relPath === base || relPath.startsWith(base + '/');
}
