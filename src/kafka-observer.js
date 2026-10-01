import fs from 'node:fs';
import { createRequire } from 'node:module';
import { BRANCH, projectCoordinate } from './branch.js';
import { tashkentNow } from './time.js';

export function observerConfig(env=process.env) {
  const enabled=env.KAFKA_OBSERVER_ENABLED==='true';
  const brokers=(env.KAFKA_BROKERS||'').split(',').map(s=>s.trim()).filter(Boolean);
  const group=env.KAFKA_CONSUMER_GROUP||'routing-lab-observer';
  if(enabled && (!brokers.length || group.includes('bellissimo-io-planner'))) throw new Error('Observer requires brokers and a separate consumer group');
  if(enabled && env.KAFKA_USERNAME && !env.KAFKA_PASSWORD) throw new Error('KAFKA_PASSWORD is required');
  const mechanism=(env.KAFKA_SASL_MECHANISM||'SCRAM-SHA-512').toLowerCase();
  if(!['plain','scram-sha-256','scram-sha-512'].includes(mechanism)) throw new Error('Unsupported Kafka SASL mechanism');
  const maxOrders=Number(env.OBSERVER_COURIER_MAX_ORDERS||3),maxSum=Number(env.OBSERVER_COURIER_MAX_SUM||300000);
  if(!Number.isInteger(maxOrders)||maxOrders<1||!Number.isFinite(maxSum)||maxSum<=0) throw new Error('Invalid observer courier limits');
  return {enabled,brokers,group,organizationId:BRANCH.iikoId,
    topics:{orders:env.KAFKA_ORDERS_TOPIC||'delivery-io.order-status',couriers:env.KAFKA_COURIERS_TOPIC||'courier-io.status'},
    fromBeginning:env.KAFKA_FROM_BEGINNING==='true',allowCookFallback:env.KAFKA_ALLOW_COOKING_START_DEADLINE==='true',
    maxOrders,maxSum,
    ssl:env.KAFKA_USERNAME || env.KAFKA_SSL==='true' ? (env.KAFKA_CA_LOCATION ? {ca:[fs.readFileSync(env.KAFKA_CA_LOCATION,'utf8')]} : true) : false,
    sasl:env.KAFKA_USERNAME ? {mechanism,username:env.KAFKA_USERNAME,password:env.KAFKA_PASSWORD} : undefined};
}

const orderStatuses={WaitCooking:'COOKING_STARTED',CookingStarted:'COOKING_STARTED',CookingCompleted:'COOKING_COMPLETED',Waiting:'WAITING',OnWay:'ON_WAY',OnWayNow:'ON_WAY',Delivered:'DELIVERED',Closed:'DELIVERED',Cancelled:'CANCELLED',Canceled:'CANCELLED',Delayed:'ON_WAY'};
const courierStatuses={free:'FREE',reserved:'RESERVED',onWay:'DELIVERING',arrived:'DELIVERING',returning:'RETURNING',notWorking:'OFFLINE'};
const modes={CAR:'DRIVING',SCOOTER:'SCOOTER',BICYCLE:'BICYCLING',PEDESTRIAN:'WALKING'};
function date(value) {const n=Date.parse(value);return Number.isFinite(n)?new Date(n).toISOString():null;}

export function decodeObservation(kind,value,config,lookup=()=>null) {
  const raw=JSON.parse(value.toString());
  const p=raw.payload;
  if(!p || typeof p!=='object') throw new Error('Missing payload');
  if((p.branch_id??p.organizationId)!==config.organizationId) return null;
  const observedAt=date(p.timestamp||raw.timestamp);
  if(!observedAt) throw new Error('Missing event timestamp');
  if(kind==='couriers') {
    if(p.courier_id==null || !courierStatuses[p.status] || !modes[p.vehicle_type]) throw new Error('Invalid courier fields');
    return {id:String(p.courier_id),name:`Курьер ${p.courier_id}`,status:courierStatuses[p.status],mode:modes[p.vehicle_type],role:p.role,
      maxOrders:config.maxOrders,maxSum:config.maxSum,zones:['Z1'],freeSince:p.free_since?tashkentNow(new Date(p.free_since)).hm:null,observedAt,source:'kafka'};
  }
  if(p.order_id==null) throw new Error('Missing order_id');
  const previous=lookup(String(p.order_id))||{};
  const status=orderStatuses[p.status]||'DRAFT';
  const waitCookingAt=[previous.waitCookingAt,p.status==='WaitCooking'?observedAt:null].filter(Boolean).sort()[0]||null;
  const actualCreated=date(p.created_at||p.whenCreated)||previous.actualCreatedAt;
  const cookingStarted=date(p.cooking_started_at)||previous.cookingStartedAt;
  const createdAt=waitCookingAt || actualCreated || (config.allowCookFallback?cookingStarted:null);
  const readyAt=date(p.cooking_completed_at) || previous.cookingCompletedAt || ((cookingStarted||waitCookingAt)?new Date(Date.parse(cookingStarted||waitCookingAt)+12*60000).toISOString():null);
  const deadlineAt=createdAt?new Date(Date.parse(createdAt)+35*60000).toISOString():null;
  const latitude=p.latitude,longitude=p.longitude;
  const coordinates=typeof latitude==='number' && typeof longitude==='number' && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude)<=90 && Math.abs(longitude)<=180;
  const issue=!coordinates?'NO_DELIVERY_COORDINATES':!createdAt?'CREATED_AT_MISSING':!readyAt?'COOKING_TIME_MISSING':!orderStatuses[p.status]?'UNKNOWN_STATUS':!(Number(p.sum)>0)?'INVALID_SUM':null;
  return {id:String(p.order_id),number:p.number,address:`Заказ ${p.number??p.order_id}`,status,sum:Number(p.sum)||0,
    ...(coordinates?projectCoordinate(longitude,latitude):{x:0,y:0}),latitude,longitude,
    waitCookingAt,actualCreatedAt:actualCreated||null,cookingStartedAt:cookingStarted||null,cookingCompletedAt:date(p.cooking_completed_at)||previous.cookingCompletedAt||null,
    createdAt,readyAt,deadlineAt,created:createdAt?tashkentNow(new Date(createdAt)).hm:'00:00',ready:readyAt?tashkentNow(new Date(readyAt)).hm:'00:00',deadline:deadlineAt?tashkentNow(new Date(deadlineAt)).hm:'00:00',
    service:60,mustBeScanned:!!p.must_be_scanned,observationIssue:issue||(p.must_be_scanned?'SCAN_REQUIRED':null),deadlineBasis:waitCookingAt?'wait_cooking_event':actualCreated?'created_at':createdAt?'cooking_started_at_approximation':'missing',observedAt,source:'kafka'};
}

export class KafkaObserver {
  constructor(repository,config,onChange=()=>{},kafka=null) {this.repository=repository;this.config=config;this.onChange=onChange;this.kafka=kafka;this.consumers=[];this.state={mode:'observer',organizationId:config.organizationId,streams:{},excludedOrders:0};}
  status() {
    const orders=this.repository.list('orders'),issues={};
    for(const o of orders) if(o.observationIssue) issues[o.observationIssue]=(issues[o.observationIssue]||0)+1;
    return {...this.state,excludedOrders:orders.filter(o=>o.observationIssue).length,issues,approximateDeadlines:orders.filter(o=>o.deadlineBasis==='cooking_started_at_approximation').length};
  }
  async start() {
    const require=createRequire(import.meta.url);
    const {Kafka,CompressionTypes,CompressionCodecs,logLevel}=require('kafkajs');
    CompressionCodecs[CompressionTypes.Snappy]=require('kafkajs-snappy');
    const kafka=this.kafka||new Kafka({clientId:'routing-lab-observer',brokers:this.config.brokers,ssl:this.config.ssl,sasl:this.config.sasl,logLevel:logLevel.NOTHING});
    try {
      for(const kind of ['orders','couriers']) {
        const topic=this.config.topics[kind];
        const state=this.state.streams[kind]={topic,groupId:`${this.config.group}-${kind}`,connected:false,received:0,accepted:0,skipped:0,invalid:0};
        const consumer=kafka.consumer({groupId:state.groupId,allowAutoTopicCreation:false});
        this.consumers.push(consumer);
        consumer.on(consumer.events.CRASH,()=>{state.connected=false;state.error='CONSUMER_CRASH';});
        consumer.on(consumer.events.GROUP_JOIN,()=>{state.connected=true;delete state.error;});
        await consumer.connect();
        await consumer.subscribe({topic,fromBeginning:this.config.fromBeginning});
        await consumer.run({autoCommit:false,eachMessage:async ({topic,partition,message})=>{
          state.received++;
          let entity=null;
          try {entity=decodeObservation(kind,message.value,this.config,id=>this.repository.kafkaOrder?.(id));} catch {state.invalid++;state.lastInvalid={partition,offset:message.offset};}
          // Database failures escape: never commit data that was not persisted.
          const changed=this.repository.ingestKafka(kind,entity,{topic,partition,offset:message.offset});
          if(changed) {state.accepted++;this.onChange();} else state.skipped++;
          state.lastEventAt=entity?.observedAt||state.lastEventAt;
          await consumer.commitOffsets([{topic,partition,offset:(BigInt(message.offset)+1n).toString()}]);
        }});
      }
    } catch(error) {await this.stop();throw error;}
  }
  async stop() {await Promise.allSettled(this.consumers.map(c=>c.disconnect()));for(const s of Object.values(this.state.streams)) s.connected=false;}
}
