// Where the repository is, for every page that reads a published file off disk.
//
// The pages render the schemas, the specification, the CLI surface and the example
// manifest from the repository itself, so they need its path, and the working directory
// is not it: `astro dev`, `astro build` and `astro preview` are run from the repository
// root as readily as from this package. The module's own location is the stable answer,
// but only as a place in the tree, never as a fixed count of directories above it: a
// build runs this code from a chunk emitted under the output directory rather than from
// the source file. So the root is found rather than counted, by walking up until the
// manifest only the repository root carries appears. That converges on the same
// directory from the source file under `astro dev` and under plain Node, and from the
// emitted chunk under `astro build`, because the chunk is written inside this package.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The manifest that marks the repository root, and nothing else in the tree. */
const MARKER = 'leji.json';

function findRepoRoot(from: string): string {
   for (let at = from; ; ) {
      if (fs.existsSync(path.join(at, MARKER))) return at;
      const up = path.dirname(at);
      if (up === at) throw new Error(`no ${MARKER} above ${from}: the site is being built outside the repository`);
      at = up;
   }
}

/** The repository root: the nearest directory at or above this module holding the
 *  manifest. Every repository-root-relative path a page reads is joined onto this. */
export const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

/** This package's own directory, for the few files a page reads from beside its source
 *  rather than from the repository at large. */
export const SITE_ROOT = path.join(REPO_ROOT, 'packages', 'site');
