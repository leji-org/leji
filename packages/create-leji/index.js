#!/usr/bin/env node
// `npm create leji [dir]` — the one-time bootstrap: `leji init` where there is
// nothing to adopt, `leji adopt` where the repository already carries docs or an
// agent entrypoint, nothing at all where a layer is already in place.
//
// A thin router and nothing else. It asks no question of its own, writes nothing,
// and reads only the selected target directory: a listing plus a handful of exact
// target-relative paths. Every durable offer (dependency declaration, MCP, hooks,
// handoff) belongs to `init`/`adopt`, which own their own preconditions — the router
// decides, they enforce.
import * as path from 'node:path';
import { run } from '@leji-org/leji';
import { classifyTarget } from '@leji-org/leji/internal/create';

const USAGE = `Usage: create-leji [dir] [leji init/adopt flags]

Bootstraps a Leji context layer in [dir], or in the current directory.
Routing: an existing docs root, or an agent entrypoint (CLAUDE.md, AGENTS.md,
   .cursor/rules, ...), routes to \`leji adopt\`; anything else to \`leji init\`.
   A repository that already has a leji.json is left alone (exit 0).
Overrides: --init / --adopt force the branch; an unreadable target exits 2.
Flags pass through to leji. npm needs \`--\` first: npm create leji -- --yes`;

/** The router's own flags: consumed here, never delegated, never a directory. */
const ROUTER_FLAGS = new Set(['--init', '--adopt', '-h', '--help']);

function refuse(message) {
   console.error(`create-leji: ${message}`);
   return 2;
}

/** leji's own rule for what can be a flag's value: a lone `-` can, anything else dashed cannot. */
const isFlagToken = (v) => v !== undefined && v !== '-' && v.startsWith('-');

/** The two flags leji resolves a target directory from. */
const DIR_FLAGS = new Set(['--dir', '--root']);

/**
 * argv as leji's parser sees the two directory flags: `--dir=<v>` split into
 * `--dir <v>` on its first `=` (the parser's own `expandEqualsFlags`, same rule), and
 * nothing past a literal `--`, which is host pass-through there rather than a flag.
 * The delegated argv is never rewritten from this; it exists only so the router reads
 * the target out of the argv the parser will actually see.
 */
function asParsed(argv) {
   const out = [];
   for (const a of argv) {
      if (a === '--') break;
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      if (eq > 2 && DIR_FLAGS.has(a.slice(0, eq))) out.push(a.slice(0, eq), a.slice(eq + 1));
      else out.push(a);
   }
   return out;
}

/**
 * The value leji's parser will end up with for a directory-bearing flag, read the way
 * that parser reads it: every occurrence in order, the last valid one winning, and any
 * occurrence without a usable value (missing, empty, or another flag) marking the whole
 * argv as one the parser refuses.
 */
function flagValue(argv, flag) {
   let value = null;
   let malformed = false;
   for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== flag) continue;
      const v = argv[i + 1];
      if (v === undefined || v === '' || isFlagToken(v)) malformed = true;
      else value = v;
   }
   return { value, malformed };
}

async function main(argv) {
   // Meta-flags short-circuit wherever they appear, as leji's own parser does: a help
   // request never runs a command.
   if (argv.includes('-h') || argv.includes('--help')) {
      console.log(USAGE);
      return 0;
   }

   const forceInit = argv.includes('--init');
   const forceAdopt = argv.includes('--adopt');
   if (forceInit && forceAdopt) return refuse('--init and --adopt cannot be combined');
   // The router's own flags never reach leji, and they come out before the positional
   // rule is applied, so `create-leji --init my-app` still names a directory instead of
   // silently scaffolding the current one.
   const rest = argv.filter((arg) => !ROUTER_FLAGS.has(arg));

   // `<dir>` is the `npm create <name> <dir>` convention and is valid only as the
   // first argument. Everything else passes through verbatim, in order, including a
   // `--dir <value>` the caller wrote themselves.
   const positional = rest.length > 0 && !rest[0].startsWith('-') ? rest[0] : null;
   const parsed = asParsed(rest);
   let args = rest;
   if (positional !== null) {
      const tail = rest.slice(1);
      // `--dir` in either spelling: `asParsed` has already split `--dir=<v>`, so one
      // check covers both.
      if (asParsed(tail).includes('--dir'))
         return refuse('give the directory once: either as `create-leji <dir>` or as `--dir <dir>`');
      // A bare token is a second directory only when nothing flag-shaped precedes it;
      // after a flag it is that flag's value (`create-leji app --name acme`). The rule
      // catches the mistake worth catching — `create-leji app other` — and stays out of
      // the way of leji's own grammar, which the router deliberately does not model.
      const second = tail.find(
         (arg, i) => !arg.startsWith('-') && !(i === 0 ? positional : tail[i - 1]).startsWith('-'),
      );
      if (second !== undefined)
         return refuse(`unexpected argument ${second} (a directory is valid only as the first argument)`);
      args = ['--dir', positional, ...tail];
   }

   // The effective target is the directory the delegated command will act on, resolved
   // exactly as leji resolves it: the positional, else the last `--dir <v>`/`--dir=<v>`,
   // else `--root` in either spelling where there is no `--dir` (leji reads `--root` as
   // the target then), else the cwd. Any other flag reaching init/adopt leaves the target
   // alone, so this is the whole of it: routing on one directory and scaffolding another
   // cannot happen.
   const dir = flagValue(parsed, '--dir');
   const root = flagValue(parsed, '--root');
   const dirLike = positional ?? dir.value;
   const named = dirLike === null || dirLike === '.' ? (root.value ?? dirLike) : dirLike;
   const target = named === null ? process.cwd() : path.resolve(process.cwd(), named);
   const json = rest.includes('--json');
   const command = forceAdopt ? 'adopt' : 'init';

   // A directory flag the parser will refuse leaves the router with no target it can
   // trust, so it classifies nothing and says nothing: leji's usage error is the whole
   // output, and its exit 2 passes through. The command named here never runs, because
   // the parser refuses before dispatch.
   if (dir.malformed || root.malformed) return await run([command, ...args]);

   if (forceInit || forceAdopt) {
      console.error(`create-leji: --${command} → leji ${command}`);
      return await run([command, ...args]);
   }

   switch (classifyTarget(target)) {
      case 'unreadable':
         return refuse(`cannot read ${target}: not a readable directory (permissions, a file, or a broken symlink)`);
      case 'adopted':
         // Bootstrapping is idempotent: a repository that already has a layer is not an
         // error, it is done. Say what comes next and exit clean.
         if (json) {
            console.log(JSON.stringify({ command: 'create-leji', ok: true, route: 'exists', next: ['leji', 'start'] }));
         } else {
            console.error('create-leji: this repository already has a Leji layer; next: leji start');
         }
         return 0;
      case 'adopt':
         // The routing line is stderr in every mode, so `--json` stdout stays exactly the
         // document the delegated command prints.
         console.error('create-leji: existing repository → leji adopt');
         return await run(['adopt', ...args]);
      default:
         console.error('create-leji: new repository → leji init');
         return await run(['init', ...args]);
   }
}

process.exit(await main(process.argv.slice(2)));
