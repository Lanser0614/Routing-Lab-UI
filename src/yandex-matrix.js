import { problem, ELIGIBLE_ORDER_STATUSES } from './domain.js';
import { BRANCH, unprojectCoordinate } from './branch.js';
import { zonesOf, runAlgorithms } from './planning.js';

// SCOOTER means a motor scooter/moped in this fleet, not an electric kick scooter.
const MODES = { DRIVING: 'driving', SCOOTER: 'driving', BICYCLING: 'bicycle', WALKING: 'walking' };
const endpoint = 'https://api.routing.yandex.net/v2/distancematrix';
export const SCOOTER_MAX_SPEED_KMH = 40;
const forCourier = (cell, mode) => mode === 'SCOOTER' && cell.status === 'OK'
  ? { ...cell, minutes: Math.max(cell.minutes, cell.meters / 1000 / SCOOTER_MAX_SPEED_KMH * 60) }
  : cell;
const fail = (code, detail) => problem(502, code, detail);

// Dense rectangles containing only missing directed cells: <=100 cells per GET.
// Greedy packing minimizes waste, not a proof of globally minimal HTTP count.
export function packMissing(rows, limit = 100) {
  const baseline=[];
  const groups=new Map();
  for(const [origin,ds] of rows) {
    const destinations=[...new Set(ds)];
    for(let start=0;start<destinations.length;start+=limit) {
      const chunk=destinations.slice(start,start+limit);
      const key=JSON.stringify(chunk);
      if(!groups.has(key)) groups.set(key,{origins:[],destinations:chunk});
      groups.get(key).origins.push(origin);
    }
  }
  for(const group of groups.values()) {
    const height=Math.floor(limit/group.destinations.length);
    for(let start=0;start<group.origins.length;start+=height) {
      baseline.push({origins:group.origins.slice(start,start+height),destinations:group.destinations});
    }
  }
  const remaining = new Map([...rows].map(([origin, destinations]) => [origin, new Set(destinations)]));
  const batches = [];
  while ([...remaining.values()].some(set => set.size)) {
    const seed = [...remaining].sort((a,b) => b[1].size-a[1].size)[0];
    const destinations = [...seed[1]];
    let best = null;
    for (let width=1; width<=Math.min(limit,destinations.length); width++) {
      const ds = destinations.slice(0,width);
      const os = [...remaining].filter(([,set]) => ds.every(d=>set.has(d)))
        .slice(0,Math.floor(limit/width)).map(([o])=>o);
      const area = os.length*width;
      if (!best || area>best.area) best={origins:os,destinations:ds,area};
    }
    batches.push(best);
    best.origins.forEach(o=>best.destinations.forEach(d=>remaining.get(o).delete(d)));
  }
  return batches.length<baseline.length ? batches : baseline;
}

export class YandexMatrixClient {
  constructor({ apiKey, fetchImpl=fetch, clock=Date.now, ttlMs, concurrency=3,
    timeoutMs=15000, retries=2, traffic='enabled', sleep=ms=>new Promise(r=>setTimeout(r,ms)) }={}) {
    if (!apiKey) throw problem(503,'MATRIX_KEY_MISSING','Не задан YANDEX_ROUTING_API_KEY');
    if (!['disabled','enabled'].includes(traffic)) throw new Error('Invalid Yandex traffic mode');
    this.apiKey=apiKey; this.fetch=fetchImpl; this.clock=clock; this.ttlMs=ttlMs ?? (traffic==='enabled'?60000:300000);
    this.concurrency=concurrency; this.timeoutMs=timeoutMs; this.retries=retries;
    this.traffic=traffic; this.sleep=sleep; this.cache=new Map(); this.queue=Promise.resolve();
  }

  // Serialize preparations to let simultaneous runs reuse the first run's cache.
  matrix(points,modes,options={}) {
    const job=this.queue.then(()=>this.build(points,modes,options));
    this.queue=job.catch(()=>{});
    return job;
  }

  async request(origins,destinations,mode,stats) {
    const url=new URL(endpoint);
    url.search=new URLSearchParams({origins:origins.join('|'),destinations:destinations.join('|'),
      apikey:this.apiKey,mode,...(mode==='driving' && this.traffic==='disabled'?{traffic:'disabled'}:{})}).toString();
    for (let attempt=0; attempt<=this.retries; attempt++) {
      let response;
      stats.requests++; stats.requestedElements+=origins.length*destinations.length;
      try { response=await this.fetch(url,{signal:AbortSignal.timeout(this.timeoutMs),redirect:'error'}); }
      catch {
        if (attempt<this.retries) { await this.sleep(250*2**attempt); continue; }
        // Never expose fetch errors: they can contain the URL with the API key.
        throw fail('MATRIX_NETWORK_ERROR','Не удалось получить матрицу Яндекса: сеть или timeout');
      }
      if (!response.ok) {
        if ((response.status===429 || response.status>=500) && attempt<this.retries) {
          const retryAfter=Number(response.headers?.get('retry-after'));
          await this.sleep(Math.min(5000,Math.max(250*2**attempt,Number.isFinite(retryAfter)?retryAfter*1000:0)));
          continue;
        }
        throw fail('MATRIX_HTTP_ERROR',`Яндекс Matrix вернул HTTP ${response.status}`);
      }
      let body;
      try { body=await response.json(); } catch { throw fail('MATRIX_RESPONSE_INVALID','Некорректный JSON матрицы Яндекса'); }
      if (body.rows?.length!==origins.length || body.rows.some(row=>row.elements?.length!==destinations.length)) {
        throw fail('MATRIX_RESPONSE_INVALID','Размер ответа Яндекса не соответствует запросу');
      }
      return body.rows.map(row=>row.elements.map(element=>{
        if (element.status==='FAIL') return {minutes:null,meters:null,status:'FAIL'};
        if (element.status!=='OK' || !Number.isFinite(element.duration?.value) || element.duration.value<0
          || !Number.isFinite(element.distance?.value) || element.distance.value<0) {
          throw fail('MATRIX_RESPONSE_INVALID','Некорректная ячейка матрицы Яндекса');
        }
        return {minutes:element.duration.value/60,meters:element.distance.value,status:'OK'};
      }));
    }
  }

  async build(points,modes,{pairs,refreshPairs}={}) {
    const now=this.clock();
    for(const [key,value] of this.cache) if(value.expires<=now) this.cache.delete(key);
    const unique=new Map();
    const ids=new Map();
    for(const point of points) {
      if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
        || Math.abs(point.latitude)>90 || Math.abs(point.longitude)>180) {
        throw problem(422,'MATRIX_COORDINATES_INVALID','Некорректные координаты заказа');
      }
      const key=`${point.latitude},${point.longitude}`;
      unique.set(key,point); ids.set(point.id,key);
    }
    const keys=[...unique.keys()];
    const convert = list => new Set((list || []).map(([o,d])=>`${ids.get(o)}>${ids.get(d)}`));
    const requested = pairs ? convert(pairs) : null;
    const refresh = convert(refreshPairs);
    const stats={requests:0,requestedElements:0,cacheHits:0,uniquePoints:keys.length,
      modes:[...new Set(modes)],traffic:this.traffic,ttlSeconds:this.ttlMs/1000,
      scooterMaxSpeedKmh:SCOOTER_MAX_SPEED_KMH};
    const cells={};
    for(const courierMode of stats.modes) {
      const mode=MODES[courierMode];
      if(!mode) throw problem(422,'MATRIX_MODE_INVALID','Неизвестный транспорт для матрицы');
      const cacheKey=(o,d)=>`${mode}:${this.traffic}:${o}>${d}`;
      const missing=new Map();
      const values=new Map();
      for(const o of keys) {
        const ds=[];
        for(const d of keys) {
          const pair=`${o}>${d}`;
          if(o===d) values.set(pair,{minutes:0,meters:0,status:'OK'});
          else if(requested && !requested.has(pair)) values.set(pair,{minutes:null,meters:null,status:'UNKNOWN'});
          else {
            const cached=this.cache.get(cacheKey(o,d));
            if(cached && cached.expires>this.clock() && (!refresh.has(pair) || this.clock()-cached.computedAt<=10000)) { values.set(pair,cached.cell); stats.cacheHits++; }
            else ds.push(d);
          }
        }
        missing.set(o,ds);
      }
      const batches=packMissing(missing);
      let index=0;
      const settled=await Promise.allSettled(Array.from({length:Math.min(this.concurrency,batches.length)},async()=>{
        while(index<batches.length) {
          const batch=batches[index++];
          const rows=await this.request(batch.origins,batch.destinations,mode,stats);
          batch.origins.forEach((o,i)=>batch.destinations.forEach((d,j)=>{
            const cell=rows[i][j]; values.set(`${o}>${d}`,cell);
            this.cache.set(cacheKey(o,d),{cell,computedAt:this.clock(),expires:this.clock()+this.ttlMs});
          }));
        }
      }));
      const error=settled.find(r=>r.status==='rejected');
      if(error) throw error.reason;
      cells[courierMode]=Object.fromEntries([...ids].map(([id,o])=>[id,
        Object.fromEntries([...ids].map(([other,d])=>[other,forCourier(values.get(`${o}>${d}`),courierMode)]))]));
    }
    return {provider:'YANDEX_DISTANCE_MATRIX',cells,stats};
  }

  async forSnapshot(snapshot) {
    const orders=snapshot.orders.filter(o=>ELIGIBLE_ORDER_STATUSES.includes(o.status) && zonesOf(o.x,o.y).length);
    const modes=snapshot.settings?.alwaysFreeCouriers ? (orders.length?['DRIVING']:[])
      : [...new Set(snapshot.couriers.filter(c=>c.status==='FREE' && c.zones.length).map(c=>c.mode))];
    const points=[{id:'BR',latitude:BRANCH.latitude,longitude:BRANCH.longitude},
      ...orders.map(o=>({id:o.id,...(Number.isFinite(o.latitude) && Number.isFinite(o.longitude)
        ? {latitude:o.latitude,longitude:o.longitude}:unprojectCoordinate(o.x,o.y))}))];
    if(snapshot.settings?.matrixMode!=='economy') {
      const matrix=await this.matrix(points,modes);
      matrix.stats.calculationMode='full';matrix.stats.fullComparison=true;
      return matrix;
    }
    const pairs=new Map();
    const add=(o,d)=>{if(o!==d)pairs.set(`${o}>${d}`,[o,d]);};
    const drops=points.slice(1);
    const rankings=new Map(drops.map(o=>[o.id,drops.filter(d=>d.id!==o.id).sort((a,b)=>
      Math.hypot((a.longitude-o.longitude)*Math.cos(o.latitude*Math.PI/180),a.latitude-o.latitude)
      -Math.hypot((b.longitude-o.longitude)*Math.cos(o.latitude*Math.PI/180),b.latitude-o.latitude)
      || a.id.localeCompare(b.id))]));
    let neighbors=snapshot.settings.matrixNeighbors || 5;
    drops.forEach(o=>{add('BR',o.id);add(o.id,'BR');rankings.get(o.id).slice(0,neighbors).forEach(d=>add(o.id,d.id));});
    const totals={requests:0,requestedElements:0,cacheHits:0,expansionRounds:0,validationRounds:0};
    const fetchMatrix=async refreshPairs=>{
      const matrix=await this.matrix(points,modes,{pairs:[...pairs.values()],refreshPairs});
      ['requests','requestedElements','cacheHits'].forEach(key=>totals[key]+=matrix.stats[key]);
      return matrix;
    };
    let matrix=await fetchMatrix();
    let result=runAlgorithms({...snapshot,roadMatrix:matrix});
    while(neighbors<drops.length-1) {
      const unresolved=new Set(result.results.filter(r=>!r.skipped).flatMap(r=>r.unassigned.map(o=>o.id)));
      if(!unresolved.size) break;
      const before=pairs.size;
      neighbors=Math.min(drops.length-1,neighbors*2);
      // Expand both incoming and outgoing options for unresolved orders.
      drops.forEach(o=>rankings.get(o.id).slice(0,neighbors).forEach(d=>{
        if(unresolved.has(o.id) || unresolved.has(d.id)) {add(o.id,d.id);add(d.id,o.id);}
      }));
      if(pairs.size===before && neighbors===drops.length-1) break;
      totals.expansionRounds++;
      matrix=await fetchMatrix();result=runAlgorithms({...snapshot,roadMatrix:matrix});
    }
    // Validate the union of all five selected routes against values <=10 seconds old.
    // Recompute all algorithms if refreshed durations alter the routes.
    const routePairs=plan=>{
      const selected=new Map();
      plan.results.filter(r=>!r.skipped).forEach(r=>r.routes.forEach(route=>{
        let previous='BR';
        for(const id of route.ids){selected.set(`${previous}>${id}`,[previous,id]);previous=id;}
        selected.set(`${previous}>BR`,[previous,'BR']);
      }));
      return [...selected.values()];
    };
    let validated=false;
    for(let round=0;round<4;round++) {
      const selected=routePairs(result);
      selected.forEach(([o,d])=>add(o,d));
      const refreshed=await fetchMatrix(selected);totals.validationRounds++;
      const before=JSON.stringify(selected.map(([o,d])=>modes.map(mode=>matrix.cells[mode]?.[o]?.[d])));
      const after=JSON.stringify(selected.map(([o,d])=>modes.map(mode=>refreshed.cells[mode]?.[o]?.[d])));
      matrix=refreshed;
      if(before===after) {validated=true;break;}
      result=runAlgorithms({...snapshot,roadMatrix:matrix});
    }
    if(!validated) throw fail('MATRIX_VALIDATION_UNSTABLE','Дорога меняется при проверке маршрутов; повторите расчёт');
    matrix.stats={...matrix.stats,...totals,calculationMode:'economy',initialNeighbors:snapshot.settings.matrixNeighbors || 5,
      selectedPairs:pairs.size,fullComparison:false,validated:true,validationFreshSeconds:10};
    return matrix;
  }
}

export function matrixClientFromEnv(env=process.env) {
  if(env.MATRIX_PROVIDER==='local') return null;
  if(!env.YANDEX_ROUTING_API_KEY && env.MATRIX_PROVIDER!=='yandex') return null;
  return new YandexMatrixClient({apiKey:env.YANDEX_ROUTING_API_KEY,traffic:env.YANDEX_MATRIX_TRAFFIC || 'enabled'});
}
