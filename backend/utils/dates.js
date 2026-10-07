// Date helpers that never depend on the server's time zone.
// Dates travel as 'YYYY-MM-DD' strings, exactly as stored in the database.

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// 'Monday'..'Friday' for a timetable day. Null for Saturday, Sunday or a bad date,
// because the timetable has no rows for those days.
// Same weekday rule as the database trigger (strftime('%w', date)).
export function weekdayName(value) {
  if (!isValidDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const name = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return name === 'Saturday' || name === 'Sunday' ? null : name;
}

// Today's date on the server's clock as 'YYYY-MM-DD'.
export function todayLocal() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// 'YYYY-MM-DD' plus n days (n may be negative). Pure UTC arithmetic.
export function addDays(value, n) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10);
}
