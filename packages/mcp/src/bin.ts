#!/usr/bin/env node
import { main } from './index.js';

main().catch((err) => {
   process.stderr.write(`leji-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
   process.exit(1);
});
