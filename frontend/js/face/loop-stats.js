// Timing and gate counters for the enrolment capture loop. No DOM, so it can be tested on its own.
// The page shows the summary when the address ends in ?debug=1, so the numbers can be read on a real phone.
//
//   const stats = createLoopStats();
//   stats.time('detect', 41.2);   // a duration in ms
//   stats.count('noface');        // how often a gate fired
//   stats.frame(now);             // call once per loop turn: gives the real frame rate
//   stats.summary() -> { fps, detect: { median, p90 }, ..., counts: { noface: 3 } }

const KEEP = 60; // the last this-many samples per name

export function createLoopStats() {
  const samples = new Map();
  const counts = {};
  const frames = [];
  const round = n => Math.round(n * 10) / 10;
  return {
    time(name, ms) {
      const list = samples.get(name) || [];
      list.push(ms);
      if (list.length > KEEP) list.shift();
      samples.set(name, list);
    },
    count(name) {
      counts[name] = (counts[name] || 0) + 1;
    },
    frame(now) {
      frames.push(now);
      if (frames.length > KEEP) frames.shift();
    },
    summary() {
      const out = { counts: { ...counts } };
      if (frames.length > 1) out.fps = round(((frames.length - 1) * 1000) / (frames.at(-1) - frames[0]));
      for (const [name, list] of samples) {
        const sorted = [...list].sort((a, b) => a - b);
        out[name] = { median: round(sorted[Math.floor(sorted.length / 2)]), p90: round(sorted[Math.floor(sorted.length * 0.9)]) };
      }
      return out;
    },
    // One line for the debug strip
    line() {
      const s = this.summary();
      const t = name => (s[name] ? `${s[name].median}ms` : '-');
      const gates = Object.entries(s.counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
      return `${s.fps ?? '-'} fps | detect ${t('detect')} (worker ${t('detectWorker')}) | light ${t('assess')} | loop ${t('loop')} | gates: ${gates}`;
    },
  };
}
