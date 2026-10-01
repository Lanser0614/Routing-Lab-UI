import fs from 'node:fs';
import { runTestScenario } from '../src/historical-scenario.js';
const at = process.argv[2];
const test = runTestScenario(at, {}, process.argv[3]);
const target = new URL('../test/fixtures/orders-2026-10-01-result.json', import.meta.url);
fs.writeFileSync(target, JSON.stringify(test, null, 2) + '\n');
console.log(`Snapshot ${test.planningAt.date} ${test.planningAt.hm}: ${test.orders.length} orders; unlimited FREE test couriers`);
for (const result of test.run.results) {
  console.log(result.skipped ? `${result.code}: ${result.skipped}` :
    `${result.code}: ${result.buckets} buckets, ${result.onTime} on time, ${result.late} late solo, ${result.unassigned.length} unassigned`);
}
console.log(`Result: ${target.pathname}`);
