import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.js';
import { Repository } from '../src/repository.js';

const ORDER = { id:'O1', address:'Test address', status:'COOKING_COMPLETED', sum:100000, created:'17:39', ready:'17:58', deadline:'18:28', service:60, x:455, y:255 };

test('HTTP flow preserves stale run until the operator starts a new one', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-api-'));
  const repository = new Repository(path.join(directory, 'api.sqlite'));
  const server = createApp(repository).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/api/v1/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ORDER)
  });
  await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const initial = await fetch(`${base}/api/v1/bootstrap`).then(response => response.json());
  const changed = await fetch(`${base}/api/v1/orders/O1/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'WAITING', reason: 'integration test' })
  }).then(response => response.json());
  assert.equal(changed.version, initial.version + 1);
  assert.equal(changed.run.version, initial.run.version);

  const run = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(response => response.json());
  assert.equal(run.version, changed.version);
  assert.equal(run.results.length, 5);

  const scenarioBeforeTest = repository.snapshot();
  const testResponse = await fetch(`${base}/api/v1/test-orders`).then(response=>response.json());
  assert.equal(testResponse.settings.alwaysFreeCouriers,true);
  assert.equal(testResponse.orders.length,20);
  assert.deepEqual(repository.list('orders'), scenarioBeforeTest.orders);
  assert.equal(repository.scenario().version,scenarioBeforeTest.version);
  assert.equal(repository.latestRun().number,run.number);

  const local = await fetch(`${base}/api/v1/test-orders`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({
      settings:{matrixProvider:'local',matrixMode:'economy'}})}).then(r=>r.json());
  assert.equal(local.run.matrixProvider,'LOCAL_DETERMINISTIC');
  const unavailable = await fetch(`${base}/api/v1/test-orders`,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({settings:{matrixProvider:'yandex'}})});
  assert.equal(unavailable.status,503);

  const invalid = await fetch(`${base}/api/v1/orders/O1/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'DELIVERED' })
  });
  assert.equal(invalid.status, 409);
  assert.match(invalid.headers.get('content-type'), /application\/problem\+json/);
});
