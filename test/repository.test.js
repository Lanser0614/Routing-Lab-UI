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

test('fixture import preserves existing orders and source fields, defaults to local, and is repeatable', t => {
  const repo=repository(t);
  repo.upsertOrder('O1',ORDER,true);
  const imported={...ORDER,id:'5019d908-349f-42fa-9d5b-6bba504486b9',number:49,
    createdAt:'2026-10-01T17:39:00+05:00'};
  repo.importOrders([imported]);
  repo.importOrders([imported]);
  assert.equal(repo.list('orders').length,2);
  assert.equal(repo.list('orders').find(o=>o.id===imported.id).number,49);
  assert.equal(repo.scenario().settings.matrixProvider,'local');
  assert.equal(repo.scenario().settings.alwaysFreeCouriers,true);
  assert.equal(repo.nextId('orders','O'),2);
});

test('fixed SQLite planning time reconstructs only observed order events and preserves full UI list', t => {
  const repo=repository(t);
  repo.importOrders([{...ORDER,id:'A',created:'13:00',ready:'13:12',deadline:'13:35',
    createdAt:'2026-10-01T13:00:00+05:00',readyAt:'2026-10-01T13:12:00+05:00',
    events:[{observedAt:'2026-10-01T13:01:00+05:00',status:'CookingStarted'},
      {observedAt:'2026-10-01T13:20:00+05:00',status:'OnWay'}]}]);
  repo.updateSettings({planningAt:'2026-10-01T13:10:00+05:00'});
  assert.equal(repo.snapshot().planningAt.hm,'13:10');
  assert.equal(repo.snapshot().orders[0].status,'COOKING_STARTED');
  repo.updateSettings({planningAt:'2026-10-01T13:25:00+05:00'});
  assert.equal(repo.snapshot().orders.length,0);
  assert.equal(repo.bootstrap().orders.length,1);
  assert.throws(()=>repo.updateSettings({planningAt:'2026-02-30T13:00:00+05:00'}));
  repo.updateSettings({planningAt:''});
  assert.equal(repo.snapshot().orders.length,1);
});

test('planning hour range filters creation times with exclusive end and reset restores current clock', t => {
  const repo=repository(t);
  repo.clock=()=>new Date('2026-10-01T10:00:00Z');
  repo.importOrders([
    {...ORDER,id:'A',created:'12:59',ready:'13:00',deadline:'13:34',createdAt:'2026-10-01T12:59:00+05:00'},
    {...ORDER,id:'B',created:'13:00',ready:'13:10',deadline:'13:35',createdAt:'2026-10-01T13:00:00+05:00'},
    {...ORDER,id:'C',created:'14:00',ready:'14:10',deadline:'14:35',createdAt:'2026-10-01T14:00:00+05:00'}]);
  repo.updateSettings({planningDate:'2026-10-01',planningHourFrom:13,planningHourTo:14,planningAt:'2026-10-01T13:30:00+05:00'});
  assert.deepEqual(repo.bootstrap().orders.map(o=>o.id),['B']);
  assert.equal(repo.snapshot().planningAt.hm,'13:30');
  assert.throws(()=>repo.updateSettings({planningHourFrom:14}));
  repo.updateSettings({planningDate:'',planningAt:'',planningHourFrom:0,planningHourTo:24});
  assert.equal(repo.bootstrap().orders.length,3);
  assert.equal(repo.snapshot().planningAt.hm,'15:00');
});

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


test('timing settings validate and persist while old run stays immutable', t => {
  const repo = repository(t);
  repo.createRun();
  const old = repo.latestRun();
  assert.throws(() => repo.updateSettings({ goOutFromBranchMin: -1 }), e => e.status === 422);
  assert.throws(() => repo.updateSettings({ bucketMaxOrders: 1.5 }), e => e.status === 422);
  assert.throws(() => repo.updateSettings({ returnBufferPct: null }), e => e.status === 422);
  repo.updateSettings({ goOutFromBranchMin: 4, returnBufferPct: 30 });
  assert.equal(repo.bootstrap().settings.goOutFromBranchMin, 4);
  assert.equal(repo.latestRun().settings.goOutFromBranchMin, old.settings.goOutFromBranchMin);
  assert.equal(repo.createRun().settings.returnBufferPct, 30);
});
