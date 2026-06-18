import { type Finding, sortFindings, summarize } from './lib/findings.js';
import { effectiveChangelogPath, effectiveIndexPath, loadManifest } from './lib/manifest.js';
import { type CliOption, SDK_VERSION, SUPPORTED_LINES, loadCliSpec } from './lib/schemas.js';
import { checkIndex, generateIndex, writeIndex } from './commands/indexgen.js';
import { checkChangelogAppendOnly, validateLayer } from './commands/validate.js';
import { compactChangelog } from './commands/changelog.js';
import { conformanceReport, renderExplain } from './commands/conformance.js';
import { generateDocs, resolveDocsPort, serveDocs } from './commands/docs.js';
import { freshnessReport } from './commands/freshness.js';
import { adoptLayer, enteringAdopted, enteringTheLayer, initLayer } from './commands/init.js';
import { detectLayer, renderDetect } from './commands/detect.js';
import { renderWritePlan } from './lib/writeplan.js';

export { validateLayer } from './commands/validate.js';
export { checkIndex, generateIndex, writeIndex } from './commands/indexgen.js';
export { checkChangelogAppendOnly } from './commands/validate.js';
export { compactChangelog, serializeChangelog } from './commands/changelog.js';
export { conformanceReport, renderExplain } from './commands/conformance.js';
export { buildSidebar, generateDocs, resolveDocsPort, serveDocs } from './commands/docs.js';
export { freshnessReport } from './commands/freshness.js';
export { initLayer, adoptLayer } from './commands/init.js';
export { detectLayer, renderDetect } from './commands/detect.js';
export { buildWritePlan, renderWritePlan } from './lib/writeplan.js';
export { detectHosts, resolveHostId, adapterContent, HOST_SPECS } from './lib/detect.js';
export { loadManifest } from './lib/manifest.js';
export { SDK_VERSION, SUPPORTED_LINES } from './lib/schemas.js';
export type { Finding, Severity } from './lib/findings.js';
export type { Manifest, ConformanceLevel, CategoryId } from './lib/manifest.js';
export type { ContextIndex, IndexEntry } from './commands/indexgen.js';
export type { CompactOptions, CompactResult } from './commands/changelog.js';
export type { ConformanceResult, ChecklistItem } from './commands/conformance.js';
export type { FreshnessReport } from './commands/freshness.js';
export type { InitOptions, InitResult, AdoptOptions, AdoptResult } from './commands/init.js';

/** Terminal help, generated from cli.json so it cannot drift from the docs site. */
function buildUsage(): string {
   const spec = loadCliSpec();
   const out: string[] = [
      `leji ${SDK_VERSION}: reference CLI for the Leji specification (spec line ${SUPPORTED_LINES.join(', ')})`,
      '',
      `Usage: ${spec.usage}`,
      '',
      'Commands:',
   ];
   const cmdWidth = Math.max(...spec.commands.map((c) => c.name.length)) + 3;
   for (const c of spec.commands) out.push(`   ${c.name.padEnd(cmdWidth)}${c.summary}`);

   const cmdOptions: (CliOption & { scope: string })[] = spec.commands.flatMap((c) =>
      c.options.map((o) => ({ ...o, scope: c.name })),
   );
   const optWidth =
      Math.max(...spec.globalOptions.map((o) => o.flags.length), ...cmdOptions.map((o) => o.flags.length)) + 3;
   out.push('', 'Options:');
   for (const o of spec.globalOptions) out.push(`   ${o.flags.padEnd(optWidth)}${o.summary}`);
   for (const o of cmdOptions) out.push(`   ${o.flags.padEnd(optWidth)}${o.scope}: ${o.summary}`);

   out.push('', 'Full reference: https://leji.org/cli/');
   return out.join('\n');
}

const USAGE = buildUsage();

interface Flags {
   root: string;
   json: boolean;
   check: boolean;
   strict: boolean;
   yes: boolean;
   serve: boolean;
   content: boolean;
   dryRun: boolean;
   wireAdapters: boolean;
   explain: boolean;
   ci: boolean;
   help: boolean;
   version: boolean;
   port?: number;
   dir: string;
   level?: 'core' | 'indexed';
   name?: string;
   agent?: string;
   reviewer?: string;
   keep?: number;
   before?: string;
}

function parseFlags(argv: string[]): { flags: Flags; rest: string[]; error?: string } {
   const flags: Flags = {
      root: '.',
      json: false,
      check: false,
      strict: false,
      yes: false,
      serve: false,
      content: false,
      dryRun: false,
      wireAdapters: false,
      explain: false,
      ci: false,
      help: false,
      version: false,
      dir: '.',
   };
   const rest: string[] = [];
   for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      switch (arg) {
         case '--root':
            flags.root = argv[++i] ?? '';
            if (!flags.root) return { flags, rest, error: '--root requires a value' };
            break;
         case '--dir':
            flags.dir = argv[++i] ?? '';
            if (!flags.dir) return { flags, rest, error: '--dir requires a value' };
            break;
         case '--level': {
            const v = argv[++i];
            if (v !== 'core' && v !== 'indexed') return { flags, rest, error: '--level must be core or indexed' };
            flags.level = v;
            break;
         }
         case '--name':
            flags.name = argv[++i];
            if (!flags.name) return { flags, rest, error: '--name requires a value' };
            break;
         case '--agent':
            flags.agent = argv[++i];
            if (!flags.agent) return { flags, rest, error: '--agent requires a value' };
            break;
         case '--reviewer':
            flags.reviewer = argv[++i];
            if (!flags.reviewer) return { flags, rest, error: '--reviewer requires a value' };
            break;
         case '--keep': {
            const raw = argv[++i];
            const v = Number(raw);
            if (!raw || !Number.isInteger(v) || v < 1)
               return { flags, rest, error: '--keep must be a positive integer' };
            flags.keep = v;
            break;
         }
         case '--before':
            flags.before = argv[++i];
            if (!flags.before) return { flags, rest, error: '--before requires a value' };
            break;
         case '--serve':
            flags.serve = true;
            break;
         case '--port': {
            const v = Number(argv[++i]);
            if (!Number.isInteger(v) || v < 0 || v > 65535) return { flags, rest, error: '--port must be 0-65535' };
            flags.port = v;
            break;
         }
         case '--json':
            flags.json = true;
            break;
         case '--check':
            flags.check = true;
            break;
         case '--content':
            flags.content = true;
            break;
         case '--dry-run':
            flags.dryRun = true;
            break;
         case '--wire-adapters':
            flags.wireAdapters = true;
            break;
         case '--explain':
            flags.explain = true;
            break;
         case '--ci':
            flags.ci = true;
            break;
         case '--strict':
            flags.strict = true;
            break;
         case '--yes':
         case '-y':
            flags.yes = true;
            break;
         case '-h':
         case '--help':
            flags.help = true;
            break;
         case '-V':
         case '--version':
            flags.version = true;
            break;
         default:
            if (arg.startsWith('-')) {
               return { flags, rest, error: `unknown option ${arg}` };
            }
            rest.push(arg);
      }
   }
   return { flags, rest };
}

// Per-command flag validation, driven by cli.json (the documented surface): each
// command accepts the global options plus its own declared options, and any other
// command flag is a usage error rather than being silently ignored. (Meta-flag
// `-h`/`-V` handling, short-circuited above, is a separate concern.)
const VALUE_FLAGS = new Set([
   '--root',
   '--dir',
   '--level',
   '--name',
   '--port',
   '--agent',
   '--reviewer',
   '--keep',
   '--before',
]);

function flagTokens(flagsStr: string): string[] {
   // "--yes, -y" -> ["--yes","-y"]; "--port <n>" -> ["--port"].
   return flagsStr
      .split(',')
      .map((s) => s.trim().split(/\s+/)[0])
      .filter(Boolean);
}

function seenFlags(argv: string[]): string[] {
   const out: string[] = [];
   for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith('-')) {
         out.push(a);
         if (VALUE_FLAGS.has(a)) i++; // skip the flag's value, not a flag itself
      }
   }
   return out;
}

function allowedFlagsFor(command: string, sub: string | undefined): Set<string> | null {
   const spec = loadCliSpec();
   const name = command === 'changelog' ? `changelog ${sub ?? ''}`.trim() : command;
   const cmd = spec.commands.find((c) => c.name === name);
   if (!cmd) return null; // unknown command: leave it to the dispatcher's default
   const allowed = new Set<string>();
   for (const o of [...spec.globalOptions, ...cmd.options]) {
      for (const t of flagTokens(o.flags)) allowed.add(t);
   }
   return allowed;
}

function printFindings(findings: Finding[]): void {
   for (const f of sortFindings(findings)) {
      const where = f.path ? ` ${f.path}` : '';
      console.log(`${f.severity === 'error' ? 'error  ' : 'warning'} ${f.rule}${where}: ${f.message}`);
   }
}

function emit(command: string, findings: Finding[], json: boolean, extra: Record<string, unknown> = {}): number {
   const sorted = sortFindings(findings);
   const summary = summarize(sorted);
   const ok = summary.errors === 0;
   if (json) {
      console.log(JSON.stringify({ command, ok, findings: sorted, summary, ...extra }, null, 2));
   } else {
      printFindings(sorted);
      const extras = Object.entries(extra)
         .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
         .map(([k, v]) => `${k}: ${v}`)
         .join(', ');
      console.log(
         `${ok ? 'ok' : 'failed'} (${summary.errors} error${summary.errors === 1 ? '' : 's'}, ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}${extras ? `; ${extras}` : ''})`,
      );
   }
   return ok ? 0 : 1;
}

/** Run the CLI; returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
   const { flags, rest, error } = parseFlags(argv);
   if (error) {
      console.error(`leji: ${error}\n`);
      console.error(USAGE);
      return 2;
   }
   // Meta-flags short-circuit before dispatch, wherever they appear in argv, so
   // `leji <command> --help`/`--version` shows usage or the version and never
   // runs the command (a help request must not have side effects).
   if (flags.help) {
      console.log(USAGE);
      return 0;
   }
   if (flags.version) {
      console.log(SDK_VERSION);
      return 0;
   }
   const [command, sub] = rest;
   if (!command || command === 'help') {
      console.log(USAGE);
      return command ? 0 : 2;
   }
   if (command === 'version') {
      console.log(SDK_VERSION);
      return 0;
   }

   // Reject any flag not declared for this command in cli.json (globals are allowed
   // everywhere). Runs after the version/help short-circuit, so meta-commands still
   // ignore flags; unknown commands fall through to the dispatcher's default.
   const allowed = allowedFlagsFor(command, sub);
   if (allowed) {
      const bad = seenFlags(argv).find((t) => !allowed.has(t));
      if (bad) {
         const where = command === 'changelog' && sub ? `${command} ${sub}` : command;
         console.error(`leji: ${bad} is not valid for "${where}"\n`);
         console.error(USAGE);
         return 2;
      }
   }

   try {
      switch (command) {
         case 'validate': {
            const result = validateLayer(flags.root, { content: flags.content });
            return emit('validate', result.findings, flags.json);
         }
         case 'index': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('index', findings, flags.json);
            if (flags.check) {
               const result = checkIndex(flags.root, manifest);
               return emit('index --check', [...findings, ...result.findings], flags.json, {
                  stale: result.stale ?? true,
               });
            }
            const result = writeIndex(flags.root, manifest);
            return emit('index', [...findings, ...result.findings], flags.json, {
               written: effectiveIndexPath(manifest),
               entries: result.index?.entries.length ?? 0,
            });
         }
         case 'changelog': {
            if (sub === 'check') {
               const { manifest, findings } = loadManifest(flags.root);
               if (!manifest) return emit('changelog check', findings, flags.json);
               const rel = effectiveChangelogPath(manifest);
               const result = checkChangelogAppendOnly(flags.root, rel, flags.strict);
               return emit('changelog check', [...findings, ...result.findings], flags.json, {
                  verified: result.verified,
               });
            }
            if (sub === 'compact') {
               if (flags.keep === undefined && flags.before === undefined) {
                  console.error('leji: changelog compact requires --keep or --before\n');
                  console.error(USAGE);
                  return 2;
               }
               const { manifest, findings } = loadManifest(flags.root);
               if (!manifest) return emit('changelog compact', findings, flags.json);
               const result = compactChangelog(flags.root, manifest, { keep: flags.keep, before: flags.before });
               return emit('changelog compact', [...findings, ...result.findings], flags.json, {
                  changelog: result.path,
                  folded: result.folded,
                  kept: result.kept,
                  note: result.folded === 0 && result.findings.length === 0 ? 'nothing to compact' : undefined,
               });
            }
            console.error('leji: usage: leji changelog <check|compact>\n');
            return 2;
         }
         case 'freshness': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('freshness', findings, flags.json);
            const report = freshnessReport(flags.root, manifest, flags.strict);
            if (!flags.json) {
               for (const item of report.upcoming) {
                  console.log(`upcoming ${item.path}: review after ${item.reviewAfter}`);
               }
            }
            return emit('freshness', [...findings, ...report.findings], flags.json, {
               declared: report.declared,
               expired: flags.json ? report.expired : report.expired.length,
               upcoming: flags.json ? report.upcoming : report.upcoming.length,
            });
         }
         case 'conformance': {
            const result = conformanceReport(flags.root);
            if (!flags.json) {
               for (const item of result.items) {
                  const mark = item.status === 'pass' ? 'pass  ' : item.status === 'fail' ? 'FAIL  ' : 'manual';
                  console.log(`${mark} [${item.level}] ${item.description}${item.detail ? ` — ${item.detail}` : ''}`);
               }
               console.log('');
               if (flags.explain) console.log(renderExplain(result) + '\n');
            }
            return emit('conformance', result.findings, flags.json, {
               claimedLevel: result.claimedLevel ?? 'none',
               verifiedLevel: result.verifiedLevel ?? 'none',
               ...(flags.json ? { items: result.items } : {}),
            });
         }
         case 'docs': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('docs', findings, flags.json);
            const result = generateDocs(flags.root, manifest);
            const code = emit('docs', [...findings, ...result.findings], flags.json, {
               written: result.written.join(', '),
               entries: result.entries,
            });
            if (!flags.serve || code !== 0) {
               if (!flags.json && code === 0) {
                  console.log(`serve locally: leji docs --serve   (or any static server at the repository root)`);
               }
               return code;
            }
            const server = await serveDocs(flags.root, resolveDocsPort(manifest, flags.port));
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : resolveDocsPort(manifest, flags.port);
            console.log(`serving http://127.0.0.1:${port}/${manifest.rootPath}; Ctrl+C to stop`);
            // Keep the process alive until the server closes (Ctrl+C).
            await new Promise<void>((resolve) => server.on('close', resolve));
            return 0;
         }
         case 'detect': {
            const result = detectLayer(flags.root);
            if (flags.json) {
               console.log(JSON.stringify({ command: 'detect', ok: true, hosts: result.hosts }, null, 2));
            } else {
               console.log(renderDetect(result.hosts));
            }
            return 0;
         }
         case 'adopt': {
            const result = await adoptLayer({
               dir: flags.dir === '.' && flags.root !== '.' ? flags.root : flags.dir,
               yes: flags.yes,
               name: flags.name,
               dryRun: flags.dryRun,
               wireAdapters: flags.wireAdapters,
               agent: flags.agent,
            });
            if (result.dryRun) {
               console.log(`\nAdopting the existing repository (context root: ${result.detectedRoot}).`);
               console.log('\n' + renderWritePlan(result.plan));
               console.log('\nNo files written (--dry-run). Re-run without --dry-run to apply.');
               return 0;
            }
            console.log(`\nWrote ${result.written.length} files (context root: ${result.detectedRoot}):`);
            for (const rel of result.written) console.log(`   ${rel}`);
            console.log(enteringAdopted(result));
            return 0;
         }
         case 'init': {
            const result = await initLayer({
               dir: flags.dir === '.' && flags.root !== '.' ? flags.root : flags.dir,
               yes: flags.yes,
               name: flags.name,
               level: flags.level,
               dryRun: flags.dryRun,
               agent: flags.agent,
               reviewer: flags.reviewer,
               ci: flags.ci,
            });
            if (result.dryRun) {
               console.log('\n' + renderWritePlan(result.plan));
               console.log('\nNo files written (--dry-run). Re-run without --dry-run to create them.');
               return 0;
            }
            console.log(`\nWrote ${result.written.length} files:`);
            for (const rel of result.written) console.log(`   ${rel}`);
            console.log(enteringTheLayer(result.manifest));
            return 0;
         }
         default:
            console.error(`leji: unknown command "${command}"\n`);
            console.error(USAGE);
            return 2;
      }
   } catch (e) {
      console.error(`leji: ${(e as Error).message}`);
      return 2;
   }
}
