export const TIMEZONE = 'Asia/Tashkent';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

// Текущий момент в Ташкенте (GMT+5): дата, HH:MM и минуты от начала суток.
export function tashkentNow(date = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const hours = Number(parts.hour);
  const minutes = Number(parts.minute);
  return {
    date: `${parts.day}.${parts.month}.${parts.year}`,
    hm: `${parts.hour}:${parts.minute}`,
    minutes: hours * 60 + minutes,
    timezone: TIMEZONE,
    iso: date.toISOString()
  };
}
