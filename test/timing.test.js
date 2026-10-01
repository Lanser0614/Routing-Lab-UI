import assert from 'node:assert/strict';
import test from 'node:test';
import { bucketTiming, DEFAULT_SETTINGS } from '../src/timing.js';

const orders = [
  { id: 'A', ready: 1085, deadline: 1110 },
  { id: 'B', ready: 1088, deadline: 1115 }
];

test('IO Planner reference: waiting slot, closing floor, exit and prior handovers', () => {
  const result = bucketTiming(orders, [5, 10], 200000, 1080, DEFAULT_SETTINGS);
  assert.equal(result.latestSafeDeparture, 1101);
  assert.equal(result.closingTime, 1089);
  assert.equal(result.dep, 1089);
  assert.equal(result.status, 'pairing');
  assert.deepEqual(result.stops.map(s => s.eta), [1096, 1103]);
  assert.equal(result.minSlack, 12);
});

test('only the real branch value cap closes a full bucket immediately', () => {
  const result = bucketTiming(orders, [5, 10], 1000000, 1080, DEFAULT_SETTINGS);
  assert.equal(result.closingTime, 1080);
  assert.equal(result.dep, 1088);
  assert.equal(result.status, 'closed');
});

test('solo has exit allowance and no customer handover allowance', () => {
  const result = bucketTiming([orders[0]], [5], 100000, 1100, DEFAULT_SETTINGS);
  assert.equal(result.latestSafeDeparture, 1103);
  assert.equal(result.dep, 1100);
  assert.equal(result.stops[0].eta, 1107);
});

test('ready time beyond safe departure makes both bucket and stop late', () => {
  const result = bucketTiming([{ ...orders[0], ready: 1104 }], [5], 100000, 1080, DEFAULT_SETTINGS);
  assert.equal(result.isLate, true);
  assert.equal(result.stops[0].slack, -1);
});

test('full bucket closing is capped by safe departure even if tick is late', () => {
  const result = bucketTiming(orders, [5, 10], 1000000, 1105, DEFAULT_SETTINGS);
  assert.equal(result.closingTime, 1101);
});
