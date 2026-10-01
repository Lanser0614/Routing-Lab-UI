import { performance } from 'node:perf_hooks';
import { ELIGIBLE_ORDER_STATUSES, ZONES, minutesNear } from './domain.js';
import { BRANCH_POINT } from './branch.js';
import { bucketTiming, DEFAULT_SETTINGS, TIMING_MODEL } from './timing.js';

export const ALGORITHMS = ['A1', 'A2', 'A3', 'A4', 'Exact'];
const DEFAULT_PLANNING_AT_MIN = 18 * 60;
const hm = value => { const m = ((Math.round(value) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (((yi > point[1]) !== (yj > point[1])) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function zonesOf(x, y) {
  return ZONES.filter(zone => pointInPolygon([x, y], zone.pts)).map(zone => zone.id);
}

function buildInput(snapshot) {
  const settings = { ...DEFAULT_SETTINGS, ...snapshot.settings };
  const plan = snapshot.planningAt?.minutes ?? DEFAULT_PLANNING_AT_MIN;
  const time = value => minutesNear(value, plan);
  const positions = { BR: BRANCH_POINT };
  const outside = [];
  const orders = [];
  snapshot.orders.filter(order => ELIGIBLE_ORDER_STATUSES.includes(order.status)).forEach(order => {
    const zoneIds = zonesOf(order.x, order.y);
    positions[order.id] = [order.x, order.y];
    const normalized = {
      id: order.id,
      zones: zoneIds,
      ready: Number.isFinite(order.readyMinutes) ? order.readyMinutes : time(order.ready),
      deadline: Number.isFinite(order.deadlineMinutes) ? order.deadlineMinutes : time(order.deadline),
      created: Number.isFinite(order.createdMinutes) ? order.createdMinutes : time(order.created),
      service: Number(order.service || 0) / 60,
      sum: Number(order.sum || 0)
    };
    (zoneIds.length ? orders : outside).push(normalized);
  });
  const couriers = settings.alwaysFreeCouriers
    ? orders.map((_, i) => ({ id: `TEST-C${i + 1}`, name: `Тестовый курьер ${i + 1}`, status: 'FREE',
      mode: 'DRIVING', maxOrders: settings.bucketMaxOrders, maxSum: settings.bucketMaxFullSum,
      zones: ZONES.map(zone => zone.id), freeSince: snapshot.planningAt?.hm || '00:00', synthetic: true }))
    : (snapshot.couriers || []).filter(courier => courier.status === 'FREE' && courier.zones.length)
    .sort((a, b) => time(a.freeSince) - time(b.freeSince) || a.id.localeCompare(b.id));
  const byId = Object.fromEntries(orders.map(order => [order.id, order]));
  const legCache = new Map();
  const leg = (from, to, mode) => {
    if (snapshot.roadMatrix) {
      const cell = snapshot.roadMatrix.cells[mode]?.[from]?.[to];
      return cell?.status === 'OK' && Number.isFinite(cell.minutes) ? cell.minutes : Infinity;
    }
    const key = `${from}>${to}`;
    if (legCache.has(key)) return legCache.get(key);
    const [x1, y1] = positions[from];
    const [x2, y2] = positions[to];
    const value = Math.max(0.5, Math.round(Math.hypot(x2 - x1, y2 - y1) / 20 * 2) / 2);
    legCache.set(key, value);
    return value;
  };
  return { orders, outside, couriers, byId, leg, positions, plan, settings, matrix:snapshot.roadMatrix, allowLate: settings.allowLate !== false };
}

const urgency = (a, b) => a.deadline - b.deadline || a.created - b.created || a.id.localeCompare(b.id);
const insertAt = (array, index, value) => [...array.slice(0, index), value, ...array.slice(index)];

function canServe(courier, order) {
  return order.zones.some(zoneId => {
    const zone = ZONES.find(item => item.id === zoneId);
    return courier.zones.includes(zoneId) && (!zone.modes || zone.modes.includes(courier.mode));
  });
}

export function evaluateRoute(courier, orderIds, input) {
  const orders = orderIds.map(id => input.byId[id]);
  const violations = [];
  if (new Set(orderIds).size !== orderIds.length) return { feasible: false, violations: ['DUPLICATE'] };
  if (orders.some(order => !canServe(courier, order))) violations.push('ZONE');
  if (orderIds.length > Math.min(courier.maxOrders, input.settings.bucketMaxOrders)) violations.push('MAX_ORDERS');
  const sum = orders.reduce((total, order) => total + order.sum, 0);
  if (sum > Math.min(courier.maxSum, input.settings.bucketMaxFullSum)) violations.push('MAX_FULL_SUM');
  if (violations.length) return { feasible: false, violations, sum };
  let previous = 'BR';
  let travel = 0;
  let unknown = false;
  const routeTimes = orders.map(order => {
    if (input.matrix?.cells[courier.mode]?.[previous]?.[order.id]?.status === 'UNKNOWN') unknown = true;
    travel += input.leg(previous, order.id, courier.mode);
    previous = order.id;
    return travel;
  });
  if (!Number.isFinite(travel)) return { feasible: false, violations: [unknown ? 'MATRIX_NOT_REQUESTED' : 'UNREACHABLE'], sum };
  const timing = bucketTiming(orders, routeTimes, sum, input.plan, input.settings);
  if (timing.isLate) violations.push('SLA');
  const back = orders.length ? input.leg(previous, 'BR', courier.mode) : 0;
  const returnLegMin = Number.isFinite(back) ? back : null;
  return { ...timing, feasible: violations.length === 0, violations, sum, travel,
    finish: timing.stops.at(-1)?.eta ?? timing.dep,
    returnLegMin, bufferedReturnMin: returnLegMin === null ? null : returnLegMin * (1 + input.settings.returnBufferPct / 100) };

}

function rejectionReason(verdict) {
  if (verdict.violations.includes('ZONE')) return 'зона не обслуживается';
  if (verdict.violations.includes('MAX_ORDERS')) return 'лимит max_orders';
  if (verdict.violations.includes('MAX_FULL_SUM')) return 'лимит max_full_sum';
  const stop = verdict.stops?.find(item => item.slack < 0);
  return stop ? `${stop.id} опоздает на ${Math.abs(stop.slack).toFixed(1)} мин` : verdict.violations.join(', ');
}

function appendAlgorithm(input, nearest) {
  const remaining = [...input.orders].sort(urgency);
  const routes = [];
  const trace = [['start', nearest ? 'Старт каждого маршрута — филиал' : `FIFO курьеров: ${input.couriers.map(c => c.name).join(' → ') || '—'}`]];
  for (const courier of input.couriers) {
    const ids = [];
    if (!nearest) {
      const seed = remaining.find(order => canServe(courier, order) && evaluateRoute(courier, [order.id], input).feasible);
      if (!seed) continue;
      ids.push(seed.id);
      remaining.splice(remaining.indexOf(seed), 1);
      trace.push(['seed', `Seed ${seed.id} для ${courier.name}`]);
    }
    while (remaining.length) {
      const previous = ids.at(-1) || 'BR';
      const candidates = remaining.filter(order => canServe(courier, order)).sort((a, b) => input.leg(previous, a.id, courier.mode) - input.leg(previous, b.id, courier.mode) || urgency(a, b));
      let accepted;
      for (const order of candidates) {
        const verdict = evaluateRoute(courier, [...ids, order.id], input);
        if (verdict.feasible) { accepted = order; trace.push(['accept', `${order.id} → ${courier.name}, ETA ${hm(verdict.stops.at(-1).eta)}`]); break; }
        trace.push(['reject', `${order.id} отклонён: ${rejectionReason(verdict)}`]);
      }
      if (!accepted) break;
      ids.push(accepted.id);
      remaining.splice(remaining.indexOf(accepted), 1);
    }
    if (ids.length) routes.push({ c: courier, ids });
  }
  return { routes, rem: remaining, tr: trace };
}

function allInsertions(order, routes, input) {
  const candidates = [];
  routes.forEach((route, routeIndex) => {
    if (!canServe(route.c, order)) return;
    const before = route.ids.length ? evaluateRoute(route.c, route.ids, input).travel : 0;
    for (let position = 0; position <= route.ids.length; position += 1) {
      const ids = insertAt(route.ids, position, order.id);
      const verdict = evaluateRoute(route.c, ids, input);
      if (verdict.feasible) candidates.push({ o: order, ri: routeIndex, p: position, ids, delta: verdict.travel - before });
    }
  });
  return candidates;
}

const compareInsertion = (a, b) => a.delta - b.delta || urgency(a.o, b.o) || a.ri - b.ri || a.p - b.p;

function insertionAlgorithm(input, regretMode) {
  const routes = input.couriers.map(courier => ({ c: courier, ids: [] }));
  const remaining = [...input.orders].sort(urgency);
  const trace = [['start', regretMode ? 'Regret-2: второй лучший − лучший' : 'Cheapest feasible insertion']];
  while (remaining.length) {
    let choice;
    if (!regretMode) {
      const candidates = remaining.flatMap(order => allInsertions(order, routes, input));
      candidates.sort(compareInsertion);
      choice = candidates[0];
    } else {
      const choices = remaining.map(order => {
        const candidates = allInsertions(order, routes, input).sort(compareInsertion);
        return candidates.length ? { order, best: candidates[0], regret: candidates[1] ? candidates[1].delta - candidates[0].delta : Infinity } : null;
      }).filter(Boolean);
      choices.sort((a, b) => b.regret - a.regret || urgency(a.order, b.order) || a.best.delta - b.best.delta);
      if (choices[0]) {
        trace.push(['regret', `Regret ${choices[0].order.id} = ${Number.isFinite(choices[0].regret) ? choices[0].regret.toFixed(1) : 'INF'}`]);
        choice = choices[0].best;
      }
    }
    if (!choice) break;
    routes[choice.ri].ids = choice.ids;
    remaining.splice(remaining.indexOf(choice.o), 1);
    trace.push(['accept', `${choice.o.id} → ${routes[choice.ri].c.name}, позиция ${choice.p}`]);
  }
  return { routes: routes.filter(route => route.ids.length), rem: remaining, tr: trace };
}

function exactAlgorithm(input) {
  const orders = [...input.orders].sort(urgency);
  const couriers = input.couriers;
  const trace = [['start', input.settings.alwaysFreeCouriers ? 'Лимиты: 8 заказов, свободные тестовые курьеры, 3000 мс, 2 000 000 состояний' : 'Лимиты: 8 заказов, 3 курьера, 3000 мс, 2 000 000 состояний']];
  if (orders.length > 8 || (!input.settings.alwaysFreeCouriers && couriers.length > 3)) return { skipped: `${orders.length} заказов × ${couriers.length} курьеров превышает лимит Exact`, tr: [...trace, ['limit', 'algorithm.limit_exceeded']] };
  const started = performance.now();
  let states = 0;
  let pruned = 0;
  let best = null;
  const routes = couriers.map(() => []);
  const score = () => {
    let assigned = 0; let used = 0; let travel = 0; let maxRoute = 0;
    routes.forEach((ids, index) => { if (!ids.length) return; const verdict = evaluateRoute(couriers[index], ids, input); assigned += ids.length; used += 1; travel += verdict.travel; maxRoute = Math.max(maxRoute, verdict.travel); });
    return { assigned, used, travel, maxRoute };
  };
  const better = scoreValue => !best || scoreValue.assigned > best.assigned || (scoreValue.assigned === best.assigned && (scoreValue.used < best.used || (scoreValue.used === best.used && (scoreValue.travel < best.travel || (scoreValue.travel === best.travel && scoreValue.maxRoute < best.maxRoute)))));
  const search = index => {
    states += 1;
    if ((states & 255) === 0 && (performance.now() - started > 3000 || states > 2_000_000)) throw new Error('LIMIT');
    if (index === orders.length) { const value = score(); if (better(value)) { best = { ...value, routes: routes.map(route => [...route]) }; trace.push(['best', `Новый лучший: ${value.assigned} вовремя, ${value.travel.toFixed(1)} мин`]); } return; }
    const assigned = routes.reduce((total, route) => total + route.length, 0);
    if (best && assigned + orders.length - index < best.assigned) { pruned += 1; return; }
    const order = orders[index];
    let triedEmpty = false;
    couriers.forEach((courier, courierIndex) => {
      if (input.settings.alwaysFreeCouriers && !routes[courierIndex].length) {
        if (triedEmpty) return;
        triedEmpty = true;
      }
      if (!canServe(courier, order)) return;
      const original = routes[courierIndex];
      for (let position = 0; position <= original.length; position += 1) {
        const ids = insertAt(original, position, order.id);
        if (!evaluateRoute(courier, ids, input).feasible) { pruned += 1; continue; }
        routes[courierIndex] = ids;
        search(index + 1);
        routes[courierIndex] = original;
      }
    });
    search(index + 1);
  };
  try { search(0); } catch { return { skipped: `превышен лимит: ${states} состояний`, tr: [...trace, ['limit', 'algorithm.limit_exceeded']] }; }
  trace.push(['prune', `Отсечено веток: ${pruned}`]);
  const resultRoutes = best ? best.routes.map((ids, index) => ({ c: couriers[index], ids })).filter(route => route.ids.length) : [];
  const usedOrders = new Set(resultRoutes.flatMap(route => route.ids));
  return { routes: resultRoutes, rem: orders.filter(order => !usedOrders.has(order.id)), tr: trace, states };
}

function finish(code, raw, input, computeMs) {
  if (raw.skipped) return { code, skipped: raw.skipped, routes: [], unassigned: [], trace: raw.tr, ms: computeMs };
  const routes = raw.routes.map(route => ({ ...route, late: false }));
  const remaining = [...raw.rem].sort(urgency);
  if (input.allowLate) {
    const usedCouriers = new Set(routes.map(route => route.c.id));
    for (const order of [...remaining]) {
      const courier = input.couriers.find(item => !usedCouriers.has(item.id) && canServe(item, order) && evaluateRoute(item, [order.id], input).violations.every(value => value === 'SLA'));
      if (!courier) continue;
      usedCouriers.add(courier.id);
      routes.push({ c: courier, ids: [order.id], late: true });
      remaining.splice(remaining.indexOf(order), 1);
      raw.tr.push(['late', `${order.id}: late solo у ${courier.name}`]);
    }
  }
  const unassigned = input.outside.map(order => ({ id: order.id, code: 'OUTSIDE_ZONE' }));
  remaining.forEach(order => {
    const compatible = input.couriers.filter(courier => canServe(courier, order));
    let reason = !input.couriers.length ? 'NO_COURIER' : !compatible.length ? 'NO_ZONE_COMPATIBLE_COURIER' : 'SLA';
    if (compatible.length) {
      const verdicts = compatible.flatMap(courier => {
        const base = routes.find(route => route.c.id === courier.id)?.ids || [];
        return Array.from({ length: base.length + 1 }, (_, position) => evaluateRoute(courier, insertAt(base, position, order.id), input));
      });
      if (verdicts.some(value => value.feasible)) reason = 'ALGORITHM_CHOICE';
      else if (verdicts.some(value => value.violations.includes('MATRIX_NOT_REQUESTED'))) reason = 'MATRIX_NOT_REQUESTED';
      else if (verdicts.every(value => value.violations.includes('UNREACHABLE'))) reason = 'UNREACHABLE';
      else if (verdicts.every(value => value.violations.includes('MAX_ORDERS'))) reason = 'MAX_ORDERS';
      else if (verdicts.every(value => value.violations.some(codeValue => codeValue === 'MAX_ORDERS' || codeValue === 'MAX_FULL_SUM'))) reason = 'MAX_FULL_SUM';
    }
    unassigned.push({ id: order.id, code: reason });
    raw.tr.push(['reject', `${order.id} не назначен: ${reason}`]);
  });
  const evaluated = routes.map(route => ({ ...route, ev: evaluateRoute(route.c, route.ids, input) }));
  const onTime = evaluated.filter(route => !route.late).reduce((total, route) => total + route.ids.length, 0);
  const travel = evaluated.reduce((total, route) => total + route.ev.travel, 0);
  const slacks = evaluated.filter(route => !route.late).map(route => route.ev.minSlack);
  raw.tr.push(['done', `Готово: ${onTime} вовремя, ${travel.toFixed(1)} мин дороги`]);
  return {
    code, routes: evaluated, unassigned, trace: raw.tr.slice(0, 10_000), ms: computeMs,
    onTime, late: evaluated.filter(route => route.late).length, travel,
    maxRoute: evaluated.reduce((maximum, route) => Math.max(maximum, route.ev.travel), 0),
    minSlack: slacks.length ? Math.min(...slacks) : null,
    buckets: evaluated.length
  };
}

export function runAlgorithms(snapshot) {
  const input = buildInput(snapshot);
  const factories = [
    () => appendAlgorithm(input, false),
    () => appendAlgorithm(input, true),
    () => insertionAlgorithm(input, false),
    () => insertionAlgorithm(input, true),
    () => exactAlgorithm(input)
  ];
  const results = factories.map((factory, index) => { const started = performance.now(); const raw = factory(); return finish(ALGORITHMS[index], raw, input, performance.now() - started); });
  return {
    results,
    pos: Object.fromEntries(snapshot.orders.map(order => [order.id, [order.x, order.y]])),
    matrix: (input.orders.length + 1) ** 2,
    eligible: input.orders.length + input.outside.length,
    couriers: input.couriers.length,
    planningAt: snapshot.planningAt || null,
    testCouriers: input.settings.alwaysFreeCouriers ? input.couriers : undefined,
    matrixProvider: snapshot.roadMatrix?.provider || 'LOCAL_DETERMINISTIC',
    matrixStats: snapshot.roadMatrix?.stats, timingModel: TIMING_MODEL, settings: input.settings
  };
}
