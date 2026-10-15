// Pure helpers for the Today tab (no DOM), so they can be tested on their own.

export const LUNCH_GAP_MIN = 20; // a gap this long between two periods is the lunch break

export const toMin = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// '13:30' -> '1:30 pm'
export function fmtTime(hhmm) {
  const h = Number(hhmm.slice(0, 2));
  const suffix = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}:${hhmm.slice(3, 5)} ${suffix}`;
}

// ISO UTC ('...Z') -> '10:42 am' in the phone's own time zone
export function fmtLocalTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

// One period per row from the API. Consecutive periods of the same subject, teacher, room and
// batch with no lunch break between them become one card (a two-period lab is one card).
export function groupRows(rows) {
  const groups = [];
  for (const row of rows) {
    const prev = groups.at(-1);
    if (prev && canMerge(prev.periods.at(-1), row)) prev.periods.push(row);
    else groups.push({ periods: [row] });
  }
  return groups.map(g => ({
    periods: g.periods,
    subject: g.periods[0].subject,
    faculty: g.periods[0].faculty,
    room: g.periods[0].room,
    forBatch: g.periods[0].forBatch,
    startTime: g.periods[0].startTime,
    endTime: g.periods.at(-1).endTime,
  }));
}

function canMerge(a, b) {
  return (
    a.subject.id === b.subject.id &&
    a.faculty === b.faculty &&
    a.room === b.room &&
    a.forBatch === b.forBatch &&
    toMin(b.startTime) - toMin(a.endTime) < LUNCH_GAP_MIN
  );
}

// True when a lunch break sits between these two cards.
export const lunchBetween = (prev, next) =>
  toMin(next.startTime) - toMin(prev.endTime) >= LUNCH_GAP_MIN;

// What the card as a whole is doing. The most urgent period decides.
const PRIORITY = [
  'open_qr', 'open_camera', 'waiting', 'batch_pending', 'not_on_roster',
  'upcoming', 'missed', 'marked', 'not_held', 'not_tracked',
];
export function groupState(group) {
  const states = group.periods.map(p => p.state);
  return PRIORITY.find(s => states.includes(s)) || 'not_tracked';
}

// The card to feature: an open or running class first, otherwise the next one.
// Returns an index into groups, or -1 when the day is over.
export function pickNow(groups) {
  const active = groups.findIndex(g => ['open_qr', 'open_camera', 'waiting'].includes(groupState(g)));
  if (active !== -1) return active;
  return groups.findIndex(g => groupState(g) === 'upcoming');
}

// text + icon + tone for one period's chip. Colour never carries the meaning alone.
export function chipFor(period) {
  switch (period.state) {
    case 'upcoming':
      return { tone: 'neutral', icon: '○', text: `Starts ${fmtTime(period.startTime)}` };
    case 'waiting':
      return { tone: 'warning', icon: '…', text: 'Not open yet' };
    case 'open_qr':
      return { tone: 'info', icon: '●', text: 'Attendance open' };
    case 'open_camera':
      return { tone: 'info', icon: '●', text: 'Camera marking' };
    case 'marked': {
      const time = period.markedAt ? fmtLocalTime(period.markedAt) : '';
      const method = { qr: 'QR', cctv: 'Camera', manual: 'Teacher' }[period.markedMethod] || '';
      return { tone: 'success', icon: '✓', text: ['Present', time, method].filter(Boolean).join(' · ') };
    }
    case 'missed':
      return { tone: 'danger', icon: '✕', text: 'Absent' };
    case 'not_held':
      return { tone: 'neutral', icon: '–', text: 'No attendance taken' };
    case 'not_tracked':
      return { tone: 'muted', icon: '–', text: 'Not tracked' };
    case 'batch_pending':
      return { tone: 'warning', icon: '!', text: "Lab batch isn't assigned yet" };
    case 'not_on_roster':
      return { tone: 'warning', icon: '!', text: 'Not on this class list' };
    default:
      return { tone: 'neutral', icon: '', text: '' };
  }
}

// Minutes until `startTime`, from the server's own clock (nowTime 'HH:MM').
export function minutesUntil(startTime, nowTime) {
  return toMin(startTime) - toMin(nowTime);
}

export function countdownText(minutes) {
  if (minutes <= 0) return 'Starting now';
  if (minutes < 60) return `Starts in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `Starts in ${h} h ${m} min` : `Starts in ${h} h`;
}

export function greetingFor(nowTime) {
  const h = Number(nowTime.slice(0, 2));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// "CSE 5A" and friends
export function classLabel(klass) {
  return klass ? `${klass.branch} ${klass.semester}${klass.section}` : '';
}
