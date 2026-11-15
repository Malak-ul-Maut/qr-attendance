// After a phone has scanned enough frames, the server gives that student a ticket for that one session. The face check
// and the final "mark me present" request use the ticket, so the session code never reaches the phone and a code
// passed around between students is worth nothing. A ticket belongs to one student and works once.
import { randomBytes } from 'crypto';

const TICKET_LIFETIME_MS = 6 * 60 * 1000; // the face check can take a few tries
const tickets = new Map(); // ticket -> { username, sessionCode, expiresAt }

export function issueTicket(username, sessionCode) {
  for (const [ticket, t] of tickets)
    if (t.username === username && t.sessionCode === sessionCode) tickets.delete(ticket); // newest scan wins
  const ticket = randomBytes(18).toString('base64url');
  tickets.set(ticket, { username, sessionCode, expiresAt: Date.now() + TICKET_LIFETIME_MS });
  return ticket;
}

// { sessionCode } when the ticket is this student's and still valid, otherwise null.
export function peekTicket(ticket, username) {
  const t = tickets.get(String(ticket ?? ''));
  if (!t || t.username !== username || t.expiresAt <= Date.now()) return null;
  return { sessionCode: t.sessionCode };
}

export function consumeTicket(ticket) {
  tickets.delete(String(ticket ?? ''));
}

setInterval(() => {
  const now = Date.now();
  for (const [ticket, t] of tickets) if (t.expiresAt <= now) tickets.delete(ticket);
}, 60_000).unref();
