# 🎓 QR Attendance System

![live-updates](https://drive.google.com/uc?export=view&id=1jPQ8bebqDM4vPXtg2sM6cjdevWu6SRIO)

The QR Code Attendance System is an efficient, fast and user-friendly tool for tracking attendance using QR codes. It utilizes HTML, CSS, and JavaScript to create a web-based interface for marking attendance. This system is designed to work seamlessly when devices are connected to the Same College Local Network.

The faculty can display the QR Code using classroom projector so that present students can scan and mark their attendance.

---

## Features

- **Automatic IP Fetching** — It fetch your IPv4 address automatically and Generate a QR code based on that IP to enable connections within the classroom.
- **Live Faculty Dashboard** — Enables faculty to view live attendance updates and remove proxy attendances based on count.
- **Device Fingerprinting** — Prevents multiple entries from the same camera/device.
- **Auto QR Refresh** — Tokens refresh every few seconds for high security.
- **SQLite Database** — Lightweight and portable for classroom use.

---

## Prerequisites

Before you begin, ensure you have the following prerequisites installed:

- **Nodejs**: Install the Windows installer(.msi) version from their [official website](https://nodejs.org/en/download/current).
- **Git**: Install from their [official website](https://git-scm.com/install/windows)

---

## 🛠️ Setup Instructions

### 1. Clone the Repository:

Open Command Prompt and run

```bash
git clone https://github.com/Malak-ul-Maut/qr-attendance.git
```

### 2. Navigate to the project directory:

```bash
cd qr-attendance
```

### 3. Install dependencies:

```bash
npm install
```

### 4. Start the server

```bash
npm start
```

You should see:

```
Connected to SQLite database
🚀 Server running at https://<Your_IPv4_Address>:4000
Tunnel established at: https://<random-subdomain>.ngrok-free.dev
```

### 4. Access the system

Open your web browser and go here to use the system

```bash
https://<Your_IPv4_Address>:4000 (local url)
https://<random-subdomain>.ngrok-free.dev (public url)
```

You should be able to:

- Login via the homepage
- Generate/Scan QR Codes
- Get success/error messages in real-time

---

## Snapshots

### 1) Homepage

![homepage](https://drive.google.com/uc?export=view&id=184EjrayFAfLnT-Dsy_IcWlzNqsYi9yVi)

### 2) Instant scan validation

![student scan](https://drive.google.com/uc?export=view&id=13IhQNSxQ0qyK5ljF2H-yWKMMiD6iE23A)

### 3) Finalize window

![finalize-window](https://drive.google.com/uc?export=view&id=1fLhGirxZk1jJXwQoZXeC-uB5ypDu6hF2)

---

## Developers

- **Project Lead:** Ahad Ali
- **Backend:** Node.js (Express, SQLite3)
- **Frontend:** HTML, CSS, JS, jsQR
- **Security:** Token-based verification + device fingerprinting

---

## Future Improvements

- Add identity verification via face recognization
- Add attendance history section
- Add analytics based on user behaviour

---

### 🧾 License

MIT License © 2025 — QR Attendance System by Ahad Ali
