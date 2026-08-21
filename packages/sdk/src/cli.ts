#!/usr/bin/env node
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './index.js';
import { launchLocalCli, resolveLocalCli } from './lib/localcli.js';

/** This file, with every symlink resolved: the one path the hand-off must never
 * select, or a repository whose install points back here would run us forever. An
 * entry that cannot be resolved refuses the hand-off rather than risking that. */
function selfEntry(): string | null {
   try {
      return fs.realpathSync.native(fileURLToPath(import.meta.url));
   } catch {
      return null;
   }
}

// Before anything is parsed: inside a repository that declares the Leji CLI and has
// it installed, this invocation belongs to that pinned copy rather than to whichever
// global PATH found. Only the installed executable does this; `run()` is a library
// call and never hands work to another program.
const local = resolveLocalCli(process.argv.slice(2), process.env, process.platform, selfEntry());
if (local.kind === 'handoff') launchLocalCli(local);

process.exit(await run(process.argv.slice(2)));
