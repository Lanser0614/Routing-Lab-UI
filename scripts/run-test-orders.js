import fs from 'node:fs';
import 'dotenv/config';
import { prepareTestScenario, calculateTestScenario } from '../src/historical-scenario.js';
import { matrixClientFromEnv } from '../src/yandex-matrix.js';
const at = process.argv[2];
const snapshot = prepareTestScenario(at, {}, process.argv[3]);
const client = matrixClientFromEnv();
if (client && snapshot.settings.matrixProvider!=='local') snapshot.roadMatrix = await client.forSnapshot(snapshot);
const test = calculateTestScenario(snapshot);
const target = new URL('../test/fixtures/orders-2026-10-01-result.json', import.meta.url);
fs.writeFileSync(target, JSON.stringify(test, null, 2) + '\n');
console.log(`Snapshot ${test.planningAt.date} ${test.planningAt.hm}: ${test.orders.length} orders; unlimited FREE test couriers`);
console.log(`Matrix: ${test.run.matrixProvider}; ${JSON.stringify(test.run.matrixStats || {})}`);
for (const result of test.run.results) {
  console.log(result.skipped ? `${result.code}: ${result.skipped}` :
    `${result.code}: ${result.buckets} buckets, ${result.onTime} on time, ${result.late} late solo, ${result.unassigned.length} unassigned`);
}
console.log(`Result: ${target.pathname}`);
