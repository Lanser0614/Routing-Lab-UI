import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runAlgorithms } from './planning.js';
import { COURIER_TRANSITIONS, ORDER_TRANSITIONS, problem, validateCourier, validateOrder } from './domain.js';
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
  constructor(filename, { clock = () => new Date() } = {}) {
    this.clock = clock;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenario (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS couriers (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS status_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, changed_at TEXT NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS planning_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, scenario_version INTEGER NOT NULL, input_snapshot TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    this.seed();
    this.migrateBranchData();
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
    return { scenarioId: scenario.id, version: scenario.version, settings: scenario.settings, planningAt: this.now(), orders: this.list('orders'), couriers: this.list('couriers') };
  }

  now() { return tashkentNow(this.clock()); }

  latestRun() {
    const row = this.db.prepare('SELECT * FROM planning_runs ORDER BY id DESC LIMIT 1').get();
    return row ? { number: row.id, version: row.scenario_version, ...JSON.parse(row.result_json), createdAt: row.created_at } : null;
  }

  bootstrap() {
    const snapshot = this.snapshot();
    return { ...snapshot, branch: BRANCH, run: this.latestRun(), nextId: this.nextId('orders', 'O'), nextCId: this.nextId('couriers', 'C') };
  }

  nextId(table, prefix) {
    const ids = this.db.prepare(`SELECT id FROM ${table}`).all().map(row => Number(row.id.replace(/\D/g, '')) || 0);
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
    validateSettings(settings);
    this.db.prepare('UPDATE scenario SET settings_json=?,version=version+1 WHERE id=?').run(JSON.stringify({ ...current, ...settings }), 'golden');
    return this.bootstrap();
  }

  addStatusEvent(type, id, fromStatus, toStatus, reason) { this.db.prepare('INSERT INTO status_events(entity_type,entity_id,from_status,to_status,changed_at,reason) VALUES(?,?,?,?,?,?)').run(type, id, fromStatus || null, toStatus, new Date().toISOString(), reason); }

  history(type, id) { return this.db.prepare('SELECT * FROM status_events WHERE entity_type=? AND entity_id=? ORDER BY id').all(type, id); }

  saveRun(snapshot, forcedId) {
    const result = runAlgorithms(snapshot);
    const createdAt = new Date().toISOString();
    if (forcedId) this.db.prepare('INSERT INTO planning_runs(id,scenario_version,input_snapshot,result_json,created_at) VALUES(?,?,?,?,?)').run(forcedId, snapshot.version, JSON.stringify(snapshot), JSON.stringify(result), createdAt);
    else this.db.prepare('INSERT INTO planning_runs(scenario_version,input_snapshot,result_json,created_at) VALUES(?,?,?,?)').run(snapshot.version, JSON.stringify(snapshot), JSON.stringify(result), createdAt);
    return this.latestRun();
  }

  createRun() { return this.saveRun(this.snapshot()); }
}
