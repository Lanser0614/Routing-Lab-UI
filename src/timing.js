// IO Planner timing.py, formulas (10)–(12). All values are minutes.
export const TIMING_MODEL = 'IO_PLANNER_V1';
export const DEFAULT_SETTINGS = Object.freeze({
  allowLate: true, alwaysFreeCouriers: false, goOutFromBranchMin: 2, giveOrderToClientMin: 2,
  bucketMaxFullSum: 1000000, bucketMaxOrders: 8, returnBufferPct: 20,
  matrixMode: 'full', matrixNeighbors: 5, matrixProvider: 'local', planningAt: '',
  planningDate: '', planningHourFrom: 0, planningHourTo: 24
});
export const STANDARD_COOK_MIN = 12;

export function bucketTiming(orders, routeTimes, totalSum, plan, settings) {
  const multi = orders.length > 1;
  const safeTimes = orders.map((order, i) => order.deadline - routeTimes[i]
    - (multi ? settings.giveOrderToClientMin * i : 0) - settings.goOutFromBranchMin);
  const latestSafeDeparture = Math.min(...safeTimes);
  const closingTime = totalSum >= settings.bucketMaxFullSum
    ? Math.min(plan, latestSafeDeparture)
    : Math.max(latestSafeDeparture - STANDARD_COOK_MIN, plan);
  const dep = Math.max(...orders.map(order => order.ready), closingTime);
  const stops = orders.map((order, i) => {
    const eta = dep + settings.goOutFromBranchMin + routeTimes[i]
      + (multi ? settings.giveOrderToClientMin * i : 0);
    return { id: order.id, eta, deadline: order.deadline, slack: order.deadline - eta };
  });
  return { dep, closingTime, latestSafeDeparture, stops,
    status: closingTime <= plan ? 'closed' : 'pairing',
    isLate: dep > latestSafeDeparture,
    minSlack: Math.min(...stops.map(stop => stop.slack)) };
}
