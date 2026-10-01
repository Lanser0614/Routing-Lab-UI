import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {observerConfig,decodeObservation,KafkaObserver} from '../src/kafka-observer.js';
import {Repository} from '../src/repository.js';
const config=observerConfig({});
const p={order_id:55,branch_id:config.organizationId,status:'CookingStarted',sum:100000,latitude:41.332,longitude:69.285,cooking_started_at:'2026-10-01T13:00:00+05:00',timestamp:'2026-10-01T13:01:00+05:00',complete_before:'2026-10-01T13:25:19+05:00'};
const wire=p=>Buffer.from(JSON.stringify({payload:p,timestamp:p.timestamp}));
test('WaitCooking event starts SLA; subsequent events and restart preserve it; late arrival does not regress status',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wait-cooking-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'live.sqlite');let repo=new Repository(filename,{observer:true});
  const record=offset=>({topic:'orders',partition:0,offset:String(offset)});
  const decode=payload=>decodeObservation('orders',wire(payload),config,id=>repo.kafkaOrder(id));
  let entity=decode({...p,status:'WaitCooking',cooking_started_at:null,timestamp:'2026-10-01T12:59:00+05:00'});
  assert.equal(entity.deadlineBasis,'wait_cooking_event');assert.equal(entity.observationIssue,null);
  assert.equal(entity.deadlineAt,'2026-10-01T08:34:00.000Z');
  repo.ingestKafka('orders',entity,record(1));repo.db.close();repo=new Repository(filename,{observer:true});
  entity=decode({...p,status:'CookingCompleted',cooking_completed_at:'2026-10-01T13:15:00+05:00',timestamp:'2026-10-01T13:15:00+05:00'});
  assert.equal(entity.deadlineAt,'2026-10-01T08:34:00.000Z');assert.equal(entity.readyAt,'2026-10-01T08:15:00.000Z');
  repo.ingestKafka('orders',entity,record(2));
  repo.ingestKafka('orders',decode({...p,status:'WaitCooking',timestamp:'2026-10-01T12:58:00+05:00'}),record(3));
  assert.equal(repo.kafkaOrder('55').status,'COOKING_COMPLETED');assert.equal(repo.kafkaOrder('55').deadlineAt,'2026-10-01T08:33:00.000Z');repo.db.close();
});
test('organization filter and strict deadline do not use kitchen complete_before',()=>{
  assert.equal(decodeObservation('orders',wire({...p,branch_id:'other'}),config),null);
  const missing=decodeObservation('orders',wire(p),config);
  assert.equal(missing.observationIssue,'CREATED_AT_MISSING');assert.equal(missing.deadlineAt,null);
  const valid=decodeObservation('orders',wire({...p,created_at:'2026-10-01T12:59:00+05:00'}),config);
  assert.equal(valid.deadlineAt,'2026-10-01T08:34:00.000Z');
  const approximate=decodeObservation('orders',wire(p),{...config,allowCookFallback:true});
  assert.equal(approximate.deadlineBasis,'cooking_started_at_approximation');
  assert.equal(approximate.deadlineAt,'2026-10-01T08:35:00.000Z');
});
test('courier contract maps actual availability and transport; invalid messages rejected',()=>{
  const courier=decodeObservation('couriers',wire({courier_id:7,branch_id:config.organizationId,status:'returning',vehicle_type:'SCOOTER',timestamp:p.timestamp}),config);
  assert.equal(courier.status,'RETURNING');assert.equal(courier.mode,'SCOOTER');
  assert.throws(()=>decodeObservation('orders',Buffer.from('{}'),config));
  assert.throws(()=>observerConfig({KAFKA_OBSERVER_ENABLED:'true',KAFKA_BROKERS:'broker',KAFKA_CONSUMER_GROUP:'bellissimo-io-planner'}));
});
test('observer SQLite isolates fixtures, persists offsets, rejects stale events and uses dated times',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'observer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'live.sqlite');
  let repo=new Repository(filename,{observer:true,clock:()=>new Date('2026-10-01T08:10:00Z')});
  assert.equal(repo.list('couriers').length,0);
  const entity=decodeObservation('orders',wire({...p,created_at:'2026-10-01T12:59:00+05:00'}),config);
  const record={topic:'orders',partition:0,offset:'100'};
  assert.equal(repo.ingestKafka('orders',entity,record),true);
  assert.equal(repo.ingestKafka('orders',entity,record),false);
  assert.equal(repo.ingestKafka('orders',{...entity,status:'CANCELLED',observedAt:'2026-09-30T00:00:00Z'},{...record,offset:'101'}),false);
  assert.equal(repo.snapshot().orders[0].deadlineMinutes,814);
  repo.db.close();repo=new Repository(filename,{observer:true});
  assert.equal(repo.list('orders').length,1);assert.equal(repo.ingestKafka('orders',entity,record),false);repo.db.close();
});

test('two separate consumers commit only after persistence; poison is skipped, storage failure retries',async()=>{
  const consumers=[],sequence=[];
  const kafka={consumer:options=>{
    const c={options,events:{CRASH:'crash',GROUP_JOIN:'join'},on(){},async connect(){},async subscribe(o){this.subscription=o;},async run(o){this.handler=o.eachMessage;assert.equal(o.autoCommit,false);},async commitOffsets(o){sequence.push(['commit',o[0].offset]);},async disconnect(){this.disconnected=true;}};
    consumers.push(c);return c;
  }};
  let fail=false;
  const repo={list:()=>[],ingestKafka(kind,entity){sequence.push(['persist',kind]);if(fail)throw new Error('disk full');return !!entity;}};
  const observer=new KafkaObserver(repo,config,()=>{},kafka);
  await observer.start();
  assert.equal(consumers.length,2);
  assert.notEqual(consumers[0].options.groupId,consumers[1].options.groupId);
  assert.equal(consumers[0].subscription.topic,'delivery-io.order-status');
  assert.equal(consumers[1].subscription.topic,'courier-io.status');
  await consumers[0].handler({topic:'orders',partition:0,message:{offset:'9007199254740993',value:wire(p)}});
  assert.deepEqual(sequence,[['persist','orders'],['commit','9007199254740994']]);
  await consumers[0].handler({topic:'orders',partition:0,message:{offset:'2',value:Buffer.from('broken')}});
  assert.equal(observer.status().streams.orders.invalid,1);
  fail=true;sequence.length=0;
  await assert.rejects(()=>consumers[0].handler({topic:'orders',partition:0,message:{offset:'3',value:wire(p)}}));
  assert.deepEqual(sequence,[['persist','orders']]);
  await observer.stop();assert.ok(consumers.every(c=>c.disconnected));
});
