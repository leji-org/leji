import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The one tree-snapshot contract the badge and canary suites share. Both ask the same
// question of a tree (is it byte-identical to what it was?) and both used to answer it
// with their own private walker, so a fix to one reached the other only by hand. The
// contract lives here, is pinned by `fixtures/snapshot-contract/`, and is the same
// contract the Go and Python suites hold.

/** How a walk decides which `.git` is scaffolding. */
export interface SnapshotOptions {
   /**
    * The repository root whose `.git` is the harness's own scaffolding. Defaults to
    * `dir`, the whole-repository call; a subtree call passes the repository root
    * explicitly, so `snapshotTree(pkg, { repoRoot: repo })` records `pkg/.git` as the
    * content it is.
    */
   repoRoot?: string;
}

/**
 * Every entry under `dir` as one line, so a comparison covers appearance,
 * disappearance, content and entry kind:
 *
 * - regular file: `path<TAB>sha256:<hex>`
 * - directory: `path/<TAB>dir`, an entry of its own, so a created empty directory shows
 * - symlink or any other non-regular entry: `path<TAB>non-regular`, never followed
 *
 * Paths are POSIX and relative to `dir` itself, and the lines are sorted bytewise.
 *
 * Exactly one entry is excluded: `<repoRoot>/.git`, when it lies inside `dir`. That one
 * is the harness's scaffolding, and git's background maintenance rewrites it under a
 * running test. Every other `.git` (a nested package, a mount, a work directory) is
 * content and is walked like anything else.
 */
export function snapshotTree(dir: string, options: SnapshotOptions = {}): string[] {
   const root = path.resolve(dir);
   const excluded = path.join(path.resolve(options.repoRoot ?? dir), '.git');
   const lines: string[] = [];

   const walk = (rel: string): void => {
      const abs = rel === '' ? root : path.join(root, rel);
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
         const childAbs = path.join(abs, entry.name);
         if (childAbs === excluded) continue;
         const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
         if (entry.isDirectory()) {
            lines.push(`${childRel}/\tdir`);
            walk(childRel);
         } else if (entry.isFile()) {
            const digest = crypto.createHash('sha256').update(fs.readFileSync(childAbs)).digest('hex');
            lines.push(`${childRel}\tsha256:${digest}`);
         } else {
            lines.push(`${childRel}\tnon-regular`);
         }
      }
   };
   walk('');

   // Bytewise, not by UTF-16 code unit: the Go and Python ports sort their own bytes,
   // and the three orderings have to be the one ordering the goldens carry.
   return lines.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}
