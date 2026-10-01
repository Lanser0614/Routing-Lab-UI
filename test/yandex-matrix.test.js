import test from 'node:test';
import assert from 'node:assert/strict';
import { YandexMatrixClient, packMissing } from '../src/yandex-matrix.js';
import { runAlgorithms } from '../src/planning.js';
import { BRANCH_POINT } from '../src/branch.js';
import { validateSettings } from '../src/settings.js';

const economical=(count=12)=>({planningAt:{minutes:780,hm:'13:00'},
  settings:{alwaysFreeCouriers:true,allowLate:false,matrixMode:'economy',matrixNeighbors:2},couriers:[],
  orders:Array.from({length:count},(_,i)=>({id:`O${i}`,status:'WAITING',sum:100,
    created:'12:45',ready:'13:00',deadline:'17:00',x:BRANCH_POINT[0]+i,y:BRANCH_POINT[1],
    latitude:41.332218+(i+1)*.0001,longitude:69.284734+(i+1)*.0001}))});

test('economy requests neighbors and branch legs, retains UNKNOWN and validates without duplicate billing',async()=>{
  const client=new YandexMatrixClient({apiKey:'test',fetchImpl:async url=>response(url)});
  const snapshot=economical();
  const matrix=await client.forSnapshot(snapshot);
  assert.equal(matrix.stats.calculationMode,'economy');assert.equal(matrix.stats.validated,true);
  assert.ok(matrix.stats.requestedElements<=12*4);
  assert.equal(matrix.cells.DRIVING.O0.O11.status,'UNKNOWN');
  const result=runAlgorithms({...snapshot,roadMatrix:matrix});
  result.results.filter(r=>!r.skipped).forEach(r=>{
    assert.equal(r.onTime,12);
    r.routes.forEach(route=>route.ev.stops.forEach(stop=>assert.ok(stop.slack>=0)));
  });
  assert.equal((await client.forSnapshot(snapshot)).stats.requestedElements,0);
});

test('economy expands unresolved orders and distinguishes FAIL from UNKNOWN',async()=>{
  const client=new YandexMatrixClient({apiKey:'test',fetchImpl:async url=>response(url,()=>({status:'FAIL'}))});
  const snapshot=economical(6);
  const matrix=await client.forSnapshot(snapshot);
  assert.ok(matrix.stats.expansionRounds>0);
  assert.equal(matrix.cells.DRIVING.O0.O5.status,'FAIL');
  runAlgorithms({...snapshot,roadMatrix:matrix}).results.forEach(r=>assert.equal(r.unassigned.length,6));
});

test('fresh validation refreshes old selected legs and recalculates SLA',async()=>{
  let now=0;let duration=60;
  const client=new YandexMatrixClient({apiKey:'test',clock:()=>now,fetchImpl:async url=>response(url,
    cell=>({...cell,duration:{value:duration}}))});
  const snapshot=economical(1);snapshot.settings.matrixMode='full';snapshot.orders[0].deadline='13:20';
  await client.forSnapshot(snapshot);
  now=20000;duration=1800;snapshot.settings.matrixMode='economy';
  const matrix=await client.forSnapshot(snapshot);
  assert.ok(matrix.stats.requestedElements>0);
  assert.ok(matrix.stats.validationRounds>=2);
  runAlgorithms({...snapshot,roadMatrix:matrix}).results.forEach(r=>assert.equal(r.onTime,0));
});

test('matrix settings reject invalid modes and neighbor limits',()=>{
  validateSettings({matrixMode:'economy',matrixNeighbors:5});
  for(const value of [0,21,1.5,null]) assert.throws(()=>validateSettings({matrixNeighbors:value}));
  assert.throws(()=>validateSettings({matrixMode:'bad'}));
});

const point=(id,n)=>({id,latitude:41+n/1000,longitude:69+n/1000});
const response=(url,transform=x=>x)=>{
  const origins=url.searchParams.get('origins').split('|');
  const destinations=url.searchParams.get('destinations').split('|');
  return {ok:true,json:async()=>({rows:origins.map(o=>({elements:destinations.map(d=>transform({
    status:'OK',duration:{value:o<d?120:240},distance:{value:500}}))}))})};
};

test('bulk packs directed missing cells exactly once within 100-element limit',()=>{
  const ids=Array.from({length:24},(_,i)=>String(i));
  const rows=new Map(ids.map(o=>[o,ids.filter(d=>d!==o)]));
  const batches=packMissing(rows);
  const seen=new Set();
  for(const b of batches){
    assert.ok(b.origins.length*b.destinations.length<=100);
    for(const o of b.origins)for(const d of b.destinations){
      assert.notEqual(o,d); assert.ok(!seen.has(`${o}>${d}`)); seen.add(`${o}>${d}`);
    }
  }
  assert.equal(seen.size,24*23);
  assert.ok(batches.length<=24);
});

test('client deduplicates points, converts seconds, preserves directions and mode, shares cache',async()=>{
  let now=0; const calls=[];
  const client=new YandexMatrixClient({apiKey:'test-secret',clock:()=>now,ttlMs:100,
    fetchImpl:async url=>{calls.push(url);return response(url);}});
  const points=[point('BR',0),point('A',1),point('B',1),point('C',2)];
  const [first,second]=await Promise.all([client.matrix(points,['SCOOTER']),client.matrix(points,['SCOOTER'])]);
  assert.equal(first.stats.uniquePoints,3);
  assert.equal(first.stats.requestedElements,6);
  assert.equal(second.stats.requests,0);
  assert.equal(first.cells.SCOOTER.A.B.minutes,0);
  assert.equal(first.cells.SCOOTER.BR.A.minutes,2);
  assert.equal(first.cells.SCOOTER.A.BR.minutes,4);
  assert.ok(calls.every(u=>u.hostname==='api.routing.yandex.net' && u.searchParams.get('mode')==='driving'
    && !u.searchParams.has('traffic')));
  assert.ok(!JSON.stringify(first).includes('test-secret'));
  const driving=await client.matrix(points,['DRIVING']);
  assert.equal(driving.stats.requestedElements,0);
  assert.deepEqual(driving.cells.DRIVING,first.cells.SCOOTER);
  now=101;
  assert.equal((await client.matrix(points,['SCOOTER'])).stats.requestedElements,6);
});

test('FAIL stays unreachable; HTTP errors are sanitized; transient failures retry',async()=>{
  const points=[point('BR',0),point('A',1)];
  const failed=new YandexMatrixClient({apiKey:'secret',fetchImpl:async url=>response(url,()=>({status:'FAIL'}))});
  assert.equal((await failed.matrix(points,['DRIVING'])).cells.DRIVING.BR.A.minutes,null);
  let tries=0;
  const client=new YandexMatrixClient({apiKey:'secret',sleep:async()=>{},fetchImpl:async url=>{
    tries++;return tries===1?{ok:false,status:429}:response(url);
  }});
  const result=await client.matrix(points,['DRIVING']);
  assert.equal(result.stats.requests,tries);
  const denied=new YandexMatrixClient({apiKey:'secret',fetchImpl:async()=>({ok:false,status:401})});
  await assert.rejects(denied.matrix(points,['DRIVING']),e=>e.code==='MATRIX_HTTP_ERROR' && !e.message.includes('secret'));
  const broken=new YandexMatrixClient({apiKey:'secret',retries:0,fetchImpl:async()=>{throw Error('URL secret');}});
  await assert.rejects(broken.matrix(points,['DRIVING']),e=>!e.message.includes('secret'));
  const malformed=new YandexMatrixClient({apiKey:'secret',fetchImpl:async()=>({ok:true,json:async()=>({rows:[]})})});
  await assert.rejects(malformed.matrix(points,['DRIVING']),e=>e.code==='MATRIX_RESPONSE_INVALID');
});

test('motor scooters apply 40 km/h floor without changing driving cache or reducing traffic time',async()=>{
  let calls=0;
  const client=new YandexMatrixClient({apiKey:'test',fetchImpl:async url=>{
    calls++;return response(url,cell=>({...cell,distance:{value:4000},
      duration:{value:cell.duration.value===120?240:600}}));
  }});
  const points=[point('BR',0),point('A',1)];
  const matrix=await client.matrix(points,['SCOOTER','DRIVING']);
  assert.equal(matrix.cells.SCOOTER.BR.A.minutes,6);
  assert.equal(matrix.cells.DRIVING.BR.A.minutes,4);
  assert.equal(matrix.cells.SCOOTER.A.BR.minutes,10);
  assert.equal(matrix.cells.DRIVING.A.BR.minutes,10);
  assert.equal(matrix.stats.requestedElements,2);
  const before=calls;
  const cached=await client.matrix(points,['SCOOTER','DRIVING']);
  assert.equal(calls,before);
  assert.equal(cached.cells.SCOOTER.BR.A.minutes,6);
  assert.equal(cached.cells.DRIVING.BR.A.minutes,4);
});

test('all algorithms use supplied road durations and reject unreachable legs',()=>{
  const snapshot={planningAt:{minutes:780,hm:'13:00'},settings:{alwaysFreeCouriers:true},
    orders:[{id:'A',status:'WAITING',created:'12:45',ready:'13:00',deadline:'13:35',sum:100,
      x:BRANCH_POINT[0],y:BRANCH_POINT[1]}],couriers:[],
    roadMatrix:{provider:'YANDEX_DISTANCE_MATRIX',cells:{DRIVING:{BR:{A:{status:'OK',minutes:7}},
      A:{BR:{status:'OK',minutes:11}}}}}};
  const result=runAlgorithms(snapshot);
  result.results.forEach(r=>{
    assert.equal(r.routes[0].ev.travel,7);assert.equal(r.routes[0].ev.returnLegMin,11);
  });
  snapshot.roadMatrix.cells.DRIVING.BR.A={status:'FAIL',minutes:null};
  runAlgorithms(snapshot).results.forEach(r=>{
    assert.equal(r.routes.length,0);assert.equal(r.unassigned[0].code,'UNREACHABLE');
  });
});
