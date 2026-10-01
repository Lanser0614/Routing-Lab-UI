import assert from 'node:assert/strict';
import test from 'node:test';
import { runAlgorithms } from '../src/planning.js';
import { BRANCH_POINT } from '../src/branch.js';

const snapshot = {
  version: 1,
  settings: { allowLate: true },
  orders: [
    { id:'O1', address:'A', status:'WAITING', sum:100000, created:'17:40', ready:'17:55', deadline:'18:25', service:60, x:175, y:150 },
    { id:'O2', address:'B', status:'WAITING', sum:100000, created:'17:45', ready:'17:55', deadline:'18:30', service:60, x:340, y:215 },
    { id:'O3', address:'C', status:'WAITING', sum:100000, created:'17:50', ready:'18:00', deadline:'18:35', service:60, x:470, y:390 }
  ],
  couriers: [
    { id:'C1', name:'One', status:'FREE', mode:'SCOOTER', maxOrders:2, maxSum:200000, zones:['Z1'], freeSince:'17:50' },
    { id:'C2', name:'Two', status:'FREE', mode:'DRIVING', maxOrders:2, maxSum:200000, zones:['Z1','Z2'], freeSince:'17:55' }
  ]
};

test('all five algorithms produce invariant-safe plans', () => {
  const run = runAlgorithms(snapshot);
  assert.equal(run.results.length, 5);
  for (const result of run.results) {
    assert.equal(result.skipped, undefined);
    const orders = result.routes.flatMap(route => route.ids);
    const couriers = result.routes.map(route => route.c.id);
    assert.equal(new Set(orders).size, orders.length, `${result.code}: duplicate order`);
    assert.equal(new Set(couriers).size, couriers.length, `${result.code}: duplicate courier`);
    result.routes.filter(route => !route.late).forEach(route => assert.equal(route.ev.feasible, true, `${result.code}: infeasible route`));
  }
});

test('Exact is not worse than heuristics on assigned on-time count', () => {
  const results = runAlgorithms(snapshot).results;
  const exact = results.at(-1);
  results.slice(0, -1).forEach(result => assert.ok(exact.onTime >= result.onTime));
});

test('orders outside zones remain visible and unassigned', () => {
  const changed = structuredClone(snapshot);
  changed.orders[0].x = 790;
  changed.orders[0].y = 590;
  const run = runAlgorithms(changed);
  run.results.forEach(result => assert.ok(result.unassigned.some(item => item.id === 'O1' && item.code === 'OUTSIDE_ZONE')));
});

test('planning uses the Tashkent planning moment and handles midnight', () => {
  const snapshot = {
    settings: { allowLate: false },
    planningAt: { date: '30.09.2026', hm: '23:50', minutes: 23 * 60 + 50, timezone: 'Asia/Tashkent' },
    orders: [{ id:'N1', address:'A', status:'WAITING', sum:100000, created:'23:45', ready:'23:55', deadline:'00:25', service:60, x:400, y:330 }],
    couriers: [{ id:'C1', name:'One', status:'FREE', mode:'SCOOTER', maxOrders:2, maxSum:200000, zones:['Z1'], freeSince:'23:40' }]
  };
  const result = runAlgorithms(snapshot);
  assert.equal(result.planningAt.hm, '23:50');
  result.results.forEach(algorithm => assert.equal(algorithm.onTime, 1, algorithm.code));
});


test('all algorithms apply exit buffer when deciding whether a solo fits SLA', () => {
  const changed = structuredClone(snapshot);
  changed.settings = { allowLate: false, goOutFromBranchMin: 0 };
  changed.planningAt = { minutes: 1080 };
  changed.orders = [{ ...snapshot.orders[0], x: BRANCH_POINT[0], y: BRANCH_POINT[1], ready: '18:00', deadline: '18:01' }];
  const without = runAlgorithms(changed);
  without.results.forEach(result => assert.equal(result.onTime, 1));
  changed.settings.goOutFromBranchMin = 2;
  runAlgorithms(changed).results.forEach(result => assert.equal(result.onTime, 0));
});

test('return buffer and legacy per-order service do not affect IO Planner ETA', () => {
  const changed = structuredClone(snapshot);
  const before = runAlgorithms(changed);
  changed.settings.returnBufferPct = 50;
  changed.orders.forEach(order => { order.service = 3600; });
  const after = runAlgorithms(changed);
  after.results.forEach((result, i) => {
    assert.deepEqual(result.routes.map(r => r.ev.stops), before.results[i].routes.map(r => r.ev.stops));
    result.routes.forEach(r => assert.equal(r.ev.bufferedReturnMin, r.ev.returnLegMin * 1.5));
  });
});

test('branch count and value caps constrain every algorithm', () => {
  const changed = structuredClone(snapshot);
  changed.settings = { allowLate: false, bucketMaxOrders: 1, bucketMaxFullSum: 100000 };
  runAlgorithms(changed).results.forEach(result => result.routes.forEach(r => {
    assert.equal(r.ids.length, 1);
    assert.ok(r.ev.sum <= 100000);
  }));
});
