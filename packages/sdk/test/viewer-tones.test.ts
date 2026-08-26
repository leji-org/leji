import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The viewer's typography is three named tones, and this is the mechanism that
// keeps it that way.
//
// `templates/viewer/assets/vue.css` is a recolored copy of the stock docsify "vue"
// theme. Every neutral below is one the stock theme shipped and the Leji theme
// replaced: they came back once already, through a theme refresh nobody diffed by
// eye, and nothing failed. A blanket "no hex literals" rule cannot work here
// (inverse text on a colored ground, the Prism token palette, and the accent
// fallbacks are all literal by design), so the contract is the narrower one the
// token block states: these specific legacy values, and no others, are denied.
//
// A neutral that belongs on this list is one the theme no longer uses; adding a
// tone to the token block does not add it here.

const LEGACY_NEUTRALS = [
   '#34495e',
   '#2c3e50',
   '#555',
   '#555555',
   '#999999',
   '#1a1a1a',
   '#9aa0a6',
   '#364149',
   '#505d6b',
   '#777',
   '#858585',
   '#7f8c8d',
   '#42b983',
] as const;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const viewerDir = path.join(repoRoot, 'templates', 'viewer');

/** The authored viewer sources: this theme's own files, never the vendored
 * third-party bundles beside them, whose colors are their upstream's business. */
const AUTHORED = ['index.html', path.join('assets', 'vue.css')];

for (const rel of AUTHORED) {
   test(`templates/viewer/${rel.split(path.sep).join('/')} carries no legacy neutral`, () => {
      const file = path.join(viewerDir, rel);
      assert.ok(fs.existsSync(file), `the authored source exists: ${rel}`);
      const lines = fs.readFileSync(file, 'utf8').split('\n');

      const hits: string[] = [];
      for (const [index, line] of lines.entries()) {
         const lowered = line.toLowerCase();
         for (const neutral of LEGACY_NEUTRALS) {
            if (lowered.includes(neutral)) hits.push(`${rel}:${index + 1}: ${neutral} in ${line.trim()}`);
         }
      }
      // Every site is reported, not just the first: a refresh that brings the greys
      // back brings several at once, and one failure per run would hide the rest.
      assert.deepEqual(hits, [], `legacy neutrals are replaced by the named tones:\n${hits.join('\n')}`);
   });
}
