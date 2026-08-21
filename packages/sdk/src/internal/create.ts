/**
 * INTERNAL, UNVERSIONED. Reached only through `@leji-org/leji/internal/create`, and
 * only by `create-leji` in this repository. It carries no semver promise: it may change
 * shape or disappear in any release, and nothing outside this repository should import
 * it. The stable surfaces are the CLI and the package root export.
 *
 * One purpose-specific classifier so the `npm create leji` router and `leji adopt`
 * cannot disagree about what an existing repository looks like. The rule lives here
 * once, over adopt's own docs-root and vendor-entrypoint data.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOCS_CANDIDATES, pickDocsRoot } from '../commands/init.js';
import { KNOWN_VENDOR_FILES } from '../commands/validate.js';
import { isDir, isFile, stripSlash } from '../lib/fsx.js';

export { DOCS_CANDIDATES } from '../commands/init.js';
export { KNOWN_VENDOR_FILES } from '../commands/validate.js';

/**
 * What a caller-selected directory is, for the one decision `create-leji` makes:
 *
 *   'missing'     nothing stands there              -> `leji init` creates it
 *   'unreadable'  cannot be listed as a directory   -> refuse; a broken symlink, a
 *                 file, or a directory we may not read is never guessed at
 *   'adopted'     a `leji.json` manifest is there   -> nothing to bootstrap
 *   'adopt'       a docs root or an agent entrypoint already exists
 *   'init'        anything else
 */
export type CreateTargetState = 'missing' | 'unreadable' | 'adopted' | 'adopt' | 'init';

/**
 * The real path of `rel` under the already-resolved target, or null when it does not
 * resolve to something inside it.
 *
 * Every path this classifier inspects goes through here, because each one is a place a
 * symlink can point somewhere else: a `docs` link, a `leji.json` link, or an escaping
 * `.github` two components up from the entry that was named. `realpathSync` resolves the
 * whole chain, so an intermediate link is caught as surely as a final one, and the answer
 * is checked against the target before anything is read. An entry that escapes, or that
 * dangles, is simply not there as far as routing is concerned: the classifier reports no
 * finding of its own and writes nothing, since its only job is to name the command that
 * runs next, and `init`/`adopt` enforce their own preconditions on the paths they touch.
 */
function insideTarget(rootReal: string, rel: string): string | null {
   let real: string;
   try {
      real = fs.realpathSync(path.join(rootReal, rel));
   } catch {
      return null;
   }
   return withinRoot(rootReal, real) ? real : null;
}

/**
 * Is `real` the target `rootReal` or something under it? Both are already-resolved
 * absolute paths, so this is a pure comparison of strings and the one place the rule
 * lives. Exported for its own tests: a filesystem root is the case that cannot be
 * exercised by classifying a real directory.
 *
 * A filesystem root is its own separator. `path.parse` names it per platform (`/`, and
 * `C:\` on Windows), and appending another separator there would ask whether `/foo`
 * starts with `//`, which it does not: every child of a root target would have read as
 * an escape. Everywhere else the separator has to be appended, or `/repo` would claim
 * `/repository` as its own.
 */
export function withinRoot(rootReal: string, real: string): boolean {
   if (real === rootReal) return true;
   const prefix = rootReal === path.parse(rootReal).root ? rootReal : rootReal + path.sep;
   return real.startsWith(prefix);
}

/**
 * Classify the selected target directory. Reads a directory listing and a handful of
 * exact target-relative paths; writes nothing, and never searches recursively, so
 * pointing it at one package of a monorepo classifies that package rather than the
 * repository around it.
 *
 * Nothing outside the target decides the answer. The target is resolved first, so the
 * classification and the command that follows it look at the same directory, and every
 * path inspected under it is resolved and required to land inside it (`insideTarget`):
 * a `docs` or `leji.json` that is a symlink out of the target, and an entry reached
 * through a symlinked parent, count as absent rather than as evidence.
 */
export function classifyTarget(dir: string): CreateTargetState {
   let real: string;
   try {
      real = fs.realpathSync(dir);
   } catch (err) {
      // ENOENT from realpath is either "nothing there" or a dangling symlink, and the
      // two want opposite answers: `init` creates a missing directory, but it would
      // write through a broken link into a path the caller did not name. `lstat` is
      // what separates them, since it succeeds on the link itself.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
         try {
            fs.lstatSync(dir);
            return 'unreadable';
         } catch {
            return 'missing';
         }
      }
      return 'unreadable';
   }

   let names: string[];
   try {
      names = fs.readdirSync(real);
   } catch {
      // EACCES (unreadable directory) and ENOTDIR (the target is a file) alike: the
      // state cannot be established, so no command runs.
      return 'unreadable';
   }

   const manifest = insideTarget(real, 'leji.json');
   if (manifest !== null && isFile(manifest)) return 'adopted';

   // Only the names a docs candidate could match are resolved: `pickDocsRoot` never
   // matches anything else, and the listing of a repository root is not worth a realpath
   // per entry.
   const wanted = new Set(DOCS_CANDIDATES.map((c) => stripSlash(c).toLowerCase()));
   const docsDirs = names.filter((n) => {
      if (!wanted.has(n.toLowerCase())) return false;
      const abs = insideTarget(real, n);
      return abs !== null && isDir(abs);
   });
   if (pickDocsRoot(docsDirs) !== null) return 'adopt';

   // Presence, not `isFile`, because the question here is whether the repository already
   // carries agent context, not whether `adopt` will rewrite the entry: `.cursor/rules`
   // is a directory in a real Cursor repository.
   if (KNOWN_VENDOR_FILES.some((rel) => insideTarget(real, rel) !== null)) return 'adopt';

   return 'init';
}
