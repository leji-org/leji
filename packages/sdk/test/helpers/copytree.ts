import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Copy `src` into `dest` for a test, leaving out every entry named `.leji`. A local
 * `leji view` leaves its gitignored viewer build in the working tree, and a copy that
 * carried it would change what the export, viewer, and conformance tests see.
 */
export function copyTree(src: string, dest: string): void {
   fs.cpSync(src, dest, { recursive: true, filter: (from) => path.basename(from) !== '.leji' });
}
