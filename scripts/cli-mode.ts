// Manage which build of the `leji` CLI the machine runs: LIVE (npm-linked to
// this checkout; rebuilds flow through) or PACKED (globally installed from a
// packed tarball; publish-identical, frozen). The practice doc is
// docs/practice/testing-cli-adoptions.md; these commands mechanize it.
//
//   node scripts/cli-mode.ts live      switch to LIVE (assets:check, build, link)
//   node scripts/cli-mode.ts refresh   rebuild + pack + install a fresh PACKED artifact
//   node scripts/cli-mode.ts packed    reinstall the last packed artifact
//   node scripts/cli-mode.ts mode      report LIVE | PACKED | UNKNOWN with evidence
//   node scripts/cli-mode.ts assert <live|packed> [sha256]   exit 1 on mismatch
import { execSync, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkDir = path.join(repoRoot, 'packages', 'sdk');
const sidecarPath = path.join(repoRoot, 'var', 'cli-packed.json');

function sh(cmd: string, cwd = repoRoot): void {
   execSync(cmd, { cwd, stdio: 'inherit' });
}
// A global npm install must run from OUTSIDE this repo and without npm_config_*
// env: executed inside a workspaces project (or under npm run), `npm i -g`
// silently installs into the workspace instead and the global bin never appears.
function npmGlobalInstall(tarball: string): void {
   const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_')));
   const opts = { stdio: 'inherit' as const, env, cwd: os.tmpdir() };
   // Remove first: reinstalling over prior link/unlink state can leave the bin unlinked.
   try {
      execFileSync('npm', ['rm', '-g', '@leji-org/leji'], opts);
   } catch {
      /* not installed */
   }
   execFileSync('npm', ['i', '-g', tarball], opts);
}
function out(cmd: string, cwd = repoRoot): string {
   return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

interface Resolved {
   which: string | null;
   real: string | null;
   mode: 'LIVE' | 'PACKED' | 'UNKNOWN';
}

function resolve(): Resolved {
   // The mode that matters is the GLOBAL install — what every other repository
   // resolves. From inside this repo, npm puts the workspace's own .bin on
   // PATH, so `command -v` would self-report LIVE regardless; go straight to
   // the global prefix instead.
   let which: string | null = null;
   try {
      which = path.join(out('npm prefix -g'), 'bin', 'leji');
      fs.accessSync(which);
   } catch {
      return { which: null, real: null, mode: 'UNKNOWN' };
   }
   let real: string | null = null;
   try {
      real = fs.realpathSync(which);
   } catch {
      return { which, real: null, mode: 'UNKNOWN' };
   }
   // Filesystem first: inside this checkout means linked source; a global
   // node_modules outside it means an installed artifact.
   if (real.startsWith(repoRoot + path.sep)) return { which, real, mode: 'LIVE' };
   if (real.includes(`${path.sep}node_modules${path.sep}`)) return { which, real, mode: 'PACKED' };
   return { which, real, mode: 'UNKNOWN' };
}

function sidecar(): Record<string, string> | null {
   try {
      return JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Record<string, string>;
   } catch {
      return null;
   }
}

function printMode(): Resolved {
   const r = resolve();
   const lines = [`mode: ${r.mode}`];
   try {
      lines.push(`version: ${out('leji --version')}`);
   } catch {
      lines.push('version: (leji not runnable)');
   }
   lines.push(`bin: ${r.which ?? '(none on PATH)'}`);
   lines.push(`resolves: ${r.real ?? '-'}`);
   lines.push(`node: ${process.version} · npm prefix: ${out('npm prefix -g')}`);
   const sc = sidecar();
   if (r.mode === 'PACKED') {
      if (sc) {
         lines.push(`artifact: sha256:${sc.sha256}`);
         lines.push(`packed: ${sc.createdAt} from ${sc.gitRev}${sc.dirty === 'true' ? ' (dirty tree)' : ''}`);
      } else {
         lines.push('artifact: no sidecar record (installed outside cli-mode? fingerprint unknown)');
      }
   }
   console.log(lines.join('\n'));
   return r;
}

function verify(expected: 'LIVE' | 'PACKED'): void {
   const r = resolve();
   if (r.mode !== expected) {
      console.error(
         `\ncli-mode: postcondition failed — wanted ${expected}, machine is ${r.mode} (${r.real ?? 'no bin'})`,
      );
      process.exit(1);
   }
}

function live(): void {
   sh('npm run assets:check');
   sh('npm run build -w @leji-org/leji');
   sh('npm link', sdkDir);
   verify('LIVE');
   printMode();
}

function refresh(): void {
   sh('npm run assets:check');
   // tsc never removes output for deleted sources; a stale dist would enter the
   // tarball. The incremental buildinfo lives OUTSIDE dist, so it must go too —
   // otherwise tsc believes everything is built and emits nothing, and the pack
   // ships a dist-less package whose bin npm silently refuses to link.
   fs.rmSync(path.join(sdkDir, 'dist'), { recursive: true, force: true });
   fs.rmSync(path.join(repoRoot, '.cache', 'tsc', 'sdk.tsbuildinfo'), { force: true });
   sh('npm run build -w @leji-org/leji');
   fs.mkdirSync(path.join(repoRoot, 'var'), { recursive: true });
   const name = out('npm pack --pack-destination ../../var', sdkDir).split('\n').pop()!;
   const tarball = path.join(repoRoot, 'var', name);
   const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
   let gitRev = 'unknown';
   let dirty = 'unknown';
   try {
      gitRev = out('git rev-parse --short HEAD');
      dirty = out('git status --porcelain') === '' ? 'false' : 'true';
   } catch {
      /* not fatal */
   }
   npmGlobalInstall(tarball);
   verify('PACKED');
   fs.writeFileSync(
      sidecarPath,
      JSON.stringify({ tarball, sha256, createdAt: new Date().toISOString(), gitRev, dirty }, null, 2) + '\n',
   );
   printMode();
}

function packed(): void {
   const sc = sidecar();
   if (!sc || !fs.existsSync(sc.tarball)) {
      console.error('cli-mode: no packed artifact on record; run `npm run cli:packed:refresh` first');
      process.exit(1);
   }
   npmGlobalInstall(sc.tarball);
   verify('PACKED');
   printMode();
}

function assertMode(want: string | undefined, wantSha: string | undefined): void {
   const expected = want?.toUpperCase();
   if (expected !== 'LIVE' && expected !== 'PACKED') {
      console.error('usage: cli-mode assert <live|packed> [sha256]');
      process.exit(2);
   }
   const r = printMode();
   if (r.mode !== expected) {
      console.error(`\ncli-mode: ASSERT FAILED — wanted ${expected}, got ${r.mode}`);
      process.exit(1);
   }
   if (expected === 'PACKED' && wantSha) {
      const sc = sidecar();
      if (!sc || sc.sha256 !== wantSha) {
         console.error(
            `\ncli-mode: ASSERT FAILED — artifact fingerprint mismatch (wanted ${wantSha}, have ${sc?.sha256 ?? 'none'})`,
         );
         process.exit(1);
      }
   }
}

const [cmd, a1, a2] = process.argv.slice(2);
switch (cmd) {
   case 'live':
      live();
      break;
   case 'refresh':
      refresh();
      break;
   case 'packed':
      packed();
      break;
   case 'mode':
      printMode();
      break;
   case 'assert':
      assertMode(a1, a2);
      break;
   default:
      console.error('usage: cli-mode <live|refresh|packed|mode|assert>');
      process.exit(2);
}
