import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runAlgorithms } from './planning.js';
import { COURIER_TRANSITIONS, ORDER_TRANSITIONS, problem, validateCourier, validateOrder, minutesNear } from './domain.js';
import { testSnapshot } from './historical-scenario.js';
import { BRANCH } from './branch.js';
import { tashkentNow } from './time.js';
import { DEFAULT_SETTINGS } from './timing.js';
import { validateSettings } from './settings.js';

const INITIAL_ORDERS = [];
const INITIAL_COURIERS = [
  { id:'C1', name:'Азиз', status:'FREE', mode:'SCOOTER', maxOrders:3, maxSum:300000, zones:['Z1'], freeSince:'17:52' },
  { id:'C2', name:'Бекзод', status:'FREE', mode:'DRIVING', maxOrders:3, maxSum:300000, zones:['Z1'], freeSince:'17:54' },
  { id:'C3', name:'Дилшод', status:'OFFLINE', mode:'BICYCLING', maxOrders:2, maxSum:200000, zones:['Z1'], freeSince:null }
];

export class Repository {
  constructor(filename, { clock = () => new Date(), observer = false } = {}) {
    this.clock = clock;
    this.observer = observer;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const existed=fs.existsSync(filename);
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenario (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS couriers (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS status_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, changed_at TEXT NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS planning_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, scenario_version INTEGER NOT NULL, input_snapshot TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS buckets (id INTEGER PRIMARY KEY AUTOINCREMENT, algorithm TEXT NOT NULL, data_json TEXT NOT NULL, status TEXT NOT NULL);
    `);
    this.seed();
    this.migrateBranchData();
    if (observer && !this.db.prepare('SELECT value FROM meta WHERE key=?').get('observer_initialized')) {
      if(existed) {this.db.close();throw new Error('Observer requires a new SQLite file or an initialized observer database');}
      this.db.exec("DELETE FROM orders; DELETE FROM couriers; DELETE FROM planning_runs; DELETE FROM status_events;");
      this.updateSettings({alwaysFreeCouriers:false,planningAt:'',planningDate:'',matrixProvider:'local'});
      this.db.prepare('INSERT INTO meta VALUES(?,?)').run('observer_initialized','1');
    }
  }

  seed() {
    if (this.db.prepare('SELECT COUNT(*) AS count FROM scenario').get().count) return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO scenario(id,name,version,settings_json) VALUES(?,?,?,?)').run('golden', 'Golden-сценарий · Ташкент', 11, JSON.stringify({ allowLate: true }));
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('branch_data_version', 'amir-temur-v2');
      const insertOrder = this.db.prepare('INSERT INTO orders(id,data_json) VALUES(?,?)');
      INITIAL_ORDERS.forEach(order => insertOrder.run(order.id, JSON.stringify(order)));
      const insertCourier = this.db.prepare('INSERT INTO couriers(id,data_json) VALUES(?,?)');
      INITIAL_COURIERS.forEach(courier => insertCourier.run(courier.id, JSON.stringify(courier)));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  migrateBranchData() {
    const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('branch_data_version')?.value;
    if (version === 'amir-temur-v2') return;
    this.db.exec('BEGIN');
    try {
      const updateCourier = this.db.prepare('UPDATE couriers SET data_json=?,version=version+1 WHERE id=?');
      this.list('couriers').forEach(courier => updateCourier.run(JSON.stringify({ ...courier, zones: ['Z1'] }), courier.id));
      const seedLocations = new Map(INITIAL_ORDERS.map(order => [order.id, order]));
      const updateOrder = this.db.prepare('UPDATE orders SET data_json=?,version=version+1 WHERE id=?');
      this.list('orders').forEach(order => {
        const location = seedLocations.get(order.id);
        if (location) updateOrder.run(JSON.stringify({ ...order, address: location.address, x: location.x, y: location.y }), order.id);
      });
      this.db.prepare('UPDATE scenario SET version=version+1 WHERE id=?').run('golden');
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('branch_data_version', 'amir-temur-v2');
      this.db.exec('COMMIT');
      this.saveRun(this.snapshot());
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  scenario() {
    const row = this.db.prepare('SELECT * FROM scenario WHERE id=?').get('golden');
    return { id: row.id, name: row.name, version: row.version, settings: { ...DEFAULT_SETTINGS, ...JSON.parse(row.settings_json) } };
  }

  list(table) {
    return this.db.prepare(`SELECT data_json FROM ${table} ORDER BY id`).all().map(row => JSON.parse(row.data_json));
  }

  snapshot() {
    const scenario = this.scenario();
    const at=scenario.settings.planningAt;
    const planningAt=at ? tashkentNow(new Date(at)) : this.now();
    let orders=this.ordersForRange(scenario.settings);
    if(at) {
      const historical=orders.filter(o=>o.createdAt && Array.isArray(o.events));
      const active=testSnapshot({orders:historical,settings:scenario.settings},at).orders;
      orders=[...orders.filter(o=>!historical.includes(o) && minutesNear(o.created,planningAt.minutes)<=planningAt.minutes),...active];
    }
    if(this.observer) orders=orders.filter(o=>!o.observationIssue).map(o=>{
      const relative = value => planningAt.minutes+(Date.parse(value)-Date.parse(planningAt.iso))/60000;
      return {...o,createdMinutes:relative(o.createdAt),readyMinutes:relative(o.readyAt),deadlineMinutes:relative(o.deadlineAt)};
    });
    const current=new Map(this.list('orders').map(o=>[o.id,o]));
    const lockedBuckets=this.db.prepare("SELECT id,data_json FROM buckets WHERE status!='completed'").all().map(row=>{
      const b={...JSON.parse(row.data_json),id:row.id};
      const statuses=b.route.ids.map(id=>current.get(id)?.status);
      if(statuses.every(s=>['DELIVERED','CANCELLED'].includes(s))) b.status='completed';
      else if(statuses.some(s=>s==='ON_WAY')) b.status='dispatched';
      this.db.prepare('UPDATE buckets SET status=?,data_json=? WHERE id=?').run(b.status,JSON.stringify(b),b.id);
      return b;
    }).filter(b=>b.status!=='completed');
    const generation=Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('database_generation')?.value||0);
    return { scenarioId: scenario.id, version: scenario.version, generation, settings: scenario.settings, planningAt, orders, couriers: this.list('couriers'),lockedBuckets };
  }

  kafkaOrder(id) {const row=this.db.prepare('SELECT data_json FROM orders WHERE id=?').get(id);return row?JSON.parse(row.data_json):null;}

  ingestKafka(kind, entity, record) {
    const table=kind==='orders'?'orders':'couriers';
    const key=`kafka:${record.topic}:${record.partition}`;
    const previousOffset=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
    if(previousOffset!==undefined && BigInt(record.offset)<=BigInt(previousOffset)) return false;
    this.db.exec('BEGIN');
    try {
      let changed=false;
      if(entity) {
        const previous=this.db.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(entity.id);
        const old=previous && JSON.parse(previous.data_json);
        if(kind==='orders' && old && entity.observedAt<old.observedAt && entity.waitCookingAt && (!old.waitCookingAt || entity.waitCookingAt<old.waitCookingAt)) {
          const createdAt=entity.waitCookingAt,deadlineAt=new Date(Date.parse(createdAt)+35*60000).toISOString();
          entity={...old,waitCookingAt:createdAt,createdAt,created:tashkentNow(new Date(createdAt)).hm,deadlineAt,deadline:tashkentNow(new Date(deadlineAt)).hm,deadlineBasis:'wait_cooking_event',observationIssue:old.observationIssue==='CREATED_AT_MISSING'?null:old.observationIssue};
        }
        if(!old || entity.observedAt>=old.observedAt) {
          this.db.prepare(`INSERT INTO ${table}(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,version=version+1`).run(entity.id,JSON.stringify(entity));
          if(old?.status!==entity.status) this.addStatusEvent(kind==='orders'?'order':'courier',entity.id,old?.status,entity.status,'Kafka observer');
          this.bumpVersion(); changed=true;
        }
      }
      this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(record.offset));
      this.db.exec('COMMIT'); return changed;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }

  now() { return tashkentNow(this.clock()); }

  ordersForRange(settings) {
    const orders=this.list('orders');
    if(!settings.planningDate) return orders;
    const start=Date.parse(`${settings.planningDate}T00:00:00+05:00`);
    return orders.filter(o=>{
      const created=o.createdAt ? Date.parse(o.createdAt) : start+Number(o.created.slice(0,2))*3600000+Number(o.created.slice(3))*60000;
      return created>=start+settings.planningHourFrom*3600000 && created<start+settings.planningHourTo*3600000;
    });
  }

  latestRun() {
    const row = this.db.prepare('SELECT * FROM planning_runs ORDER BY id DESC LIMIT 1').get();
    return row ? { number: row.id, version: row.scenario_version, ...JSON.parse(row.result_json), createdAt: row.created_at } : null;
  }

  bootstrap() {
    const snapshot = this.snapshot();
    return { ...snapshot, orders:this.ordersForRange(snapshot.settings), branch: BRANCH, run: this.latestRun(), nextId: this.nextId('orders', 'O'), nextCId: this.nextId('couriers', 'C') };
  }

  nextId(table, prefix) {
    const pattern = new RegExp(`^${prefix}(\\d+)$`);
    const ids = this.db.prepare(`SELECT id FROM ${table}`).all().map(row => Number(row.id.match(pattern)?.[1]) || 0);
    return Math.max(0, ...ids) + 1;
  }

  bumpVersion() { this.db.prepare('UPDATE scenario SET version=version+1 WHERE id=?').run('golden'); }

  upsertOrder(id, data, isNew) {
    const order = { id, address: String(data.address || '').trim(), status: data.status, sum: Number(data.sum), created: data.created, ready: data.ready, deadline: data.deadline, service: Number(data.service), x: Number(data.x), y: Number(data.y) };
    validateOrder(order);
    const current = this.db.prepare('SELECT data_json FROM orders WHERE id=?').get(id);
    if (isNew && current) throw problem(409, 'ENTITY_ALREADY_EXISTS', `Заказ ${id} уже существует`);
    if (!isNew && !current) throw problem(404, 'ENTITY_NOT_FOUND', `Заказ ${id} не найден`);
    this.db.exec('BEGIN');
    try {
      if (isNew) this.db.prepare('INSERT INTO orders(id,data_json) VALUES(?,?)').run(id, JSON.stringify(order));
      else this.db.prepare('UPDATE orders SET data_json=?,version=version+1 WHERE id=?').run(JSON.stringify(order), id);
      const previous = current && JSON.parse(current.data_json);
      if (!previous || previous.status !== order.status) this.addStatusEvent('order', id, previous?.status, order.status, isNew ? 'Создан' : 'Изменён в карточке');
      this.bumpVersion();
      this.db.exec('COMMIT');
      return this.bootstrap();
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setOrderStatus(id, status, reason = 'Быстрое действие') {
    const row = this.db.prepare('SELECT data_json FROM orders WHERE id=?').get(id);
    if (!row) throw problem(404, 'ENTITY_NOT_FOUND', `Заказ ${id} не найден`);
    const order = JSON.parse(row.data_json);
    if (!ORDER_TRANSITIONS[order.status]?.includes(status)) throw problem(409, 'ORDER_STATUS_TRANSITION_INVALID', `Переход ${order.status} → ${status} запрещён`);
    order.status = status;
    this.db.exec('BEGIN');
    try { this.db.prepare('UPDATE orders SET data_json=?,version=version+1 WHERE id=?').run(JSON.stringify(order), id); this.addStatusEvent('order', id, JSON.parse(row.data_json).status, status, reason); this.bumpVersion(); this.db.exec('COMMIT'); return this.bootstrap(); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  deleteOrder(id) { const result = this.db.prepare('DELETE FROM orders WHERE id=?').run(id); if (!result.changes) throw problem(404, 'ENTITY_NOT_FOUND', `Заказ ${id} не найден`); this.bumpVersion(); return this.bootstrap(); }

  upsertCourier(id, data, isNew) {
    const courier = { id, name: String(data.name || '').trim(), status: data.status, mode: data.mode, maxOrders: Number(data.maxOrders), maxSum: Number(data.maxSum), zones: [...new Set(data.zones || [])], freeSince: data.status === 'FREE' ? (data.freeSince || this.now().hm) : null };
    validateCourier(courier);
    const current = this.db.prepare('SELECT data_json FROM couriers WHERE id=?').get(id);
    if (isNew && current) throw problem(409, 'ENTITY_ALREADY_EXISTS', `Курьер ${id} уже существует`);
    if (!isNew && !current) throw problem(404, 'ENTITY_NOT_FOUND', `Курьер ${id} не найден`);
    this.db.exec('BEGIN');
    try {
      if (isNew) this.db.prepare('INSERT INTO couriers(id,data_json) VALUES(?,?)').run(id, JSON.stringify(courier));
      else this.db.prepare('UPDATE couriers SET data_json=?,version=version+1 WHERE id=?').run(JSON.stringify(courier), id);
      const previous = current && JSON.parse(current.data_json);
      if (!previous || previous.status !== courier.status) this.addStatusEvent('courier', id, previous?.status, courier.status, isNew ? 'Создан' : 'Изменён в карточке');
      this.bumpVersion(); this.db.exec('COMMIT'); return this.bootstrap();
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setCourierStatus(id, status, reason = 'Быстрое действие') {
    const row = this.db.prepare('SELECT data_json FROM couriers WHERE id=?').get(id);
    if (!row) throw problem(404, 'ENTITY_NOT_FOUND', `Курьер ${id} не найден`);
    const courier = JSON.parse(row.data_json);
    if (!COURIER_TRANSITIONS[courier.status]?.includes(status)) throw problem(409, 'COURIER_STATUS_TRANSITION_INVALID', `Переход ${courier.status} → ${status} запрещён`);
    const previous = courier.status; courier.status = status; courier.freeSince = status === 'FREE' ? this.now().hm : null;
    this.db.exec('BEGIN');
    try { this.db.prepare('UPDATE couriers SET data_json=?,version=version+1 WHERE id=?').run(JSON.stringify(courier), id); this.addStatusEvent('courier', id, previous, status, reason); this.bumpVersion(); this.db.exec('COMMIT'); return this.bootstrap(); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  updateSettings(settings) {
    const current = this.scenario().settings;
    validateSettings({ ...current, ...settings });
    this.db.prepare('UPDATE scenario SET settings_json=?,version=version+1 WHERE id=?').run(JSON.stringify({ ...current, ...settings }), 'golden');
    return this.bootstrap();
  }

  addStatusEvent(type, id, fromStatus, toStatus, reason) { this.db.prepare('INSERT INTO status_events(entity_type,entity_id,from_status,to_status,changed_at,reason) VALUES(?,?,?,?,?,?)').run(type, id, fromStatus || null, toStatus, new Date().toISOString(), reason); }

  history(type, id) { return this.db.prepare('SELECT * FROM status_events WHERE entity_type=? AND entity_id=? ORDER BY id').all(type, id); }

  saveRun(snapshot, forcedId) {
    const generation=Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('database_generation')?.value||0);
    if((snapshot.generation||0)!==generation) throw problem(409,'DATABASE_CLEARED','База очищена во время расчёта. Запустите расчёт заново.');
    snapshot={...snapshot,lockedBuckets:this.snapshot().lockedBuckets};
    const result = runAlgorithms(snapshot);
    const createdAt = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
    for(const algorithm of result.results) for(const route of algorithm.routes) {
      if(route.locked) {
        const row=this.db.prepare('SELECT data_json FROM buckets WHERE id=?').get(route.bucketId);
        if(row) {const bucket=JSON.parse(row.data_json);bucket.route=route;this.db.prepare('UPDATE buckets SET data_json=? WHERE id=?').run(JSON.stringify(bucket),route.bucketId);}
        continue;
      }
      if(route.ev.status!=='closed') continue;
      const closingTimeAt=snapshot.planningAt?.iso?new Date(Date.parse(snapshot.planningAt.iso)+(route.ev.closingTime-snapshot.planningAt.minutes)*60000).toISOString():null;
      const bucket={algorithm:algorithm.code,status:'closed',closingTime:route.ev.closingTime,closingTimeAt,route,orders:route.ids.map(id=>snapshot.orders.find(o=>o.id===id)),closedAt:createdAt};
      if(bucket.orders.some(o=>!o)) throw new Error('Bucket order missing from snapshot');
      const row=this.db.prepare('INSERT INTO buckets(algorithm,data_json,status) VALUES(?,?,?)').run(algorithm.code,JSON.stringify(bucket),'closed');
      route.bucketId=Number(row.lastInsertRowid);route.locked=true;
    }
    if (forcedId) this.db.prepare('INSERT INTO planning_runs(id,scenario_version,input_snapshot,result_json,created_at) VALUES(?,?,?,?,?)').run(forcedId, snapshot.version, JSON.stringify(snapshot), JSON.stringify(result), createdAt);
    else this.db.prepare('INSERT INTO planning_runs(scenario_version,input_snapshot,result_json,created_at) VALUES(?,?,?,?)').run(snapshot.version, JSON.stringify(snapshot), JSON.stringify(result), createdAt);
    this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return this.latestRun();
  }

  createRun() { return this.saveRun(this.snapshot()); }

  clearDatabase() {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM buckets; DELETE FROM planning_runs; DELETE FROM status_events; DELETE FROM orders; DELETE FROM couriers;');
      const generation=Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get('database_generation')?.value||0)+1;
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('database_generation',String(generation));
      this.bumpVersion();
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    return this.bootstrap();
  }

  buckets() {this.snapshot();return this.db.prepare('SELECT id,data_json,status FROM buckets ORDER BY id').all().map(row=>({...JSON.parse(row.data_json),id:row.id,status:row.status}));}

  importOrders(orders) {
    orders.forEach(validateOrder);
    this.db.exec('BEGIN');
    try {
      const upsert=this.db.prepare('INSERT INTO orders(id,data_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,version=orders.version+1');
      for(const order of orders) {
        const old=this.db.prepare('SELECT data_json FROM orders WHERE id=?').get(order.id);
        upsert.run(order.id,JSON.stringify(order));
        if(!old) this.addStatusEvent('order',order.id,null,order.status,'Импорт из тестового fixture');
      }
      const settings={...this.scenario().settings,matrixProvider:'local',matrixMode:'full',alwaysFreeCouriers:true};
      this.db.prepare('UPDATE scenario SET settings_json=?,version=version+1 WHERE id=?').run(JSON.stringify(settings),'golden');
      this.db.exec('COMMIT');
      return this.bootstrap();
    } catch(error) { this.db.exec('ROLLBACK');throw error; }
  }
}
