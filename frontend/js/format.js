// format.js - the one place dates and times are turned into text.
//
// Why: the app had five different date formats (device-locale ones that change from phone to phone, "20 Oct 2026",
// "Tue, 20 Oct 2026" ...). Everything here is fixed English output, so every device shows the same thing:
//
//   fmtDate('2026-10-20')                    -> 20/10/2026
//   fmtDayDate('2026-10-20')                 -> Tue, 20/10/2026
//   fmtDayMonth('2026-10-20')                -> Tue, 20 Oct
//   fmtDayMonth('2026-10-20', 'long')        -> Tuesday, 20 Oct
//   fmtDayMonth('2026-10-20', false)         -> 20 Oct          (chart axes)
//   fmtTime('13:30')                         -> 1:30 pm         (a timetable time)
//   fmtClock('2026-10-20T05:12:00Z')         -> 10:42 am        (an instant, shown in the device's time zone)
//   fmtDateTime('2026-10-20T05:12:00Z')      -> 20/10/2026, 10:42 am
//
// No DOM and no Intl, so it also runs in Node tests. Bad input comes back as the original text instead of throwing,
// so a bad row never blanks a screen.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' -> a Date at local midnight, or null if it is not a real calendar date (no 2026-02-31). */
export function parseISODate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** A Date -> 'YYYY-MM-DD' using the device's local calendar day (toISOString would give the UTC day). */
export const isoFromDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const todayISO = (now = new Date()) => isoFromDate(now);

const orRaw = (iso, make) => {
  const d = parseISODate(iso);
  return d ? make(d) : String(iso ?? '');
};

export const fmtDate = iso => orRaw(iso, d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`);

export const fmtDayDate = iso =>
  orRaw(iso, d => `${DAYS[d.getDay()].slice(0, 3)}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`);

/** weekday: 'short' (default), 'long', or false for no weekday. */
export const fmtDayMonth = (iso, weekday = 'short') =>
  orRaw(iso, d => {
    const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    if (!weekday) return day;
    const name = weekday === 'long' ? DAYS[d.getDay()] : DAYS[d.getDay()].slice(0, 3);
    return `${name}, ${day}`;
  });

const clock = (h, m) => `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`;

/** '13:30', '13:30:00' or '1:30 PM' -> '1:30 pm'. Anything unreadable is returned as it came. */
export function fmtTime(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap]m)?$/i.exec(String(text ?? '').trim());
  if (!m) return String(text ?? '');
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return String(text);
  return clock(h, min);
}

/** A Date or an ISO instant ('2026-10-20T05:12:00Z') -> '10:42 am' in the device's own time zone. */
export function fmtClock(when) {
  const d = when instanceof Date ? when : new Date(when);
  return Number.isNaN(d.getTime()) ? '' : clock(d.getHours(), d.getMinutes());
}

export function fmtDateTime(when) {
  const d = when instanceof Date ? when : new Date(when);
  return Number.isNaN(d.getTime()) ? '' : `${fmtDate(isoFromDate(d))}, ${fmtClock(d)}`;
}
