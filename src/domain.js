export const ORDER_STATUSES = [
  'DRAFT', 'COOKING_STARTED', 'COOKING_COMPLETED', 'WAITING',
  'ASSIGNED', 'ON_WAY', 'DELIVERED', 'CANCELLED'
];

export const ORDER_TRANSITIONS = {
  DRAFT: ['COOKING_STARTED', 'CANCELLED'],
  COOKING_STARTED: ['COOKING_COMPLETED', 'CANCELLED'],
  COOKING_COMPLETED: ['WAITING', 'CANCELLED'],
  WAITING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['WAITING', 'ON_WAY', 'CANCELLED'],
  ON_WAY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: []
};

export const COURIER_STATUSES = ['OFFLINE', 'FREE', 'RESERVED', 'DELIVERING', 'RETURNING'];
export const COURIER_TRANSITIONS = {
  OFFLINE: ['FREE'],
  FREE: ['RESERVED', 'OFFLINE'],
  RESERVED: ['FREE', 'DELIVERING', 'OFFLINE'],
  DELIVERING: ['RETURNING', 'FREE'],
  RETURNING: ['FREE', 'OFFLINE']
};

export const VEHICLE_MODES = ['DRIVING', 'SCOOTER', 'BICYCLING', 'WALKING'];
export const ELIGIBLE_ORDER_STATUSES = ['COOKING_STARTED', 'COOKING_COMPLETED', 'WAITING'];

import { BRANCH_ZONE_POINTS } from './branch.js';

export const ZONES = [
  { id: 'Z1', name: 'Amir Temur · зона доставки', color: '#26967F', fill: 'rgba(38,150,127,0.15)', pts: BRANCH_ZONE_POINTS, modes: null }
];

export function problem(status, code, detail, errors = []) {
  return Object.assign(new Error(detail), { status, code, detail, errors });
}

export function validateOrder(order) {
  const errors = [];
  if (!order.address?.trim()) errors.push({ field: 'address', code: 'REQUIRED', message: 'Укажите адрес' });
  if (!Number.isFinite(Number(order.x)) || !Number.isFinite(Number(order.y))) errors.push({ field: 'location', code: 'REQUIRED', message: 'Выберите точку на карте' });
  if (!ORDER_STATUSES.includes(order.status)) errors.push({ field: 'status', code: 'INVALID_ENUM', message: 'Неизвестный статус' });
  if (!(Number(order.sum) > 0)) errors.push({ field: 'sum', code: 'POSITIVE', message: 'Сумма должна быть больше 0' });
  if (!(Number(order.service) >= 0)) errors.push({ field: 'service', code: 'NON_NEGATIVE', message: 'Время обслуживания не может быть отрицательным' });
  const times = [order.created, order.ready, order.deadline];
  if (times.some(value => !/^\d{2}:\d{2}$/.test(value || ''))) errors.push({ field: 'time', code: 'INVALID', message: 'Время должно быть в формате HH:MM' });
  else if (!(toMinutes(order.created) <= toMinutes(order.ready) && toMinutes(order.ready) <= toMinutes(order.deadline))) {
    errors.push({ field: 'deadline', code: 'ORDER_DEADLINE_BEFORE_READY', message: 'Нужно: создан ≤ готов ≤ deadline' });
  }
  if (errors.length) throw problem(422, 'RUN_INPUT_INVALID', 'Заказ не прошёл валидацию', errors);
}

export function validateCourier(courier) {
  const errors = [];
  if (!courier.name?.trim()) errors.push({ field: 'name', code: 'REQUIRED', message: 'Имя не может быть пустым' });
  if (!COURIER_STATUSES.includes(courier.status)) errors.push({ field: 'status', code: 'INVALID_ENUM', message: 'Неизвестный статус' });
  if (!VEHICLE_MODES.includes(courier.mode)) errors.push({ field: 'mode', code: 'INVALID_ENUM', message: 'Неизвестный транспорт' });
  if (!(Number(courier.maxOrders) >= 1)) errors.push({ field: 'maxOrders', code: 'MIN', message: 'max_orders ≥ 1' });
  if (!(Number(courier.maxSum) > 0)) errors.push({ field: 'maxSum', code: 'POSITIVE', message: 'max_full_sum > 0' });
  if (!Array.isArray(courier.zones) || !courier.zones.length) errors.push({ field: 'zones', code: 'REQUIRED', message: 'Нужна минимум одна зона' });
  if (errors.length) throw problem(422, 'RUN_INPUT_INVALID', 'Курьер не прошёл валидацию', errors);
}

export function toMinutes(value) {
  const [hours, minutes] = String(value || '0:0').split(':').map(Number);
  return hours * 60 + minutes;
}
