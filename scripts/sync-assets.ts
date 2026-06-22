#!/usr/bin/env node
// Vendors the canonical /schemas and /templates into all three SDK packages
// (Node, Python, Go) with provenance metadata, keeps the Go SDK's embedded
// cli.json in sync with the canonical packages/sdk/cli.json, and bundles the
// /spec and /schemas into the MCP package (the spec's only vendored copy). Run
// after any spec, schema, template, or CLI-surface change; CI runs
// `npm run assets:check` to catch drift across every package.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

// Every SDK that bundles its own copy of the canonical schemas + templates.
// The Node package vendors them at its root; Python under src/leji/_assets;
// Go under internal/assets (embedded via //go:embed).
const TARGETS = [
   path.join(repoRoot, 'packages', 'sdk'),
   path.join(repoRoot, 'packages', 'sdk-py', 'src', 'leji', '_assets'),
   path.join(repoRoot, 'packages', 'sdk-go', 'internal', 'assets'),
];

// Single-file mirrors that are not under /schemas or /templates. cli.json is
// authored canonically in packages/sdk and embedded by the Go and Python SDKs;
// keep them byte-identical so the three CLIs describe the same surface.
const FILE_MIRRORS = [
   {
      src: path.join(repoRoot, 'packages', 'sdk', 'cli.json'),
      dest: path.join(repoRoot, 'packages', 'sdk-go', 'internal', 'assets', 'cli.json'),
   },
   {
      src: path.join(repoRoot, 'packages', 'sdk', 'cli.json'),
      dest: path.join(repoRoot, 'packages', 'sdk-py', 'src', 'leji', '_assets', 'cli.json'),
   },
];

function listFiles(dir: string): string[] {
   const out: string[] = [];
   for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listFiles(full));
      else out.push(full);
   }
   return out.sort();
}

function sha256(file: string): string {
   return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function gitHead(): string {
   try {
      return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
         encoding: 'utf8',
         stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
   } catch {
      return 'unknown';
   }
}

const sources: { rel: string; file: string; hash: string }[] = [];
for (const kind of ['schemas', 'templates']) {
   for (const file of listFiles(path.join(repoRoot, kind))) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      sources.push({ rel, file, hash: sha256(file) });
   }
}

const manifest = {
   specLine: '1.0',
   sourceCommit: gitHead(),
   files: Object.fromEntries(sources.map((s) => [s.rel, 'sha256:' + s.hash])),
};

let drift = false;

// Copy a single source file to a single destination, reporting/repairing drift.
function syncOne(file: string, dest: string, label: string): void {
   const same = fs.existsSync(dest) && sha256(dest) === sha256(file);
   if (same) return;
   drift = true;
   if (checkOnly) {
      console.error(`drift: ${path.relative(repoRoot, dest)} does not match ${label}`);
   } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      console.log(`synced ${path.relative(repoRoot, dest)}`);
   }
}

// Remove files left under a vendored dir when a canonical source is renamed or
// deleted, so a stale copy is never exposed (the MCP enumerates its asset dirs
// at runtime). In --check mode an extra file counts as drift. `keepRel` holds the
// allowed paths relative to `relBase`.
function pruneExtras(dir: string, keepRel: Set<string>, relBase: string): void {
   if (!fs.existsSync(dir)) return;
   for (const file of listFiles(dir)) {
      const rel = path.relative(relBase, file).split(path.sep).join('/');
      if (keepRel.has(rel)) continue;
      drift = true;
      if (checkOnly) {
         console.error(`drift: ${path.relative(repoRoot, file)} is not a canonical asset`);
      } else {
         fs.rmSync(file);
         console.log(`removed ${path.relative(repoRoot, file)}`);
      }
   }
}

// Write/compare a target's provenance manifest, ignoring the moving commit pointer.
function syncManifest(manifestDest: string, manifestObj: unknown): void {
   const manifestText = JSON.stringify(manifestObj, null, 2) + '\n';
   const current = fs.existsSync(manifestDest) ? fs.readFileSync(manifestDest, 'utf8') : '';
   const stripCommit = (text: string): string => text.replace(/"sourceCommit": "[^"]*"/, '"sourceCommit": ""');
   if (stripCommit(current) === stripCommit(manifestText)) return;
   drift = true;
   if (checkOnly) {
      console.error(`drift: ${path.relative(repoRoot, manifestDest)} is out of date`);
   } else {
      fs.writeFileSync(manifestDest, manifestText);
      console.log(`synced ${path.relative(repoRoot, manifestDest)}`);
   }
}

for (const target of TARGETS) {
   for (const { rel, file } of sources) {
      syncOne(file, path.join(target, rel), rel);
   }
   syncManifest(path.join(target, 'assets-manifest.json'), manifest);
}

for (const { src, dest } of FILE_MIRRORS) {
   syncOne(src, dest, path.relative(repoRoot, src).split(path.sep).join('/'));
}

// MCP bundle: the spec and schemas (not templates) under packages/mcp/assets,
// preserving the spec/ and schemas/ subpaths the server reads. This is the only
// vendored copy of the spec; the CLI surface stays single-sourced via the SDK.
const MCP_ASSETS = path.join(repoRoot, 'packages', 'mcp', 'assets');
const mcpSources: { rel: string; file: string; hash: string }[] = [];
for (const kind of ['spec', 'schemas']) {
   for (const file of listFiles(path.join(repoRoot, kind))) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      mcpSources.push({ rel, file, hash: sha256(file) });
   }
}
for (const { rel, file } of mcpSources) {
   syncOne(file, path.join(MCP_ASSETS, rel), rel);
}
// Prune stale spec/schema files (a rename or deletion in the canonical tree),
// since the server reads whatever is on disk under these dirs.
const mcpKeep = new Set(mcpSources.map((s) => s.rel));
pruneExtras(path.join(MCP_ASSETS, 'spec'), mcpKeep, MCP_ASSETS);
pruneExtras(path.join(MCP_ASSETS, 'schemas'), mcpKeep, MCP_ASSETS);
syncManifest(path.join(MCP_ASSETS, 'assets-manifest.json'), {
   specLine: '1.0',
   sourceCommit: gitHead(),
   files: Object.fromEntries(mcpSources.map((s) => [s.rel, 'sha256:' + s.hash])),
});

if (checkOnly && drift) {
   console.error(
      '\nvendored assets drifted from /spec, /schemas, /templates, packages/sdk/cli.json, or the MCP bundle (packages/mcp/assets); run `npm run assets`',
   );
   process.exit(1);
}
if (!drift) console.log('assets in sync');
