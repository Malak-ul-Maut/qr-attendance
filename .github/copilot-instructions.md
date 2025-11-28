# QR-Based Attendance System — AI Agent Instructions

## 🎯 Project Overview
A real-time QR attendance system with role-based access (Student, Faculty, Admin), token-based session validation, device fingerprinting for anti-cheating, and live teacher dashboards via Socket.IO.

**Architecture:** Node.js Express backend (`/backend`) + vanilla HTML/CSS/JS frontend (`/frontend`) + SQLite3 database.

---

## 🏗️ Key Architecture Patterns

### Core Data Flow
1. **Teacher Start Session** → Backend generates `sessionId`, creates 3-second JWT token, broadcasts token as QR code
2. **Token Refresh Loop** → Teacher UI refreshes QR every 1 second (calls `/api/session/token`)
3. **Student Scan** → Client-side QR decoder extracts token, posts to `/api/session/verify` with `studentId` + `cameraFingerprint`
4. **Verification** → Backend validates token, checks for duplicates (device + student), records in SQLite, emits via Socket.IO to teacher
5. **Session End** → Teacher finalizes attendance, removes/keeps student entries

### Critical Token Lifecycle
- Tokens expire in **3 seconds** by design (`createSessionToken(sessionId, courseId, 3)`)
- Stored in-memory in `activeTokens` object with auto-cleanup via `setTimeout`
- Each token is a **short 8-char string** (not JWT), not a signed JWT — encoding token directly in QR code
- Token refresh happens **every 1000ms** on teacher UI to maintain valid QR

### Anti-Cheating Mechanisms
- **Camera Fingerprinting**: SHA-256 hash of device camera ID stored with attendance record
- **Duplicate Prevention**: 
  - Cannot scan same session twice from same device (camera fingerprint check)
  - Cannot mark same student twice in session (studentId check)

### Multi-Role Authentication
- Three user tables: `students`, `faculty`, `admins` — hardcoded table selection in `/api/login`
- Plain-text password storage (NO HASHING in current implementation — security concern for production)
- Login returns `role` + `loginId`, client stores in UI state

### Real-Time Teacher Updates
- Socket.IO connection established when teacher registers (`register_teacher` event)
- On each student attendance: broadcast `attendance_update` to all connected teacher sockets
- On session end: broadcast `session_ended` + session records
- On finalize: broadcast `session_finalized` with kept student IDs

---

## 📁 File Structure & Responsibilities

### Backend (`/backend`)
- **`index.js`** (317 lines)
  - Express server with HTTPS (self-signed certs in `cert.pem`, `key.pem`)
  - All API routes: login, session management, token refresh, attendance verification, finalization
  - Socket.IO event handlers for teacher connections
  - In-memory `sessions` map keyed by `sessionId`
  - In-memory `activeTokens` map keyed by short token code
  - Frontend static serving from hardcoded path (⚠️ Windows-specific)

- **`db.js`** (43 lines)
  - SQLite3 initialization with 5 tables: `students`, `faculty`, `admins`, `attendance`, `sessions`
  - Schema created on startup (idempotent via `CREATE TABLE IF NOT EXISTS`)
  - Attendance schema includes: `studentId`, `courseId`, `sessionId`, `cameraFingerprint`, `verified`, `finalized`, `removed`, `timestamp`

- **`generate-cert.js`**
  - Generates self-signed SSL certificates (run once, outputs `cert.pem` + `key.pem`)

- **`package.json`**
  - Key dependencies: `express`, `sqlite3`, `socket.io`, `jsonwebtoken`, `cors`, `body-parser`, `@ngrok/ngrok`
  - Scripts: `start` (node index.js), `dev` (nodemon index.js)

### Frontend (`/frontend`)
- **`homepage.html`** (94 lines) — Role selection landing page (Student/Faculty/Admin)
- **`login-page.html`** — Role-specific login form (query param: `?role=student|faculty|admin`)
- **`student.html`** — Scanner UI with video feed, zoom slider, scan results
- **`teacher.html`** — Teacher dashboard: session controls, live student list, QR display, finalize modal
- **`admin.html`** — Admin panel (minimal content in current version)

- **`js/auth-guard.js`** — Session-based auth protection utility
  - `checkAuthAndRedirect()` — Called at page load to enforce login requirement
  - `getCurrentUser()` — Returns logged-in user object or null
  - `logout()` — Clears session and redirects to homepage
  - Stores auth data in `sessionStorage` as JSON: `{ role, loginId, username }`

- **`js/login-page.js`** — Role-specific login POST to `/api/login`
  - On success, stores user data in `sessionStorage` before redirect
  - Redirects to role-appropriate page (student.html, teacher.html, admin.html)

- **`js/student.js`** (144 lines)
  - Camera access + QR scanning via `jsQR` library
  - SHA-256 hashing for camera fingerprint
  - Fetch to `/api/session/verify` on QR decode
  - Error handling for device duplicates, session inactive, expired tokens

- **`js/teacher.js`** (203 lines)
  - Session lifecycle: start, token refresh loop, end, finalize
  - QR rendering via `qrcode.js` library
  - Socket.IO listener for `attendance_update` + `session_ended` + `session_finalized`
  - Finalize modal: multi-select student checkboxes to keep/remove

- **`css/`** — Styling (general.css, session-section.css, etc.)

---

## 🔌 API Routes Reference

| Endpoint | Method | Body | Response |
|----------|--------|------|----------|
| `/api/login` | POST | `{username, password, role}` | `{ok, role, loginId}` or `{ok:false, error}` |
| `/api/session/start` | POST | `{courseId, teacherId?}` | `{ok, sessionId, token, expiresIn:3}` |
| `/api/session/token` | POST | `{sessionId}` | `{ok, token, expiresIn:3}` |
| `/api/session/verify` | POST | `{studentId, token, cameraFingerprint?}` | `{ok, message, sessionId}` or error |
| `/api/session/end` | POST | `{sessionId}` | `{ok, sessionId, records: []}` |
| `/api/session/finalize` | POST | `{sessionId, keepStudentIds: []}` | `{ok, message, keptCount?}` |

---

## 💾 Database Schema

### attendance table
```sql
id, studentId, courseId, sessionId, cameraFingerprint, 
timestamp, verified, finalized, removed
```
- **finalized=1, removed=0** → kept in final roster
- **finalized=0, removed=1** → removed from final roster
- **cameraFingerprint** → null if device check disabled

### sessions table
```sql
sessionId (PK), courseId, teacherId, startTime, endTime, status
```

---

## 🔧 Development Workflow

### Running the Backend
```powershell
cd backend
npm install
node index.js
# Expected: "Server running at https://192.168.1.15:4000"
```

### Running Frontend
- Open `frontend/login-page.html?role=student` in browser (hardcoded URL points to `https://192.168.1.15:4000`)
- Or access via static route after server starts

### Debugging
- Check browser console for client-side errors (camera access, fetch failures)
- Check server console for DB errors, socket events, token validation
- Use `console.log` statements (no debugging framework configured)

---

## ⚠️ Known Issues & Constraints

1. **Hardcoded Backend URL** — `student.js` + `teacher.js` hardcode `https://192.168.1.15:4000`, must manually change for different hosts
2. **Windows-Specific Path** — `index.js` uses hardcoded Windows path for static frontend: `C:/Users/jiya computer/Desktop/qr-attendance/frontend`
3. **Self-Signed HTTPS** — Requires client-side `.env` handling or browser security bypass
4. **No Password Hashing** — Plain-text passwords in SQLite (security issue)
5. **No Input Validation** — SQL queries vulnerable to injection (use parameterized queries throughout, which are already done correctly)
6. **No Rate Limiting** — `/api/session/verify` can be brute-forced
7. **In-Memory Sessions** — Server restart loses all active sessions + tokens

---

## 🎨 Code Conventions

- **Error Responses**: `{ok: false, error: 'error_code'}` (snake_case error strings)
- **Success Responses**: `{ok: true, ...data}`
- **Variable Naming**: camelCase for JS, snake_case for DB columns + query params
- **Async Patterns**: Promise-based fetch + async/await in student.js; callback-based sqlite3 in index.js
- **Event Names**: lowercase_with_underscore for Socket.IO events (`attendance_update`, `session_ended`)

### Authentication Pattern
- Protected pages (student.html, teacher.html, admin.html) include `auth-guard.js` in `<head>`
- Call `checkAuthAndRedirect()` immediately in script tag to prevent unauthorized access
- Auth data stored in `sessionStorage` as `{role, loginId, username}` (cleared on browser close)
- Login success flow: verify credentials → store auth → redirect to role page
- Logout: call `logout()` to clear session and redirect to homepage

---

## 🚀 Extension Points

**Common tasks:**
- **Add new role**: Add table in `db.js`, table selection in `/api/login`, new HTML file in frontend
- **Change token expiry**: Modify `createSessionToken(sessionId, courseId, 3)` (3 = seconds)
- **Disable camera check**: Remove `cameraFingerprint` param from `/api/session/verify` call
- **Add attendance export**: Create new route `/api/session/:sessionId/export` with DB query + CSV formatting
