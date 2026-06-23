import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve a client-supplied layer root to a real, existing directory. The SDK
 * already confines its reads to the root it is handed; the MCP server resolves
 * the root up front (defense in depth) so a missing or non-directory argument fails with
 * a clear error instead of surfacing as confusing findings, and so the path
 * passed into the SDK is the canonical realpath. Throws on a missing path or a
 * path that is not a directory.
 */
export function resolveRoot(root: string): string {
   if (typeof root !== 'string' || root.length === 0) {
      throw new Error('root must be a non-empty path');
   }
   let real: string;
   try {
      real = fs.realpathSync(path.resolve(root));
   } catch {
      throw new Error(`layer root does not exist: ${root}`);
   }
   if (!fs.statSync(real).isDirectory()) {
      throw new Error(`layer root is not a directory: ${root}`);
   }
   return real;
}
