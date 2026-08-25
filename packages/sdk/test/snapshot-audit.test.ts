import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The structural half of the snapshot contract: the badge and canary suites hold one
// tree-snapshot helper between them, and a private walker must not be able to grow back
// beside it. A walker needs a directory-enumeration primitive, so this audit counts
// every reference to one in those two files and compares the counts against the named
// exceptions below. The claim is bounded and mechanical: it prevents a walker built on
// the four primitives below, whatever it is named and whether it is a function, a method
// or a closure. It claims nothing about a walker built on anything else; that wider
// closure is review of the imports and call sites, not this scan.
//
// The scan is over the parsed source, so a primitive named in a comment or in ordinary
// prose is not a hit, and a computed access (`fs['readdirSync']`) is: the name has to be
// spelled somewhere for the primitive to be reached, as an identifier or as a string.

const testDir = path.dirname(fileURLToPath(import.meta.url));

/** The four names this audit is bounded to: Node's own directory-enumeration calls,
 * both spellings of each. A walker built on any of them has to spell one, whatever it
 * calls itself. A walker built on something else (`fs.globSync`, a dependency, a
 * shelled-out `find`) spells none of them and is outside the mechanical guarantee: that
 * one is left to review of the imports and call sites. */
const PRIMITIVES: ReadonlySet<string> = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync']);

/** The shared helper, as the two files must import it. */
const HELPER_SPECIFIER = './helpers/snapshot.ts';
const HELPER_EXPORT = 'snapshotTree';

/**
 * The exceptions, by `file#context` with the number of references each context is
 * allowed. A count rather than a bare name, so a new reference fails even inside a
 * context that already holds one; a context that no longer matches fails too, because a
 * stale exception is an exception nobody is checking. `context` is the nearest named
 * function, or the title of the test the reference sits in.
 */
const ALLOWED: Readonly<Record<string, { count: number; reason: string }>> = {
   'badge.test.ts#test: a --out whose parent resolves outside the repository is refused, and reads nothing': {
      count: 1,
      reason: 'lists an out-of-repository directory to prove nothing was created there; one level, no walk',
   },
   'badge.test.ts#test: a --out whose parent resolves into .leji/ is refused, at any depth': {
      count: 1,
      reason: 'asserts the private role is still empty; one level, no walk',
   },
   'badge.test.ts#(top level)': {
      count: 1,
      reason: 'enumerates the fixture directory to generate one test per fixture carrying a badge block',
   },
   'canary.test.ts#copySeed': {
      count: 1,
      reason: 'the seed materializer: copies a committed seed into its declared target',
   },
   'canary.test.ts#filesUnder': {
      count: 1,
      reason: 'the export listing: files only, a different contract from the snapshot',
   },
   'canary.test.ts#walk': {
      count: 1,
      reason: 'the canary token scan inside countToken: reads bytes, records no tree',
   },
   'canary.test.ts#test: check-before-act: an out-of-repository .leji/viewer or .leji/dist alias is REFUSED, and nothing is written outside':
      {
         count: 2,
         reason: 'asserts two out-of-tree destinations are empty; one level each, no walk',
      },
   'canary.test.ts#test: check-before-act: an ancestor swapped to a symlink AFTER enumeration is never followed at use':
      {
         count: 6,
         reason: 'the interception spy: captures, replaces and restores the builtin to swap a tree mid-walk',
      },
};

/** The nearest named function containing `node`, or the title of the test it sits in:
 * what a reviewer would cite when arguing the exception. */
function context(node: ts.Node): string {
   for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
      if (ts.isFunctionLike(n)) {
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
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
         const callee = n.expression.getText();
         if (
            (callee === 'test' || callee === 'it' || callee === 'describe') &&
            ts.isStringLiteralLike(n.arguments[0])
         ) {
            return `test: ${n.arguments[0].text}`;
         }
      }
   }
   return '(top level)';
}

function parse(name: string): ts.SourceFile {
   const file = path.join(testDir, name);
   return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** Every reference to an enumeration primitive in one file, as `file#context` keys with
 * their counts, plus the line of each for the failure message. */
function references(name: string): { counts: Map<string, number>; where: string[] } {
   const source = parse(name);
   const counts = new Map<string, number>();
   const where: string[] = [];
   const visit = (node: ts.Node): void => {
      const spelled = ts.isIdentifier(node) ? node.text : ts.isStringLiteralLike(node) ? node.text : undefined;
      if (spelled !== undefined && PRIMITIVES.has(spelled)) {
         const key = `${name}#${context(node)}`;
         counts.set(key, (counts.get(key) ?? 0) + 1);
         where.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${key}`);
      }
      ts.forEachChild(node, visit);
   };
   visit(source);
   return { counts, where };
}

test('no private tree walker in the badge and canary suites: every enumeration primitive is a named exception', () => {
   const counts = new Map<string, number>();
   const where: string[] = [];
   for (const name of ['badge.test.ts', 'canary.test.ts']) {
      const found = references(name);
      for (const [key, count] of found.counts) counts.set(key, count);
      where.push(...found.where);
   }

   const actual = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1)));
   const expected = Object.fromEntries(
      Object.entries(ALLOWED)
         .map(([key, entry]) => [key, entry.count] as const)
         .sort(([a], [b]) => (a < b ? -1 : 1)),
   );
   assert.deepEqual(
      actual,
      expected,
      `a directory-enumeration primitive appeared where no exception allows it, or an exception no longer matches. Every reference found:\n${where.join('\n')}`,
   );
});

test('the badge and canary suites take their tree snapshots from the shared helper', () => {
   for (const name of ['badge.test.ts', 'canary.test.ts']) {
      const source = parse(name);
      const imported = source.statements.some(
         (statement) =>
            ts.isImportDeclaration(statement) &&
            ts.isStringLiteralLike(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text === HELPER_SPECIFIER &&
            statement.importClause?.namedBindings !== undefined &&
            ts.isNamedImports(statement.importClause.namedBindings) &&
            statement.importClause.namedBindings.elements.some((element) => element.name.text === HELPER_EXPORT),
      );
      assert.ok(imported, `${name} imports ${HELPER_EXPORT} from ${HELPER_SPECIFIER}`);

      let calls = 0;
      const visit = (node: ts.Node): void => {
         if (ts.isCallExpression(node) && node.expression.getText() === HELPER_EXPORT) calls += 1;
         ts.forEachChild(node, visit);
      };
      visit(source);
      assert.ok(calls > 0, `${name} calls ${HELPER_EXPORT}`);
   }
});
