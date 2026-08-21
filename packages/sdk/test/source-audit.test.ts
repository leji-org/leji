import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The acceptance check for the write boundary: no production source file of this SDK
// reaches a raw filesystem mutation, or a subprocess that could perform one, except at
// a symbol named below. Every other write goes through `lib/fsx.ts` — the chokepoint
// and its guarded conveniences — so a new write site is contained by construction
// rather than by remembering to contain it, and a reviewer can read the exceptions
// instead of re-deriving them. `docs/practice/trust-boundary.md` mirrors both lists.
//
// The scan is TYPE-RESOLVED: the whole package is loaded as a program and every call is
// asked what it actually calls, so a mutator is recognized by the declaration it lands
// on rather than by how the call was spelled. `fs.rm(...)`, `fs['rm'](...)`,
// `fs.promises.rm(...)`, `import { rm as nuke }`, `const { rm } = fs`, a mutator
// destructured out of `await import('node:fs/promises')`, or one re-exported by a local
// module all resolve to the same `@types/node` declaration and are all caught. On top of
// that: the unmistakable synchronous names are still matched as identifiers (a
// belt-and-braces layer that needs no type at all), and `require()` or a dynamic
// `import()` of an fs or child_process module is banned outright — the SDK is ESM, so
// either is a laundering attempt rather than a style.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const srcDir = path.join(packageDir, 'src');

const FS_MODULES: ReadonlySet<string> = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const CHILD_PROCESS_MODULES: ReadonlySet<string> = new Set(['child_process', 'node:child_process']);

/**
 * The synchronous mutation surface. These names belong to no other API a repository
 * like this uses, so they are matched on the IDENTIFIER anywhere: an indirect alias
 * (`const w = fs.rmSync`) is caught along with the direct call.
 */
const SYNC_MUTATORS: ReadonlySet<string> = new Set([
   'appendFileSync',
   'chmodSync',
   'chownSync',
   'copyFileSync',
   'cpSync',
   'createWriteStream',
   'fchmodSync',
   'fchownSync',
   'ftruncateSync',
   'futimesSync',
   'lchmodSync',
   'lchownSync',
   'linkSync',
   'lutimesSync',
   'mkdirSync',
   'mkdtempSync',
   'openSync',
   'renameSync',
   'rmdirSync',
   'rmSync',
   'symlinkSync',
   'truncateSync',
   'unlinkSync',
   'utimesSync',
   'writeFileSync',
   'writeSync',
   'writevSync',
]);

/**
 * The callback and promise forms. Their names are ordinary English words that any
 * object may carry (`process.stderr.write`, `res.write`, a RegExp's `exec`), so they
 * count only when the call RESOLVES to a declaration in Node's `fs` typings — which no
 * amount of rebinding can hide, and which `process.stderr.write` never does.
 */
const FS_MUTATORS: ReadonlySet<string> = new Set([
   'appendFile',
   'chmod',
   'chown',
   'copyFile',
   'cp',
   'fchmod',
   'fchown',
   'ftruncate',
   'futimes',
   'lchmod',
   'lchown',
   'link',
   'lutimes',
   'mkdir',
   'mkdtemp',
   'open',
   'rename',
   'rm',
   'rmdir',
   'symlink',
   'truncate',
   'unlink',
   'utimes',
   'write',
   'writeFile',
   'writev',
]);

/** Every mutator name as `@types/node` declares it, both forms. */
const MUTATORS: ReadonlySet<string> = new Set([...SYNC_MUTATORS, ...FS_MUTATORS]);

/** Anything that hands work to another program, which can then write whatever it
 * likes. Recognized the same type-resolved way, against `child_process`. */
const SUBPROCESS: ReadonlySet<string> = new Set([
   'exec',
   'execFile',
   'execFileSync',
   'execSync',
   'fork',
   'spawn',
   'spawnSync',
]);

/**
 * The write allow-list, by `file#symbol` — never by whole module, so a future raw
 * mutation elsewhere in an allowed file still fails. An entry that matches nothing
 * fails too: a stale exception is an exception nobody is checking.
 */
const ALLOWED_WRITES: Readonly<Record<string, string>> = {
   'lib/fsx.ts#writeFileGuarded': 'the chokepoint itself: the guarded write, judged before it acts',
   'lib/fsx.ts#mkdirpGuarded': 'the chokepoint itself: the guarded directory establishment',
   'lib/fsx.ts#rmGuarded': 'the chokepoint itself: the guarded clear',
   'lib/fsx.ts#renameGuarded': 'the chokepoint itself: the guarded rename, both ends judged',
   'lib/fsx.ts#chmodGuarded': 'the chokepoint itself: the guarded mode change',
   'lib/fsx.ts#openWriteGuarded': 'the chokepoint itself: the guarded destination descriptor',
   'lib/fsx.ts#writeFileAtomicGuarded': 'the chokepoint itself: temp sibling plus rename, both ends judged',
   'lib/fsx.ts#openVerifiedSource': 'the verified READ: opens a judged source read-only',
   'commands/export.ts#copyFromDescriptor': 'writes into the descriptor openWriteGuarded returned, never to a path',
   'lib/mounts.ts#extractProjection': 'mounts per-entry protocol, under a store root the chokepoint established',
   'lib/mounts.ts#publishCacheEntry': 'mounts per-entry protocol: sidecar, marker, publish-by-rename, staging clear',
   'lib/mounts.ts#hydrateMounts': 'mounts per-entry protocol: clears its own established staging directory',
   'lib/mounts.ts#verifyProjection': 'verification staging under the OS temp directory, outside the repository',
   'commands/init.ts#initLayer': 'root bootstrap: creates the selected root before any repository root exists',
   'commands/init.ts#adoptLayer': 'root bootstrap: creates the selected root before any repository root exists',
};

/**
 * The subprocess allow-list. A child process is outside every guard this SDK can
 * enforce, so each caller is named with what it runs and what it may write.
 */
const ALLOWED_SUBPROCESSES: Readonly<Record<string, string>> = {
   'lib/git.ts#git': 'read-only git queries (log, ls-files, status) in the host repository',
   'lib/mounts.ts#runGit':
      'the federation resolver: git init/fetch write ONLY into a store or cache root the chokepoint established, plus read-only queries',
   'commands/init.ts#gitConfig': 'read-only `git config --get`',
   'commands/init.ts#hooksPathConfig': 'read-only `git -C root config core.hooksPath`',
   'commands/init.ts#gitHooksDir': 'read-only `git rev-parse --git-path hooks`',
   'commands/init.ts#gitDirs': 'read-only `git rev-parse --git-dir --git-common-dir`',
   'commands/init.ts#launch':
      'the handoff IO: launches the agent host the user chose; its writes are that program, not this SDK',
   'commands/init.ts#run':
      'the handoff IO: runs the host command the user chose (same reasoning as `launch`), or, under `capture`, the preflight version probe: argv only, cwd-pinned to the repository root, stdin closed, stderr discarded, output and wall time capped while the child runs (passing either bound terminates it), and an environment that REPLACES this process\u2019s rather than extending it; it never invokes a package manager\u2019s script runner',
   'commands/serve.ts#openBrowser': 'opens the preview URL in the desktop browser; writes nothing',
   'lib/localcli.ts#spawnInherit':
      "the hand-off: the installed executable runs the repository's OWN pinned Leji CLI, chosen only when the repository directly declares it and the copy is installed inside the repository with its package identity verified and meeting the layer's minimum; argv, never a shell, and the child inherits this terminal and environment because it IS this invocation, so its writes are that copy's rather than this one's",
};

/** The package's own compiler options, so the program the audit type-checks is the
 * program `tsc` builds. */
function compilerOptions(): ts.CompilerOptions {
   const configPath = path.join(packageDir, 'tsconfig.json');
   const read = ts.readConfigFile(configPath, ts.sys.readFile);
   assert.equal(read.error, undefined, `cannot read ${configPath}`);
   const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, packageDir);
   // Nothing is emitted: the audit only asks the checker what each call resolves to.
   return { ...parsed.options, noEmit: true, incremental: false, composite: false };
}

const OPTIONS = compilerOptions();

/** Where `@types/node` declares the fs and child_process modules, taken from the
 * program's own ambient module declarations rather than guessed from a path — so the
 * audit fails loudly if the typings ever move instead of silently seeing nothing. */
function moduleDeclarationFiles(checker: ts.TypeChecker, names: ReadonlySet<string>): ReadonlySet<string> {
   const files = new Set<string>();
   for (const module of checker.getAmbientModules()) {
      if (!names.has(module.getName().replace(/^"|"$/g, ''))) continue;
      for (const declaration of module.declarations ?? []) {
         files.add(path.resolve(declaration.getSourceFile().fileName));
      }
   }
   return files;
}

/** The declaration files one audit pass judges against. */
interface Typings {
   fs: ReadonlySet<string>;
   childProcess: ReadonlySet<string>;
}

/** The nearest named FUNCTION containing `node`: the declaration, method, or named
 * arrow a reader would cite when arguing the exception. An anonymous callback is
 * transparent — a raw primitive inside one belongs to the function that owns it, not
 * to the variable the enclosing call happens to be assigned to. */
function enclosingSymbol(node: ts.Node): string {
   for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
      if (!ts.isFunctionLike(n)) continue;
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
         return n.name.text;
      }
      const parent = n.parent;
      if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
         return parent.name.text;
      }
      if (parent !== undefined && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
         return parent.name.text;
      }
   }
   return '(top level)';
}

interface Hit {
   key: string;
   line: number;
   name: string;
}

/** One resolved callee: the name it was DECLARED under and the file declaring it. */
interface Callee {
   name: string;
   file: string;
}

/** Everything the checker can say about what this call calls: the signature it
 * resolved to, and the symbol behind the callee with every alias followed (a named
 * import, an `import x as y`, a local re-export chain). */
function resolveCallee(node: ts.CallExpression | ts.NewExpression, checker: ts.TypeChecker): Callee[] {
   const out: Callee[] = [];
   const signature = checker.getResolvedSignature(node);
   const declaration = signature?.declaration;
   if (declaration !== undefined) {
      const named = (declaration as { name?: ts.Node }).name;
      if (named !== undefined && ts.isIdentifier(named as ts.Node)) {
         out.push({ name: (named as ts.Identifier).text, file: path.resolve(declaration.getSourceFile().fileName) });
      }
   }
   let symbol = checker.getSymbolAtLocation(node.expression);
   if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
   }
   for (const decl of symbol?.declarations ?? []) {
      out.push({ name: symbol!.getName(), file: path.resolve(decl.getSourceFile().fileName) });
   }
   return out;
}

/** `fs.open`/`openSync` count as mutations unless the flag is literally read-only:
 * every other flag creates or truncates, and an absent one cannot be proven read-only. */
function readOnlyOpen(node: ts.CallExpression | ts.NewExpression): boolean {
   return (node.arguments ?? []).some((arg) => ts.isStringLiteral(arg) && arg.text === 'r');
}

/** The module specifier of a `require('…')` or a dynamic `import('…')`, else null. */
function bannedRequireOrImport(node: ts.CallExpression): string | null {
   const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
   const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
   if (!isRequire && !isDynamicImport) return null;
   const arg = node.arguments[0];
   if (arg === undefined || !ts.isStringLiteral(arg)) return null;
   return arg.text;
}

/** Every filesystem mutation and every subprocess call in one file. */
function scan(
   rel: string,
   source: ts.SourceFile,
   checker: ts.TypeChecker,
   typings: Typings,
): { writes: Hit[]; subprocesses: Hit[] } {
   const writes: Hit[] = [];
   const subprocesses: Hit[] = [];
   const seen = new Set<string>();
   const record = (into: Hit[], node: ts.Node, name: string): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const key = `${rel}#${enclosingSymbol(node)}`;
      const dedupe = `${key}:${line}:${name}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      into.push({ key, line, name });
   };
   const visit = (node: ts.Node): void => {
      // The import statement is where a binding is declared, not where it is used.
      if (ts.isImportDeclaration(node)) return;
      // Belt and braces, needing no type at all: the unmistakable synchronous names,
      // matched wherever they appear, in either syntax.
      const literal = ts.isIdentifier(node)
         ? node.text
         : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
           ? node.text
           : null;
      if (literal !== null && SYNC_MUTATORS.has(literal)) record(writes, node, literal);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
         // What does this call actually call? However the binding was obtained —
         // namespace, named, aliased, destructured, re-exported, `fs.promises.*`,
         // element access — the declaration it lands on is the same one.
         for (const callee of resolveCallee(node, checker)) {
            if (typings.fs.has(callee.file) && MUTATORS.has(callee.name)) {
               if ((callee.name === 'open' || callee.name === 'openSync') && readOnlyOpen(node)) continue;
               record(writes, node, callee.name);
            }
            if (typings.childProcess.has(callee.file) && SUBPROCESS.has(callee.name)) {
               record(subprocesses, node, callee.name);
            }
         }
      }
      // An ESM package has no business calling `require`, and a dynamic `import()` of
      // these modules is a binding the checker would have to chase at runtime: both are
      // refused outright rather than analyzed.
      if (ts.isCallExpression(node)) {
         const specifier = bannedRequireOrImport(node);
         if (specifier !== null && FS_MODULES.has(specifier)) record(writes, node, `import of ${specifier}`);
         if (specifier !== null && CHILD_PROCESS_MODULES.has(specifier)) {
            record(subprocesses, node, `import of ${specifier}`);
         }
      }
      ts.forEachChild(node, visit);
   };
   visit(source);
   return { writes, subprocesses };
}

/** The audited files of a program: production source only (no `.d.ts`, no tests). */
function auditProgram(program: ts.Program, root: string): { writes: Hit[]; subprocesses: Hit[] } {
   const checker = program.getTypeChecker();
   const typings: Typings = {
      fs: moduleDeclarationFiles(checker, FS_MODULES),
      childProcess: moduleDeclarationFiles(checker, CHILD_PROCESS_MODULES),
   };
   assert.ok(typings.fs.size > 0, 'the fs typings are not in the program: the audit would recognize no fs call');
   assert.ok(typings.childProcess.size > 0, 'the child_process typings are not in the program');
   const writes: Hit[] = [];
   const subprocesses: Hit[] = [];
   const files = program
      .getSourceFiles()
      .filter((f) => !f.isDeclarationFile && path.resolve(f.fileName).startsWith(root + path.sep))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
   assert.ok(files.length > 0, 'the audit loaded no source files');
   for (const source of files) {
      const rel = path.relative(root, path.resolve(source.fileName)).split(path.sep).join('/');
      const found = scan(rel, source, checker, typings);
      writes.push(...found.writes);
      subprocesses.push(...found.subprocesses);
   }
   return { writes, subprocesses };
}

let cached: { writes: Hit[]; subprocesses: Hit[] } | null = null;

function audit(): { writes: Hit[]; subprocesses: Hit[] } {
   if (cached === null) {
      const program = ts.createProgram({ rootNames: sourceFiles(srcDir), options: OPTIONS });
      cached = auditProgram(program, srcDir);
   }
   return cached;
}

/** Every production source file of this SDK (there are no tests under `src/`). */
function sourceFiles(dir: string, out: string[] = []): string[] {
   for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(abs, out);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
   }
   return out;
}

function unexpected(hits: Hit[], allowed: Readonly<Record<string, string>>): string[] {
   return hits.filter((h) => !(h.key in allowed)).map((h) => `${h.key} (${h.name}) at line ${h.line}`);
}

function stale(hits: Hit[], allowed: Readonly<Record<string, string>>): string[] {
   const matched = new Set(hits.map((h) => h.key));
   return Object.keys(allowed).filter((key) => !matched.has(key));
}

test('no production source reaches a raw filesystem mutation outside the allow-list', () => {
   const { writes } = audit();
   const outside = unexpected(writes, ALLOWED_WRITES);
   assert.deepEqual(
      outside,
      [],
      `raw filesystem mutations outside the chokepoint: ${outside.join(', ')}\n` +
         'Route the write through lib/fsx.ts (writeFileGuarded, mkdirpGuarded, rmGuarded, renameGuarded, ' +
         'chmodGuarded, openWriteGuarded, writeFileAtomicGuarded), or argue the exception into the allow-list.',
   );
   const dead = stale(writes, ALLOWED_WRITES);
   assert.deepEqual(dead, [], `write allow-list entries matching no symbol (delete them): ${dead.join(', ')}`);
});

test('every subprocess call is a named, reasoned exception', () => {
   const { subprocesses } = audit();
   const outside = unexpected(subprocesses, ALLOWED_SUBPROCESSES);
   assert.deepEqual(
      outside,
      [],
      `subprocess calls outside the allow-list: ${outside.join(', ')}\n` +
         'A child process writes wherever it likes; name the caller and say what it runs and what it may write.',
   );
   const dead = stale(subprocesses, ALLOWED_SUBPROCESSES);
   assert.deepEqual(dead, [], `subprocess allow-list entries matching no symbol (delete them): ${dead.join(', ')}`);
});

/**
 * The laundering corpus, permanent. Each file below is a way of reaching an fs mutator
 * that a binding-following scanner misses; they are compiled as production source
 * would be — same options, same `@types/node` — and fed to the same analyzer, so the
 * audit's reach is asserted rather than assumed. The last file is the control: two
 * ordinary `write`/`exec` calls that share their names with the mutator list and must
 * never be flagged.
 */
const PROBES: ReadonlyArray<{ rel: string; source: string; flagged: boolean }> = [
   {
      rel: '__probe_destructured.ts',
      flagged: true,
      source: [
         "import * as nodeFs from 'node:fs';",
         'const { rm } = nodeFs;',
         'export function launderDestructured(p: string): void {',
         '   rm(p, () => {});',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_dynamic_import.ts',
      flagged: true,
      source: [
         'export async function launderDynamicImport(p: string): Promise<void> {',
         "   const { writeFile } = await import('node:fs/promises');",
         "   await writeFile(p, 'x');",
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_require.ts',
      flagged: true,
      source: [
         'export function launderRequire(p: string): void {',
         "   const required = require('node:fs') as { rm: (p: string, cb: () => void) => void };",
         '   required.rm(p, () => {});',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_reexport_source.ts',
      flagged: false,
      source: "export { rm } from 'node:fs/promises';",
   },
   {
      rel: '__probe_reexport.ts',
      flagged: true,
      source: [
         "import { rm } from './__probe_reexport_source.js';",
         'export async function launderReexport(p: string): Promise<void> {',
         '   await rm(p, { recursive: true });',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_negative.ts',
      flagged: false,
      source: [
         'export function notAMutation(line: string): boolean {',
         '   process.stderr.write(`${line}\\n`);',
         '   return /leji/.exec(line) !== null;',
         '}',
      ].join('\n'),
   },
];

/** The probe corpus as a program: the real compiler host with the synthetic files
 * overlaid, so `node:fs` and a local re-export resolve exactly as they do in `src/`. */
function probeProgram(): { program: ts.Program; root: string } {
   const root = path.join(srcDir, '__audit_probes');
   const files = new Map<string, string>(PROBES.map((p) => [path.join(root, p.rel), p.source]));
   const host = ts.createCompilerHost(OPTIONS, true);
   const readFile = host.readFile.bind(host);
   const getSourceFile = host.getSourceFile.bind(host);
   const fileExists = host.fileExists.bind(host);
   const directoryExists = host.directoryExists?.bind(host);
   host.readFile = (fileName) => files.get(path.resolve(fileName)) ?? readFile(fileName);
   host.fileExists = (fileName) => files.has(path.resolve(fileName)) || fileExists(fileName);
   host.directoryExists = (dir) =>
      path.resolve(dir) === root || (directoryExists === undefined ? true : directoryExists(dir));
   host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
      const overlaid = files.get(path.resolve(fileName));
      return overlaid === undefined
         ? getSourceFile(fileName, languageVersion, onError, shouldCreate)
         : ts.createSourceFile(fileName, overlaid, languageVersion, true);
   };
   return { program: ts.createProgram({ rootNames: [...files.keys()], options: OPTIONS, host }), root };
}

test('the analyzer sees through every known laundering of an fs binding', () => {
   const { program, root } = probeProgram();
   const { writes, subprocesses } = auditProgram(program, root);
   const flagged = new Set(writes.map((h) => h.key.split('#')[0]));
   for (const probe of PROBES.filter((p) => p.flagged)) {
      assert.ok(
         flagged.has(probe.rel),
         `${probe.rel} laundered an fs mutator past the audit (flagged: ${[...flagged].join(', ') || 'nothing'})`,
      );
   }
   assert.equal(flagged.has('__probe_negative.ts'), false, 'process.stderr.write / RegExp exec must not be flagged');
   assert.deepEqual(
      subprocesses.filter((h) => h.key.startsWith('__probe_negative.ts')),
      [],
      'the negative control must raise no subprocess hit either',
   );
});
