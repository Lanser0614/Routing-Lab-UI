import { DEFAULT_SETTINGS } from './timing.js';
import { problem } from './domain.js';

export function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw problem(422,'RUN_INPUT_INVALID','Параметры должны быть объектом');
  const numeric = ['goOutFromBranchMin', 'giveOrderToClientMin', 'bucketMaxFullSum', 'bucketMaxOrders', 'returnBufferPct'];
  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw problem(422, 'RUN_INPUT_INVALID', `Неизвестный параметр: ${key}`);
    if (key==='planningDate' && (typeof value!=='string' || (value!=='' && (!/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value)))) throw problem(422,'RUN_INPUT_INVALID','Неверная дата диапазона');
    if (['planningHourFrom','planningHourTo'].includes(key) && (!Number.isInteger(value) || value<(key==='planningHourFrom'?0:1) || value>(key==='planningHourFrom'?23:24))) throw problem(422,'RUN_INPUT_INVALID','Неверный час диапазона');
    if (key === 'planningAt' && (typeof value!=='string' || (value!=='' &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:00$/.test(value)
        || !Number.isFinite(Date.parse(value))
        || new Date(Date.parse(value)+5*3600000).toISOString().slice(0,19)!==value.slice(0,19))))) {
      throw problem(422,'RUN_INPUT_INVALID','Укажите дату и время расчёта в GMT+5');
    }
    if (key === 'matrixProvider' && !['auto','yandex','local'].includes(value)) throw problem(422,'RUN_INPUT_INVALID','matrixProvider: auto, yandex или local');
    if (key === 'matrixMode' && !['full','economy'].includes(value)) throw problem(422,'RUN_INPUT_INVALID','matrixMode: full или economy');
    if (key === 'matrixNeighbors' && (!Number.isInteger(value) || value<1 || value>20)) throw problem(422,'RUN_INPUT_INVALID','Число соседей: целое от 1 до 20');
    if (['allowLate','alwaysFreeCouriers'].includes(key) && typeof value !== 'boolean') throw problem(422, 'RUN_INPUT_INVALID', `${key} должен быть boolean`);
    if (numeric.includes(key) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || (key.startsWith('bucketMax') && (value <= 0 || !Number.isInteger(value)))
      || (key === 'bucketMaxOrders' && value > 12))) {
      throw problem(422, 'RUN_INPUT_INVALID', `Некорректный параметр: ${key}`);
    }
  }
  if(settings.planningHourFrom!=null && settings.planningHourTo!=null && settings.planningHourFrom>=settings.planningHourTo) throw problem(422,'RUN_INPUT_INVALID','Час начала должен быть меньше часа окончания');
}
