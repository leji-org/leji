#!/usr/bin/env node
// Vendors the canonical /schemas and /templates into all three SDK packages
// (Node, Python, Go) with provenance metadata, and keeps the Go SDK's embedded
// cli.json in sync with the canonical packages/sdk/cli.json. Run after any
// schema, template, or CLI-surface change; CI runs `npm run assets:check` to
// catch drift across every SDK.
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

for (const target of TARGETS) {
   for (const { rel, file } of sources) {
      syncOne(file, path.join(target, rel), rel);
   }
   const manifestDest = path.join(target, 'assets-manifest.json');
   const manifestText = JSON.stringify(manifest, null, 2) + '\n';
   const current = fs.existsSync(manifestDest) ? fs.readFileSync(manifestDest, 'utf8') : '';
   // Compare file hashes only; the commit pointer moves with every commit.
   const stripCommit = (text: string): string => text.replace(/"sourceCommit": "[^"]*"/, '"sourceCommit": ""');
   if (stripCommit(current) !== stripCommit(manifestText)) {
      drift = true;
      if (checkOnly) {
         console.error(`drift: ${path.relative(repoRoot, manifestDest)} is out of date`);
      } else {
         fs.writeFileSync(manifestDest, manifestText);
         console.log(`synced ${path.relative(repoRoot, manifestDest)}`);
      }
   }
}

for (const { src, dest } of FILE_MIRRORS) {
   syncOne(src, dest, path.relative(repoRoot, src).split(path.sep).join('/'));
}

if (checkOnly && drift) {
   console.error('\nvendored assets drifted from /schemas, /templates, or packages/sdk/cli.json; run `npm run assets`');
   process.exit(1);
}
if (!drift) console.log('assets in sync');
