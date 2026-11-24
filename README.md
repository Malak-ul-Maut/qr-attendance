<div align="center">

<img src="frontend/public/icons/brand-mark.svg" alt="Smart Attendance Marker logo" width="96" />

# Smart Attendance Marker

**Scan. Verify. Present.**

Timetable-driven classroom attendance: live rotating QR codes, in-browser face verification and optional CCTV recognition.

![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.12-green)
![Database](https://img.shields.io/badge/database-SQLite-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

<img src="docs/screenshots/hero.jpg" alt="Faculty live session showing a rotating QR code, and a student's phone scanning it" width="800" />

</div>

---

## Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [How attendance is marked](#how-attendance-is-marked)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [CCTV recognition (optional)](#cctv-recognition-optional)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Privacy and security](#privacy-and-security)
- [License](#license)

---

## Why this exists

Roll calls waste lecture time, and a plain QR code can be photographed and passed around. This project closes both gaps. The QR code **rotates every half second**, a student must hand in several consecutive frames, and a **face check on the student's own phone** (detection, liveness, recognition) confirms the person at the screen is the enrolled student. For rooms with a camera, an optional CCTV service can recognise the class and hand the faculty a list to review.

---

## Features

### Students

- **Today** and **Week** views built from the published timetable; double lectures show as one block.
- Mark attendance by scanning the QR code on the classroom screen, then passing a face check.
- Per-subject attendance with dated records, measured against the 75% line.
- Self-service face enrolment: one photo per pose, with live on-screen guidance.
- Change password from the account menu.

### Faculty

- Start a **Regular** session from the timetable, or an **Extra** session (extra classes, borrowed periods, merged classes). Extra only offers classes the faculty member teaches.
- Live roster with a present count, a full-screen QR for projecting, and manual add/remove.
- Run CCTV recognition, review the result, then submit. Discarding a session needs confirmation and is always logged.
- A running session survives a page refresh.
- Server-side session history with present and absent lists.

### Admin

- **Home**: analytics (average attendance, trend, sessions by method, face-photo progress).
- **Setup**: term setup wizard, classes, rooms, subjects, faculty, students, batches.
- **Timetable**: grid editor with conflict detection, draft and published versions, print.
- **Face photos**: review each student's photos and approve or reject them.
- Bulk CSV import for students, faculty and timetable.
- Reset passwords, or bulk-generate them and download a CSV.

### Platform

- Runs on the college network, with optional public access through a tunnel (ngrok, cloudflared or zrok) or Cloudflare.
- Real-time updates over Socket.io.
- SQLite storage: no database server to run.
- White-label ready: college name and logo live in one config file.

---

## How attendance is marked

| Method            | What happens                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **QR + face**     | The faculty screen shows a rotating QR code. The student scans it on their phone, then a face check runs before the mark is accepted. |
| **CCTV**          | An optional Python service recognises faces in classroom camera footage and queues the result for the faculty to review.      |
| **Manual**        | The faculty member adds or removes a student by hand.                                                                          |

### The student's view

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/student-today.png" width="200" alt="Today view" /><br /><sub>1. Today</sub></td>
    <td align="center"><img src="docs/screenshots/student-qr-scan.png" width="200" alt="Scanning the QR code" /><br /><sub>2. Scan the QR</sub></td>
    <td align="center"><img src="docs/screenshots/student-face-verify.png" width="200" alt="Face verification with liveness" /><br /><sub>3. Verify face</sub></td>
    <td align="center"><img src="docs/screenshots/student-marked.png" width="200" alt="Attendance marked" /><br /><sub>4. Done</sub></td>
  </tr>
</table>

### What stops proxy attendance

- **Rotating frames.** The QR changes every `QR_FRAME_MS` (500 ms). A frame stays redeemable for `QR_FRAME_LIFETIME_MS` (4 s), and the phone must submit `QR_FRAMES_REQUIRED` different frames (default 2). A photo of the screen is not enough.
- **Face check on the phone.** Quality, liveness and a recognition match of at least 0.45 against the student's approved enrolment.
- **One-time ticket.** After the QR step the server issues a ticket valid for 6 minutes. It is consumed when the mark is saved.
- **Device fingerprint.** If the same camera fingerprint appears on another student in the same session, the second attempt is refused (`duplicate_device_entry`).
- **Roster checks.** The student must be active, on the class roster, face-approved and not already marked.

Full message flow: [QR and face sequence](docs/diagrams/sequence-qr-face.png) · [CCTV sequence](docs/diagrams/sequence-camera.png).

---

## Screenshots

### Sign in

| Homepage                                 | Login                              |
| ---------------------------------------- | ---------------------------------- |
| ![Homepage](docs/screenshots/homepage.jpg) | ![Login](docs/screenshots/login.jpg) |

### Faculty

| Start a session                                  | Extra session (borrowing periods)                              |
| ------------------------------------------------ | -------------------------------------------------------------- |
| ![Session setup](docs/screenshots/faculty-setup.jpg) | ![Extra session](docs/screenshots/faculty-extra-session.jpg) |

| Live session with rotating QR                    | Add students manually                                           |
| ------------------------------------------------ | --------------------------------------------------------------- |
| ![Live session](docs/screenshots/faculty-live-qr.jpg) | ![Add manually](docs/screenshots/faculty-add-manually.jpg) |

| CCTV result, ready for review                    |
| ------------------------------------------------ |
| ![CCTV](docs/screenshots/faculty-cctv.jpg)       |

### Admin

| Home analytics                                 | Term setup                                       |
| ---------------------------------------------- | ------------------------------------------------ |
| ![Admin home](docs/screenshots/admin-home.jpg) | ![Setup](docs/screenshots/admin-setup.jpg)       |

| Timetable                                            | Face photo review                                          |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| ![Timetable](docs/screenshots/admin-timetable.jpg)   | ![Face photos](docs/screenshots/admin-face-photos.jpg)     |

### Student (mobile)

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/student-attendance.png" width="220" alt="Attendance by subject" /><br /><sub>Attendance by subject</sub></td>
    <td align="center"><img src="docs/screenshots/student-face-enrol.png" width="220" alt="Pose-guided face enrolment" /><br /><sub>Pose-guided face enrolment</sub></td>
  </tr>
</table>

---

## Architecture

Three tiers plus a data store. The browser does the face check; the Node server owns sessions, QR frames and the database; a separate Python service handles CCTV recognition.

![Architecture](docs/diagrams/arch.png)

| Tier        | Technology                                                                 |
| ----------- | -------------------------------------------------------------------------- |
| Client      | HTML, CSS, JavaScript. Face engine in a Web Worker on ONNX Runtime Web (SCRFD-500M detector, MiniFASNet liveness, w600k_mbf recognizer). |
| Application | Node.js, Express, Socket.io                                                |
| Recognition | Python, FastAPI, SCRFD detector, AdaFace IR-101 recogniser, OpenVINO or ONNX Runtime |
| Data        | SQLite, plus a folder-based face gallery                                   |

<details>
<summary><b>More diagrams</b> (use cases, data flow, classes, database, activity)</summary>

#### Use cases

| Student | Faculty | Admin |
| ------- | ------- | ----- |
| ![Student use cases](docs/diagrams/uc-student.png) | ![Faculty use cases](docs/diagrams/uc-faculty.png) | ![Admin use cases](docs/diagrams/uc-admin.png) |

#### Data flow

| Level 0 | Level 1 |
| ------- | ------- |
| ![DFD level 0](docs/diagrams/dfd0.png) | ![DFD level 1](docs/diagrams/dfd1.png) |

#### Sequence diagrams

| QR + face attendance | CCTV attendance |
| -------------------- | --------------- |
| ![QR and face sequence](docs/diagrams/sequence-qr-face.png) | ![CCTV sequence](docs/diagrams/sequence-camera.png) |

#### Student marks attendance (activity)

![Activity diagram](docs/diagrams/activity-student-marks.png)

#### Class diagrams

| Domain model | Modules by tier |
| ------------ | --------------- |
| ![Class diagram 1](docs/diagrams/class1.png) | ![Class diagram 2](docs/diagrams/class2.png) |

#### Database (ER)

![ER diagram](docs/diagrams/ER.png)

</details>

---

## Quick start

### Prerequisites

- [Node.js 20.12 or later](https://nodejs.org/)
- [Git](https://git-scm.com/)
- Python 3, **only** if you want CCTV recognition (see [below](#cctv-recognition-optional))

### 1. Clone and install

```bash
git clone https://github.com/Malak-ul-Maut/qr-attendance.git
cd qr-attendance
npm install
```

Working in a team? After `npm install`, see [Working as a team](docs/TEAM.md) for the shared demo database and how to share secrets and face data without committing them.

### 2. Download the face-engine files

The browser face check needs a WASM runtime and three ONNX models. They are too large for git, so a script downloads them and checks their size and hash:

```bash
npm run assets
```

Without this step the face check cannot load. See `assets.manifest.json` for the list.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

- Choose a `TUNNEL` value (`none` is fine for a first run on your LAN). If you use ngrok, also set `NGROK_AUTHTOKEN`.
- Set `ADMIN_SESSION_SECRET` to a long random string so people stay signed in after a restart. Generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

See [Configuration](#configuration) for everything else.

### 4. Start the server

```bash
npm start
```

On a team, run `npm run demo-db` first to get the shared demo database (see [Working as a team](docs/TEAM.md)). Otherwise, on the very first start there is no database yet, so the server builds `backend/db/database.db` from `backend/db/schema.sql` and creates one admin account. **Copy the password it prints; it is shown only once.**

```
No database found, so a new one was created from backend/db/schema.sql.

First admin account:  username: admin
                      password: <random, shown once>
...
Serving the frontend from frontend (source)
🚀 Server running at https://<your-ip>:4000
Tunnel established at: https://<your-tunnel-address>
```

Want to choose the admin yourself? Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` before the first start. They are used only when the database is created. To start over, stop the server and delete `backend/db/database.db`.

The server also creates a local certificate authority and a self-signed certificate on first run, so your browser will show a warning on the local address. This is expected. Phones need HTTPS to open the camera, which is why the certificate exists.

The certificate authority is kept between runs so it only has to be trusted once:

| System  | Location                                                  | Trusting it (optional, this computer only)                                  |
| ------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\qr-attendance-ca.crt`                     | Added to your trusted roots automatically (Windows asks you to confirm).    |
| macOS   | `~/Library/Application Support/qr-attendance/`            | The server prints a `sudo security add-trusted-cert …` command to run.      |
| Linux   | `~/.local/share/qr-attendance/` (or `$XDG_DATA_HOME`)     | The server prints the commands for system, Chrome and Firefox trust stores. |

Set `QR_ATTENDANCE_CERT_DIR` to keep it somewhere else. Phones always show a warning once, whatever you do here.

### 5. Open it

| Address                  | Use                              |
| ------------------------ | -------------------------------- |
| `https://<your-ip>:4000` | Same Wi-Fi or LAN as the server  |
| The tunnel address       | Anywhere, if a tunnel is enabled |

Sign in from the homepage as a student, faculty member or admin.

### 6. Set up your college

Sign in as **Admin** with the account from step 4, then use **Setup → Term setup wizard** to add the term, periods, rooms, subjects, classes and people (or **Import CSV**). Publish a timetable and faculty can start sessions.

------------------------ | -------------------------------- |
| `https://<your-ip>:4000` | Same Wi-Fi or LAN as the server  |
| The tunnel address       | Anywhere, if a tunnel is enabled |

Sign in from the homepage as a student, faculty member or admin.

---

## Configuration

All settings are environment variables loaded from `.env` when the server starts. [`.env.example`](.env.example) lists every server, tunnel, QR, face-enrolment and CCTV setting with its default and a short description. Copy it to `.env`, then uncomment only what you want to change.

The settings most people touch:

| Variable                | Default | What it does                                                                          |
| ----------------------- | ------- | ------------------------------------------------------------------------------------- |
| `PORT`                  | `4000`  | HTTPS port.                                                                           |
| `TUNNEL`                | `ngrok` | `ngrok`, `cloudflared`, `zrok` or `none`. ngrok needs `NGROK_AUTHTOKEN`.              |
| `ADMIN_SESSION_SECRET`  | random  | Signs login tokens. Set it so everyone stays signed in after a restart.               |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / random | First start only: the admin account created with a new database. |
| `QR_FRAME_MS`           | `500`   | How often the QR changes.                                                             |
| `QR_FRAMES_REQUIRED`    | `2`     | Different frames a phone must submit (1 to 4). `1` allows photos again; `3` is stricter. |
| `CCTV_SPAWN_SERVICE`    | `true`  | Set `false` to skip the Python service.                                               |
| `CCTV_SOURCE`           | `clip`  | `clip` (test video), `live` (room camera) or `auto`.                                  |

> `.env` holds secrets such as your ngrok token. It must never be committed (see [Privacy and security](#privacy-and-security)).

---

## CCTV recognition (optional)

QR and in-browser face attendance work without this. Skip it unless you want camera-based recognition.

```bash
python -m venv venv
venv\Scripts\activate        # macOS/Linux: source venv/bin/activate
pip install -r backend/recognition/requirements.txt
```

- **Python version.** Use a recent Python 3. If `pip` cannot find a wheel for `onnxruntime` or `insightface`, try an older minor version.
- **Models.** The SCRFD detector and AdaFace recogniser go into `backend/models/`. `npm run assets` fetches them, and the service can also download them with `gdown` on first run.
- **Speed.** On an Intel machine, `openvino` (already in `requirements.txt`) is faster than plain ONNX Runtime. `CCTV_BACKEND=auto` falls back automatically.
- **Memory.** The service is memory-hungry. Set `CCTV_SPAWN_SERVICE=false` when you do not need it, or run `python backend/recognition/server.py` yourself (even on another machine) and point `CCTV_SERVICE_URL` at it.
- **Source.** Use `CCTV_SOURCE=clip` with a test video while developing, and `live` for a real camera. Each room has a camera address, which the server passes to the recognition service when the faculty runs a scan.
- **Review before submit.** CCTV marks are provisional. The faculty sees the recognised list (below), adds or removes students, and only then submits.

![CCTV result with recognised students](docs/screenshots/faculty-cctv.jpg)

---

## Deployment

### Option A: LAN only

Set `TUNNEL=none` and run `npm start`. Everyone must be on the same network.

### Option B: tunnel

Set `TUNNEL` to `ngrok`, `cloudflared` or `zrok`. The tunnel address is printed on start. A reserved name or domain keeps it stable. `npm run host` shares the server through zrok with a fixed name.

### Option C: Cloudflare for the frontend, tunnel for the API

The build outputs an optimised `frontend-dist/` folder. A Cloudflare Worker serves it and forwards `/api/*`, `/results/*` and `/socket.io/*` to your tunnel.

```bash
npm run build -- --proxy=https://<your-tunnel-address> --assets=https://cdn.jsdelivr.net/gh/<user>/<repo>@<tag>/frontend
cd pages-worker
npx wrangler@latest deploy
```

- The three large face-engine files (WASM and models) are **not** bundled. They load from the CDN given in `--assets`, so tag a release and push it first, and make sure users can reach that CDN.
- Update `ORIGIN` in `pages-worker/wrangler.jsonc` to your tunnel address.
- To test the built site locally, set `SERVE_DIST=1` in `.env`, then run `npm start`.

---

## Project structure

```
backend/
  index.js            Express + HTTPS + Socket.io entry point
  routes/             REST API: auth, session, attendance, cctv, student, faculty, admin/*
  services/           QR feed, scan tickets, timetable, face gallery, embeddings
  utils/              Signed tokens, role guards, HTTPS certificate, tunnels
  db/                 schema.sql, demo.db (anonymised sample data) and the SQLite database
  recognition/        Optional Python (FastAPI) CCTV recognition service
frontend/             Plain HTML, CSS and JS pages (student, faculty, admin) and the face engine
scripts/              Asset download, demo database, frontend build, recognition benchmarks
pages-worker/         Cloudflare Worker for Option C
docs/                 Team guide (TEAM.md), screenshots and diagrams used in this README
LICENSE               MIT licence
```

---

## Privacy and security

This system stores biometric data about students. Read this section before deploying it for real users.

- **Face data.** Enrolment photos are saved as image files in the gallery folder (`backend/data/gallery/` by default). Each student's face embedding is stored in the `students.face_embedding` column. A photo set is used for attendance only after an admin approves it. Admins can reset a student's face data, and the reset is logged with a reason. Get your institution's consent and retention policy in place before collecting photos.
- **Passwords are stored in plain text.** Login compares the stored value directly, and student, faculty and imported accounts start with the default password `password`. Students on the default password are prompted to change it, but faculty are not, and the app has no screen for an admin to change their own password. The first admin gets a random password instead of the default. Hashing passwords is the most important improvement before any public deployment.
- **Tokens.** Sign-in tokens are HMAC-signed and carry a role, so a student token cannot be used as an admin token. Admin tokens last 8 hours. Set `ADMIN_SESSION_SECRET`; otherwise a random secret is generated at start-up and everyone is signed out on every restart.
- **Network.** The server uses a locally generated, self-signed certificate. CORS is open (`*`), so keep the server behind a tunnel or firewall you trust.
- **Keep secrets and data out of git.** `.env` (it holds your tunnel token and session secret) and `backend/db/database.db` (it holds student records and attendance) are listed in `.gitignore`. The database also holds the addresses, with logins, of any CCTV cameras you configure. Teams share a database with all personal data removed (`backend/db/demo.db`) and keep face photos and videos in a private location. [Working as a team](docs/TEAM.md) explains how, and what to do if something private was committed earlier.
- **Reporting a vulnerability.** Open an issue on the [GitHub issue tracker](https://github.com/Malak-ul-Maut/qr-attendance/issues). Describe the problem and where it is, but keep working exploit details, real student data and credentials out of the public issue.

---

## License

Released under the [MIT License](LICENSE). 
