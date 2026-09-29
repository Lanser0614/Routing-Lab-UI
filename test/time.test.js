import assert from 'node:assert/strict';
import test from 'node:test';
import { tashkentNow } from '../src/time.js';
import { minutesNear, validateOrder } from '../src/domain.js';

test('tashkentNow is GMT+5 regardless of server timezone', () => {
  const now = tashkentNow(new Date('2026-09-29T20:14:00Z'));
  assert.equal(now.date, '30.09.2026');
  assert.equal(now.hm, '01:14');
  assert.equal(now.minutes, 74);
});

test('HH:MM around midnight is resolved to the nearest day', () => {
  assert.equal(minutesNear('00:25', 23 * 60 + 50), 24 * 60 + 25);
  assert.equal(minutesNear('23:55', 10), -5);
  assert.doesNotThrow(() => validateOrder({ address:'A', status:'WAITING', sum:1, service:0, x:1, y:1, created:'23:45', ready:'23:55', deadline:'00:25' }));
});
