// Kör testsviten i Node (samma tester som tests.html): node tests/run-node.mjs
import { runAll } from './suite.js';

const results = runAll();
for (const r of results) console.log(`${r.ok ? 'GODKÄNT ' : 'UNDERKÄNT'}  ${r.group} › ${r.name}${r.ok ? '' : `\n           ${r.error}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} av ${results.length} godkända`);
process.exit(failed ? 1 : 0);
