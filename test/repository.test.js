import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Repository } from '../src/repository.js';

const ORDER = { id:'O1', address:'Test address', status:'COOKING_COMPLETED', sum:100000, created:'17:39', ready:'17:58', deadline:'18:28', service:60, x:455, y:255 };

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-lab-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new Repository(path.join(directory, 'test.sqlite'));
}

test('scenario mutations bump version and keep the old run immutable', t => {
  const repo = repository(t);
  repo.upsertOrder('O1', ORDER, true);
  repo.createRun();
  const before = repo.bootstrap();
  repo.setOrderStatus('O1', 'WAITING', 'test');
  const after = repo.bootstrap();
  assert.equal(after.version, before.version + 1);
  assert.equal(after.run.version, before.run.version);
  assert.equal(after.orders.find(order => order.id === 'O1').status, 'WAITING');
});

test('new run captures the current scenario version', t => {
  const repo = repository(t);
  repo.updateSettings({ allowLate: false });
  const run = repo.createRun();
  assert.equal(run.version, repo.scenario().version);
  assert.equal(run.results.length, 5);
});

test('invalid status transition is rejected', t => {
  const repo = repository(t);
  repo.upsertOrder('O1', ORDER, true);
  assert.throws(() => repo.setOrderStatus('O1', 'DELIVERED'), error => error.code === 'ORDER_STATUS_TRANSITION_INVALID' && error.status === 409);
});
