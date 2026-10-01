import fs from 'node:fs';
import { runAlgorithms } from './planning.js';
import { validateSettings } from './settings.js';
import { problem } from './domain.js';

export const TEST_ORDERS_PATH = new URL('../test/fixtures/orders-2026-10-01.json', import.meta.url);
const hm = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2,'0')}:${String(Math.floor(minutes % 60)).padStart(2,'0')}`;
const statusMap = { WaitCooking: 'COOKING_STARTED', CookingStarted: 'COOKING_STARTED',
  CookingCompleted: 'COOKING_COMPLETED', Waiting: 'WAITING' };

export function fixture() { return JSON.parse(fs.readFileSync(TEST_ORDERS_PATH, 'utf8')); }

export function testSnapshot(data, at) {
  const epoch = Date.parse(at);
  if (!Number.isFinite(epoch)) throw problem(422, 'RUN_INPUT_INVALID', 'Неверное время тестового среза');
  const dayStart = Date.parse(`${at.slice(0,10)}T00:00:00+05:00`);
  const minutes = value => (Date.parse(value) - dayStart) / 60000;
  const orders = data.orders.flatMap(order => {
    const events = order.events.filter(event => Date.parse(event.observedAt) <= epoch);
    const event = events.at(-1);
    if (!event || !statusMap[event.status] || Date.parse(order.createdAt) > epoch) return [];
    const readyAt = event.cookingCompletedAt || order.readyAt;
    const deadlineAt = new Date(Date.parse(order.createdAt) + 35 * 60000).toISOString();
    // Deliberate test cohort: incomplete exports can retain Waiting long after its deadline.
    if (Date.parse(deadlineAt) < epoch) return [];
    return [{ ...order, status: statusMap[event.status], sum: event.sum ?? order.sum,
      deadlineAt, deadlineSource: 'whenCreated + 35 min',
      createdMinutes: minutes(order.createdAt), readyMinutes: minutes(readyAt), deadlineMinutes: minutes(deadlineAt),
      ready: hm(minutes(readyAt)), deadline: hm(minutes(deadlineAt)) }];
  });
  return { version: `test-${at.slice(11,16)}`, orders, couriers: [], settings: { ...data.settings, alwaysFreeCouriers: true },
    testAt: at,
    planningAt: { date: at.slice(0,10).split('-').reverse().join('.'), hm: hm(minutes(at)),
      minutes: minutes(at), timezone: 'Asia/Tashkent' } };
}

export function testTimes(data) {
  const all = data.orders.flatMap(order => order.events.map(event => Date.parse(event.observedAt)));
  const times = [];
  for (let epoch = Math.ceil(Math.min(...all) / 300000) * 300000; epoch <= Math.max(...all); epoch += 300000) {
    const at = new Date(epoch + 5 * 3600000).toISOString().replace('Z', '+05:00');
    const count = testSnapshot(data, at).orders.length;
    if (count) times.push({ at, orders: count });
  }
  return times;
}

export function hourlyRanges(data) {
  const groups = new Map();
  for (const order of data.orders) {
    const date = order.createdAt.slice(0,10);
    const hour = Number(order.createdAt.slice(11,13));
    const start = `${date}T${String(hour).padStart(2,'0')}:00:00+05:00`;
    const end = new Date(Date.parse(start) + 3600000);
    const endLocal = new Date(end.getTime() + 5 * 3600000).toISOString().replace('Z','+05:00');
    const label = `${String(hour).padStart(2,'0')}:00–${String((hour+1)%24).padStart(2,'0')}:00`;
    const id = `${String(hour).padStart(2,'0')}:00-${String((hour+1)%24).padStart(2,'0')}:00`;
    if (!groups.has(id)) groups.set(id,{id,label,start,end:endLocal,orders:0});
    groups.get(id).orders += 1;
  }
  return [...groups.values()].sort((a,b)=>a.start.localeCompare(b.start));
}

export function ordersInRange(data, range) {
  return data.orders.filter(order => Date.parse(order.createdAt) >= Date.parse(range.start)
    && Date.parse(order.createdAt) < Date.parse(range.end));
}

export function prepareTestScenario(at, settings = {}, rangeId) {
  validateSettings(settings);
  const data = fixture();
  const ranges = hourlyRanges(data);
  const range = rangeId ? ranges.find(item=>item.id===rangeId) : null;
  if (rangeId && !range) throw problem(422,'RUN_INPUT_INVALID','Неизвестный часовой диапазон');
  const cohort = range ? { ...data, orders: ordersInRange(data,range) } : data;
  const times = testTimes(cohort).filter(item=>!range ||
    (Date.parse(item.at)>=Date.parse(range.start) && Date.parse(item.at)<Date.parse(range.end)));
  const selected = at || [...times].sort((a,b) => b.orders-a.orders || a.at.localeCompare(b.at))[0]?.at || range?.start;
  if (!selected) throw problem(422,'RUN_INPUT_INVALID','Нет доступного тестового среза');
  if (range && !(Date.parse(selected)>=Date.parse(range.start) && Date.parse(selected)<Date.parse(range.end))) {
    throw problem(422,'RUN_INPUT_INVALID','Время расчёта должно входить в выбранный часовой диапазон');
  }
  const snapshot = testSnapshot(cohort, selected);
  if (range) snapshot.version = `test-${range.id}-${snapshot.planningAt.hm}`;
  snapshot.settings = { ...snapshot.settings, ...settings, alwaysFreeCouriers: true };
  return { ...snapshot, times, ranges, range, extraction: data.extraction, assumptions: data.assumptions };
}

export function calculateTestScenario(snapshot) {
  const result=runAlgorithms(snapshot);
  return { ...snapshot, couriers: result.testCouriers || [],
    run: { ...result, version: snapshot.version, number: `TEST ${snapshot.range ? snapshot.range.label + ' · ' : ''}${snapshot.planningAt.hm}` } };
}

export function runTestScenario(at, settings = {}, rangeId) {
  return calculateTestScenario(prepareTestScenario(at,settings,rangeId));
}
