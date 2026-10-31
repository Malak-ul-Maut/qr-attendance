// The rotating QR code, made on the server and pushed to the faculty screen over the socket.
//
// Why it works the way it does
//  - A frame is a short random string with a sequence number: "A2.1k.9f86d081884c7d65". It means nothing by itself;
//    the server remembers which session it belongs to, so the session code is never shown or sent to a phone.
//  - Frames change every FRAME_MS (fast) but stay valid for FRAME_LIFETIME_MS (long enough for slow Wi-Fi). So we do
//    not have to keep shortening the lifetime. Many frames are valid at once.
//  - A student's phone must hand in FRAMES_REQUIRED different frames that were on the screen right after each other.
//    A single photo can only ever contain one frame, so a photo can never be redeemed. A live scanner pointed at the
//    screen sees several frames within a second and has no trouble.
//
// What this cannot stop: a video (or burst of photos) of the screen sent on within FRAME_LIFETIME_MS, or someone
// relaying the live camera picture. Those need a person actively helping in real time; the face check and the
// one-phone-one-student rule are the other layers for that.
import { randomBytes } from 'crypto';

const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
export const FRAME_MS = num(process.env.QR_FRAME_MS, 400);
export const FRAME_LIFETIME_MS = num(process.env.QR_FRAME_LIFETIME_MS, 4000);
export const FRAMES_REQUIRED = Math.min(4, Math.max(1, Math.round(num(process.env.QR_FRAMES_REQUIRED, 2))));
// The frames handed in may skip a few (a blurry moment), but must still be "right after each other".
const SKIP_ALLOWED = 2;

const FRAME_RE = /^A([1-4])\.([0-9a-z]{1,8})\.([0-9a-f]{16})$/;
export const looksLikeFrame = value => FRAME_RE.test(String(value));

const feeds = new Map(); // sessionCode -> { seq, frames: [{ seq, rand, issuedAt }], timer }
const index = new Map(); // rand -> { sessionCode, seq, issuedAt }

const text = (seq, rand) => `A${FRAMES_REQUIRED}.${seq.toString(36)}.${rand}`;

function prune(feed, now) {
  while (feed.frames.length && now - feed.frames[0].issuedAt > FRAME_LIFETIME_MS)
    index.delete(feed.frames.shift().rand);
}

// The newest frame, or a new one if the newest is already FRAME_MS old. Called by the socket ticker and by the
// HTTP fallback, so both hand out the same sequence.
export function currentFrame(sessionCode) {
  const now = Date.now();
  let feed = feeds.get(sessionCode);
  if (!feed) feeds.set(sessionCode, (feed = { seq: 0, frames: [], timer: null }));
  prune(feed, now);
  const last = feed.frames.at(-1);
  if (last && now - last.issuedAt < FRAME_MS * 0.9) return text(last.seq, last.rand);
  const frame = { seq: ++feed.seq, rand: randomBytes(8).toString('hex'), issuedAt: now };
  feed.frames.push(frame);
  index.set(frame.rand, { sessionCode, seq: frame.seq, issuedAt: now });
  return text(frame.seq, frame.rand);
}

// Starts pushing frames to the room `qr:<sessionCode>` (idempotent). Stops by itself when the room is empty.
export function startPushing(io, sessionCode) {
  const feed = feeds.get(sessionCode) ?? (currentFrame(sessionCode), feeds.get(sessionCode));
  if (feed.timer) return;
  const room = `qr:${sessionCode}`;
  feed.timer = setInterval(() => {
    if (!io.sockets.adapter.rooms.get(room)?.size) return stopPushing(sessionCode);
    io.to(room).volatile.emit('qr_frame', { code: currentFrame(sessionCode), lifetimeMs: FRAME_LIFETIME_MS });
  }, FRAME_MS);
}

function stopPushing(sessionCode) {
  const feed = feeds.get(sessionCode);
  if (feed?.timer) clearInterval(feed.timer);
  if (feed) feed.timer = null;
}

// The session ended or was discarded: nothing scanned afterwards may count.
export function closeFeed(sessionCode) {
  const feed = feeds.get(sessionCode);
  if (!feed) return;
  stopPushing(sessionCode);
  for (const frame of feed.frames) index.delete(frame.rand);
  feeds.delete(sessionCode);
}

// A student phone hands in what it scanned. Returns { ok: true, sessionCode } or { ok: false, error, need? }.
export function redeemFrames(list) {
  const expired = { ok: false, error: 'invalid_or_expired_token' };
  if (!Array.isArray(list)) return expired;
  const now = Date.now();
  let sessionCode = null;
  const seqs = new Set();
  for (const raw of [...new Set(list.map(String))].slice(0, 8)) {
    const match = FRAME_RE.exec(raw);
    const entry = match && index.get(match[3]);
    if (!entry || entry.seq.toString(36) !== match[2] || now - entry.issuedAt > FRAME_LIFETIME_MS) continue;
    if (sessionCode && sessionCode !== entry.sessionCode) return expired;
    sessionCode = entry.sessionCode;
    seqs.add(entry.seq);
  }
  if (!sessionCode) return expired;
  const sorted = [...seqs].sort((a, b) => a - b);
  for (let i = 0; i + FRAMES_REQUIRED <= sorted.length; i++)
    if (sorted[i + FRAMES_REQUIRED - 1] - sorted[i] <= FRAMES_REQUIRED - 1 + SKIP_ALLOWED)
      return { ok: true, sessionCode };
  return { ok: false, error: 'need_more_frames', need: FRAMES_REQUIRED };
}

// Frames of a feed nobody is asking about any more must not sit in memory.
setInterval(() => {
  const now = Date.now();
  for (const [code, feed] of feeds) {
    prune(feed, now);
    if (!feed.frames.length && !feed.timer) feeds.delete(code);
  }
}, 10_000).unref();
