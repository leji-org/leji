#!/usr/bin/env node
// `npm create leji [args]` == `leji init [args]`.
import { run } from '@leji-org/leji';

process.exit(await run(['init', ...process.argv.slice(2)]));
