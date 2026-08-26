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

let cachedProgram: ts.Program | null = null;

/** The whole package as one type-checked program, built once and shared by every
 * audit here: the checker is what makes a hit about the declaration a call or a
 * property lands on rather than about how it was spelled. */
function program(): ts.Program {
   if (cachedProgram === null) {
      cachedProgram = ts.createProgram({ rootNames: sourceFiles(srcDir), options: OPTIONS });
   }
   return cachedProgram;
}

let cached: { writes: Hit[]; subprocesses: Hit[] } | null = null;

function audit(): { writes: Hit[]; subprocesses: Hit[] } {
   if (cached === null) cached = auditProgram(program(), srcDir);
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
 * The declared exceptions to the ROLE rule, by `file#symbol`: the one place a
 * `metadataFile` verdict may be constructed. `docs/practice/trust-boundary.md`
 * mirrors this list. The write allow-list above says which symbols may touch the
 * filesystem raw; this one says which may declare a target writable that the role
 * rule refuses, and it exists for the same reason: an exception nobody can find is
 * an exception nobody is checking.
 */
const ALLOWED_ROLE_EXCEPTIONS: Readonly<Record<string, string>> = {
   'lib/fsx.ts#metadataFileVerdict':
      'the self-managed .leji/.gitignore: judged on the requested entry, with a real .leji directory and a non-symlink entry, refused otherwise',
};

/** The property that carries the exception. */
const ROLE_EXCEPTION_PROPERTY = 'metadataFile';

/**
 * The literal text of a property NAME, in whichever of its spellings it was
 * written: `x:`, `'x':`, `"x":`, `` [`x`]: `` and `['x']:` are one name. Null when
 * the name is computed from something that is not a literal: a case no purely
 * syntactic audit can resolve, which the checker layer below is what covers.
 */
function propertyNameText(name: ts.PropertyName): string | null {
   if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
   if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
   return null;
}

/**
 * The constant string an expression IS, when the checker can prove one: a literal
 * written in place, or anything whose TYPE is a single string literal: a
 * `const key = 'metadataFile'` used as a subscript, an imported constant, a value
 * narrowed to one literal. That is what a name match alone cannot see, and it is
 * why this audit resolves types instead of only reading spellings.
 */
function constantStringOf(node: ts.Expression, checker: ts.TypeChecker): string | null {
   if (ts.isStringLiteralLike(node)) return node.text;
   const type = checker.getTypeAtLocation(node);
   return type.isStringLiteral() ? type.value : null;
}

/**
 * The member a call is spelled or RESOLVED as, with the holder it was reached
 * through when one was written. Three spellings plus the checker's answer, so an
 * `Object['defineProperty'](…)`, a destructured `const { defineProperty } = Object`
 * and an `import { set } from` alias all report the same member as the plain call.
 */
function calleeMembers(node: ts.CallExpression, checker: ts.TypeChecker): { member: string; holder: string | null }[] {
   const out: { member: string; holder: string | null }[] = [];
   const callee = node.expression;
   const holderOf = (expression: ts.Expression): string | null =>
      ts.isIdentifier(expression) ? expression.text : null;
   if (ts.isPropertyAccessExpression(callee)) {
      out.push({ member: callee.name.text, holder: holderOf(callee.expression) });
   } else if (ts.isElementAccessExpression(callee)) {
      const member = constantStringOf(callee.argumentExpression, checker);
      if (member !== null) out.push({ member, holder: holderOf(callee.expression) });
   } else if (ts.isIdentifier(callee)) {
      out.push({ member: callee.text, holder: null });
   }
   // Whatever the binding was (a namespace access, a destructured constant, an
   // aliased import), the SIGNATURE the call resolves to is still the library's own
   // declaration, and that declaration still sits inside the interface or namespace
   // that names the holder. That is what recognizes `const { set } = Reflect` as
   // `Reflect.set` while a map's `set` resolves to `Map` and is left alone.
   const declaration = checker.getResolvedSignature(node)?.declaration;
   const named = declaration === undefined ? undefined : (declaration as { name?: ts.Node }).name;
   if (named !== undefined && ts.isIdentifier(named as ts.Node)) {
      out.push({ member: (named as ts.Identifier).text, holder: declaredHolder(declaration!) });
   }
   let symbol = checker.getSymbolAtLocation(callee);
   if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
   for (const declared of symbol?.declarations ?? []) {
      out.push({ member: symbol!.getName(), holder: declaredHolder(declared) });
   }
   return out;
}

/** The interface or namespace a DECLARATION sits in (`ObjectConstructor`,
 * `Reflect`, `Map`), which is the holder however the call reached it. */
function declaredHolder(declaration: ts.Node): string | null {
   for (let n: ts.Node | undefined = declaration.parent; n !== undefined; n = n.parent) {
      if (ts.isInterfaceDeclaration(n)) return n.name.text;
      if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
   }
   return null;
}

/** True when an `Object.fromEntries` argument is an array literal carrying an entry
 * whose first element statically spells the property. */
function entriesSpellProperty(argument: ts.Expression | undefined, checker: ts.TypeChecker): boolean {
   if (argument === undefined || !ts.isArrayLiteralExpression(argument)) return false;
   return argument.elements.some(
      (entry) =>
         ts.isArrayLiteralExpression(entry) &&
         entry.elements.length > 0 &&
         constantStringOf(entry.elements[0], checker) === ROLE_EXCEPTION_PROPERTY,
   );
}

/**
 * True when a source string literal is a JSON DOCUMENT carrying the property as a
 * key, at any depth. The text is parsed rather than substring-matched, deliberately:
 * a literal that merely NAMES the property (an error message, a comment, this
 * audit's own constant) creates nothing and must not be flagged, while
 * `'{"metadataFile":true}'` handed to a parser creates exactly the thing this pin is
 * about.
 */
function jsonSpellsProperty(text: string): boolean {
   let parsed: unknown;
   try {
      parsed = JSON.parse(text);
   } catch {
      return false;
   }
   const walk = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(walk);
      if (typeof value !== 'object' || value === null) return false;
      const record = value as Record<string, unknown>;
      return Object.keys(record).includes(ROLE_EXCEPTION_PROPERTY) || Object.values(record).some(walk);
   };
   return walk(parsed);
}

/**
 * REFLECTIVE construction: the calls that create a property from a KEY ARGUMENT, or
 * from a key spelled inside a document, rather than from a member written into an
 * object literal: the shapes nothing else in this scan would see. Returns the
 * spelling to record, or null.
 *
 * `Object.assign`, `Object.defineProperties`, `Object.create` and a spread are
 * deliberately NOT here: each takes an object literal, so the literal rule already
 * records the member at the literal itself, wherever that literal is written. The
 * role-laundering corpus carries one probe per form so that coverage is asserted
 * rather than assumed.
 *
 * `defineProperty` and `fromEntries` belong to no other API this repository uses, so
 * the member name alone counts and an aliased binding is caught with it. `set` and
 * `parse` are ordinary English words that a map, a cache, a schema and a date
 * library all carry, so they count only when the holder says `Reflect` or `JSON`,
 * spelled at the call, or resolved to the interface or namespace the declaration
 * sits in.
 */
function reflectiveConstruction(node: ts.CallExpression, checker: ts.TypeChecker): string | null {
   const keyAt = (index: number): boolean =>
      node.arguments.length > index && constantStringOf(node.arguments[index], checker) === ROLE_EXCEPTION_PROPERTY;
   const first = node.arguments[0];
   for (const { member, holder } of calleeMembers(node, checker)) {
      if (member === 'defineProperty' && keyAt(1)) return `${holder ?? 'aliased'}.defineProperty`;
      if (member === 'set' && holder === 'Reflect' && keyAt(1)) return 'Reflect.set';
      if (member === 'fromEntries' && entriesSpellProperty(first, checker)) {
         return `${holder ?? 'aliased'}.fromEntries`;
      }
      if (member === 'parse' && holder === 'JSON' && first !== undefined) {
         const text = constantStringOf(first, checker);
         if (text !== null && jsonSpellsProperty(text)) return 'JSON.parse';
      }
   }
   return null;
}

/**
 * Every CONSTRUCTION of the metadata-file verdict in one file, keyed `file#symbol`.
 *
 * A property can be put on an object in a bounded number of statically named ways,
 * and all of them count: written into a literal as an identifier, a quoted key or a
 * computed literal key; contributed by a shorthand; assigned onto a value afterwards
 * by dot or by subscript; or created reflectively, where the key is an argument
 * (`Object.defineProperty`, `Reflect.defineProperty`, `Reflect.set`,
 * `Object.fromEntries`) or a member of a literal the call is handed
 * (`Object.assign`, `Object.defineProperties`, `Object.create`, a spread). On top of
 * the spellings, every key position is asked for the constant string it RESOLVES to,
 * so a key held in a literal-typed constant is caught even though the property is
 * spelled nowhere at the site.
 *
 * The NAME is what decides, never the object's type: a verdict built on an
 * `any`-typed value, or on a shape the checker cannot relate to `TargetVerdict`,
 * must fail this audit rather than slip through it. Reflective forms compile even
 * where a direct assignment would not (a readonly or narrowed type), which is
 * exactly why they are audited here rather than left to the compiler.
 *
 * READING the property is not constructing it, so a plain `verdict.metadataFile`
 * test is deliberately not a hit; only key positions that create it are.
 *
 * THE RESIDUAL, stated exactly. One class remains outside, and only one: a key
 * ASSEMBLED AT RUNTIME, so that no single string can be resolved for it statically:
 * a concatenation (`'metadata' + 'File'`), a template with substitutions, a variable
 * the checker cannot narrow to one literal, a value read from data. Every such site
 * is invisible to any static audit, this one included; its closure is human, through
 * `docs/practice/trust-boundary.md` and the diff review. What is NOT residual, and
 * was once wrongly claimed to be: reflective construction with a statically spelled
 * key, which the corpus below now flags in every form.
 */
function roleExceptions(rel: string, source: ts.SourceFile, checker: ts.TypeChecker): Hit[] {
   const hits: Hit[] = [];
   const seen = new Set<number>();
   const record = (node: ts.Node, spelling: string): void => {
      const start = node.getStart(source);
      if (seen.has(start)) return;
      seen.add(start);
      hits.push({
         key: `${rel}#${enclosingSymbol(node)}`,
         line: source.getLineAndCharacterOfPosition(start).line + 1,
         name: spelling,
      });
   };
   const visit = (node: ts.Node): void => {
      // Written into an object literal: `x: v`, `'x': v`, `['x']: v`, `[key]: v`.
      if (ts.isPropertyAssignment(node)) {
         const spelled = propertyNameText(node.name);
         const resolved = ts.isComputedPropertyName(node.name) ? constantStringOf(node.name.expression, checker) : null;
         if (spelled === ROLE_EXCEPTION_PROPERTY || resolved === ROLE_EXCEPTION_PROPERTY) record(node, 'property');
      }
      // Contributed by a shorthand: `{ metadataFile }`.
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === ROLE_EXCEPTION_PROPERTY) {
         record(node, 'shorthand');
      }
      // Assigned onto a value afterwards, in every form of assignment operator.
      if (ts.isBinaryExpression(node) && ts.isAssignmentExpression(node, /*excludeCompoundAssignment*/ false)) {
         const target = node.left;
         if (ts.isPropertyAccessExpression(target) && target.name.text === ROLE_EXCEPTION_PROPERTY) {
            record(node, 'assignment');
         }
         if (
            ts.isElementAccessExpression(target) &&
            constantStringOf(target.argumentExpression, checker) === ROLE_EXCEPTION_PROPERTY
         ) {
            record(node, 'subscript');
         }
      }
      // Created reflectively, from a key argument no other rule here would see.
      if (ts.isCallExpression(node)) {
         const reflective = reflectiveConstruction(node, checker);
         if (reflective !== null) record(node, reflective);
      }
      ts.forEachChild(node, visit);
   };
   visit(source);
   return hits;
}

/** Every metadata-file construction in the production sources of one program. */
function roleAudit(scanned: ts.Program, root: string): Hit[] {
   const checker = scanned.getTypeChecker();
   const hits: Hit[] = [];
   const files = scanned
      .getSourceFiles()
      .filter((f) => !f.isDeclarationFile && path.resolve(f.fileName).startsWith(root + path.sep))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
   assert.ok(files.length > 0, 'the role audit loaded no source files');
   for (const source of files) {
      const rel = path.relative(root, path.resolve(source.fileName)).split(path.sep).join('/');
      hits.push(...roleExceptions(rel, source, checker));
   }
   return hits;
}

test('the role rule has exactly one declared exception, constructed at one named site', () => {
   const hits = roleAudit(program(), srcDir);
   const outside = unexpected(hits, ALLOWED_ROLE_EXCEPTIONS);
   assert.deepEqual(
      outside,
      [],
      `a metadata-file verdict is constructed outside the declared exception: ${outside.join(', ')}\n` +
         'The role rule allows one target that belongs to no role; argue any other into the list, or route the write through its own role.',
   );
   const dead = stale(hits, ALLOWED_ROLE_EXCEPTIONS);
   assert.deepEqual(dead, [], `role-exception entries matching no symbol (delete them): ${dead.join(', ')}`);
   assert.equal(hits.length, Object.keys(ALLOWED_ROLE_EXCEPTIONS).length, 'one construction, not several at one site');
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

/** A probe corpus as a program: the real compiler host with the synthetic files
 * overlaid, so `node:fs`, a local re-export and `../lib/layout.js` all resolve
 * exactly as they do in `src/`. */
function probeProgram(probes: ReadonlyArray<{ rel: string; source: string }>): { program: ts.Program; root: string } {
   const root = path.join(srcDir, '__audit_probes');
   const files = new Map<string, string>(probes.map((p) => [path.join(root, p.rel), p.source]));
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
   const { program: probes, root } = probeProgram(PROBES);
   const { writes, subprocesses } = auditProgram(probes, root);
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

/**
 * The role-exception laundering corpus, permanent. Each file is another way of
 * putting `metadataFile` on a verdict, and each must be flagged: the promise the
 * single-constructor pin makes is that a SECOND exception cannot be added quietly,
 * so every spelling a second one could take is asserted here rather than assumed.
 * The last file is the control: a longer, unrelated property that merely starts
 * with the same letters, which must never be flagged.
 */
const ROLE_PROBES: ReadonlyArray<{ rel: string; source: string; flagged: boolean }> = [
   {
      rel: '__probe_role_identifier.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderIdentifierKey(): TargetVerdict {',
         '   return { ok: true, metadataFile: true };',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_string_key.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderStringKey(): TargetVerdict {',
         "   return { ok: true, 'metadataFile': true };",
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_computed_key.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderComputedKey(): TargetVerdict {',
         "   return { ok: true, ['metadataFile']: true };",
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_shorthand.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'const metadataFile = true as const;',
         'export function launderShorthand(): TargetVerdict {',
         '   return { ok: true, metadataFile };',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_assignment.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderAssignment(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         '   verdict.metadataFile = true;',
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_subscript.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderSubscript(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         "   verdict['metadataFile'] = true;",
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_aliased_key.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         "const key = 'metadataFile' as const;",
         'export function launderAliasedKey(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         '   verdict[key] = true;',
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_aliased_literal_key.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         "const literalKey = 'metadataFile' as const;",
         'export function launderAliasedLiteralKey(): TargetVerdict {',
         '   return { ok: true, [literalKey]: true };',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_define_property.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderDefineProperty(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         "   Object.defineProperty(verdict, 'metadataFile', { value: true });",
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_define_property_resolved_key.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         "const reflectiveKey = 'metadataFile' as const;",
         'export function launderDefinePropertyResolvedKey(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         '   Object.defineProperty(verdict, reflectiveKey, { value: true });',
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_define_property_aliased.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'const { defineProperty } = Object;',
         'export function launderAliasedDefineProperty(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         "   defineProperty(verdict, 'metadataFile', { value: true });",
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_reflect_define_property.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderReflectDefineProperty(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         "   Reflect.defineProperty(verdict, 'metadataFile', { value: true });",
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_reflect_set.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderReflectSet(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         "   Reflect.set(verdict, 'metadataFile', true);",
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_reflect_set_aliased.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'const { set } = Reflect;',
         'export function launderAliasedReflectSet(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         "   set(verdict, 'metadataFile', true);",
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_define_properties.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderDefineProperties(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         '   Object.defineProperties(verdict, { metadataFile: { value: true } });',
         '   return verdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_object_create.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderObjectCreate(): TargetVerdict {',
         '   return Object.create({ ok: true }, { metadataFile: { value: true } }) as TargetVerdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_object_assign.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderObjectAssign(): TargetVerdict {',
         '   const verdict: TargetVerdict = { ok: true };',
         '   return Object.assign(verdict, { metadataFile: true });',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_spread.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderSpread(): TargetVerdict {',
         '   return { ok: true, ...{ metadataFile: true } };',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_from_entries.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderFromEntries(): TargetVerdict {',
         "   return Object.fromEntries([['ok', true], ['metadataFile', true]]) as unknown as TargetVerdict;",
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_json_parse.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'export function launderJsonParse(): TargetVerdict {',
         '   return JSON.parse(\'{"ok":true,"metadataFile":true}\') as TargetVerdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_json_parse_const.ts',
      flagged: true,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'const document = \'{"ok":true,"metadataFile":true}\' as const;',
         'export function launderJsonParseConst(): TargetVerdict {',
         '   return JSON.parse(document) as TargetVerdict;',
         '}',
      ].join('\n'),
   },
   {
      rel: '__probe_role_negative.ts',
      flagged: false,
      source: [
         "import { type TargetVerdict } from '../lib/layout.js';",
         'interface Unrelated {',
         '   metadataFileName: string;',
         '}',
         'export function notTheException(verdict: TargetVerdict): Unrelated {',
         "   const other: Unrelated = { metadataFileName: 'x' };",
         "   other.metadataFileName = 'y';",
         "   Object.defineProperty(other, 'metadataFileName', { value: 'z' });",
         "   Reflect.set(other, 'metadataFileName', 'w');",
         '   const cache = new Map<string, boolean>();',
         "   cache.set('metadataFile', verdict.ok);",
         '   JSON.parse(\'{"metadataFileName":"z"}\') as Unrelated;',
         "   const message = 'metadataFile is the one exception the role rule allows';",
         '   if (message.length === 0) other.metadataFileName = message;',
         "   if (verdict.metadataFile === true) other.metadataFileName = 'read';",
         '   return other;',
         '}',
      ].join('\n'),
   },
];

test('the role-exception pin sees through every spelling a second exception could take', () => {
   const { program: probes, root } = probeProgram(ROLE_PROBES);
   const flagged = new Set(roleAudit(probes, root).map((h) => h.key.split('#')[0]));
   for (const probe of ROLE_PROBES.filter((p) => p.flagged)) {
      assert.ok(
         flagged.has(probe.rel),
         `${probe.rel} laundered a metadata-file verdict past the pin (flagged: ${[...flagged].join(', ') || 'nothing'})`,
      );
   }
   assert.equal(
      flagged.has('__probe_role_negative.ts'),
      false,
      'a longer, unrelated property name must not be flagged',
   );
});
