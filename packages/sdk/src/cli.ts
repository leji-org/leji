#!/usr/bin/env node
import { run } from './index.js';

process.exit(await run(process.argv.slice(2)));
