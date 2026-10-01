import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, runTestScenario, testSnapshot, hourlyRanges, ordersInRange } from '../src/historical-scenario.js';
import { runAlgorithms } from '../src/planning.js';
import { BRANCH_POINT } from '../src/branch.js';

const base = { orders: Array.from({length:4}, (_,i)=>({id:`O${i}`,status:'WAITING',sum:100000,
  created:'12:00',ready:'12:10',deadline:'12:40',service:0,x:BRANCH_POINT[0],y:BRANCH_POINT[1]})),
  couriers:[],planningAt:{minutes:730,hm:'12:10'},
  settings:{alwaysFreeCouriers:true,allowLate:false,bucketMaxOrders:1,bucketMaxFullSum:100000} };

test('unlimited test couriers remove shortage but retain branch caps, including Exact', () => {
  const result=runAlgorithms(base);
  assert.equal(result.couriers,4);
  result.results.forEach(algorithm=>{
    assert.equal(algorithm.skipped,undefined);
    assert.equal(algorithm.onTime,4);
    assert.equal(algorithm.buckets,4);
    algorithm.routes.forEach(route=>{
      assert.equal(route.ids.length,1); assert.equal(route.ev.sum,100000);
      assert.equal(route.c.status,'FREE'); assert.equal(route.c.synthetic,true);
    });
  });
  assert.equal(runAlgorithms({...base,settings:{...base.settings,alwaysFreeCouriers:false}}).couriers,0);
});

test('logged fixture contains unique planning-only orders', () => {
  const data=fixture();
  assert.equal(data.orders.length,79);
  assert.equal(new Set(data.orders.map(o=>o.id)).size,79);
  assert.equal(data.extraction.uniqueOrders,84);
  assert.equal(data.extraction.excluded.length,5);
  assert.equal(data.extraction.truncatedRows,288);
  const text=JSON.stringify(data);
  assert.ok(!text.includes('"phone":')); assert.ok(!text.includes('"customer":'));
});

test('snapshot cannot see future order events or future recorded readiness', () => {
  const data={settings:{},orders:[{id:'A',status:'COOKING_STARTED',sum:100000,
    createdAt:'2026-10-01T12:00:00+05:00',readyAt:'2026-10-01T12:12:00+05:00',deadlineAt:'2026-10-01T12:35:00+05:00',
    events:[{observedAt:'2026-10-01T12:01:00+05:00',status:'CookingStarted'},
      {observedAt:'2026-10-01T12:15:00+05:00',status:'Waiting',cookingCompletedAt:'2026-10-01T12:14:00+05:00'},
      {observedAt:'2026-10-01T12:20:00+05:00',status:'OnWay'}]}]};
  assert.equal(testSnapshot(data,'2026-10-01T12:00:00+05:00').orders.length,0);
  assert.equal(testSnapshot(data,'2026-10-01T12:05:00+05:00').orders[0].readyMinutes,732);
  assert.equal(testSnapshot(data,'2026-10-01T12:16:00+05:00').orders[0].readyMinutes,734);
  assert.equal(testSnapshot(data,'2026-10-01T12:21:00+05:00').orders.length,0);
});

test('delivery SLA is creation plus 35 minutes and ignores kitchen targets', () => {
  const data=fixture();
  for (const order of data.orders) {
    assert.equal(Date.parse(order.deadlineAt)-Date.parse(order.createdAt),35*60000);
  }
  const order=data.orders.find(o=>o.number===56);
  assert.equal(order.deadlineAt,'2026-10-01T13:47:58+05:00');
  const snapshot=testSnapshot({...data,orders:[{...order,deadlineAt:'2026-10-01T13:14:00+05:00',
    events:order.events.map(e=>({...e,deadlineAt:'2026-10-01T13:14:00+05:00',
      cookingCompleteBeforeAt:'2026-10-01T13:14:00+05:00'}))}]},'2026-10-01T13:35:00+05:00');
  assert.equal(snapshot.orders.length,1);
  assert.equal(snapshot.orders[0].deadline,'13:47');
  assert.equal(snapshot.orders[0].deadlineMinutes-snapshot.orders[0].createdMinutes,35);
});

test('snapshot cohort excludes expired deadlines from incomplete historical states', () => {
  const result=runTestScenario();
  assert.equal(result.planningAt.hm,'13:30');
  assert.equal(result.orders.length,20);
  result.orders.forEach(order=>assert.ok(order.deadlineMinutes>=result.planningAt.minutes));
  for (const algorithm of result.run.results.filter(r=>!r.skipped)) {
    const ids=algorithm.routes.flatMap(r=>r.ids);
    assert.equal(new Set(ids).size,ids.length);
    assert.equal(ids.length+algorithm.unassigned.length,result.orders.length);
    algorithm.routes.forEach(route=>{
      assert.ok(route.ev.sum<=result.settings.bucketMaxFullSum);
      assert.ok(route.ids.length<=result.settings.bucketMaxOrders);
      if (!route.late) {
        assert.ok(route.ev.dep<=route.ev.latestSafeDeparture);
        route.ev.stops.forEach(stop=>assert.ok(stop.eta<=stop.deadline));
      }
    });
  }
});


test('hourly ranges partition orders without including the upper boundary', () => {
  const data={orders:[{id:'A',createdAt:'2026-10-01T12:59:59+05:00'},
    {id:'B',createdAt:'2026-10-01T13:00:00+05:00'},
    {id:'C',createdAt:'2026-10-01T13:59:59+05:00'},
    {id:'D',createdAt:'2026-10-01T14:00:00+05:00'}]};
  const ranges=hourlyRanges(data);
  assert.deepEqual(ordersInRange(data,ranges.find(r=>r.id==='13:00-14:00')).map(o=>o.id),['B','C']);
  assert.equal(ranges.reduce((sum,r)=>sum+r.orders,0),4);
});

test('hour selection restricts cohort and snapshot times while keeping original times', () => {
  const data=fixture();
  const run=runTestScenario(undefined,{},'13:00-14:00');
  assert.equal(run.range.label,'13:00–14:00');
  assert.equal(run.range.orders,data.orders.filter(o=>o.createdAt.slice(11,13)==='13').length);
  run.orders.forEach(order=>{
    assert.equal(order.createdAt.slice(11,13),'13');
    assert.equal(order.createdAt,data.orders.find(o=>o.id===order.id).createdAt);
  });
  assert.ok(run.times.every(t=>t.at.slice(11,13)==='13'));
  assert.throws(()=>runTestScenario('2026-10-01T14:00:00+05:00',{},'13:00-14:00'),e=>e.status===422);
  assert.throws(()=>runTestScenario(undefined,{},'22:00-23:00'),e=>e.status===422);
});
