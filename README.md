# 🎓 QR Attendance System

A smart attendance system that allows students to scan dynamic QR codes for marking attendance.  
It supports **token-based session validation**, **device fingerprinting for anti-cheating**, and **real-time teacher updates**.

---

## 🚀 Features

- 📱 **QR Code Attendance** — Each session generates a short-lived QR code.
- 🔐 **Secure Verification** — Tokens expire automatically within seconds.
- 🧠 **Device Fingerprinting** — Prevents multiple entries from the same camera/device.
- ⚡ **Auto QR Refresh** — Tokens refresh every few seconds for high security.
- 🧾 **SQLite Database** — Lightweight and portable for classroom use.
- 🧍‍♂️ **Live Teacher Dashboard** — Teachers can view updates instantly.

---

## 🧩 Project Structure

```

qr-attendance/
│
├── backend/
│   ├── index.js              # Main Express server
│   ├── db.js                 # SQLite database setup
│   ├── package.json          # Node dependencies
│   └── attendance.db         # (Auto-created)
│
└── frontend/
├── index.html            # Main student UI
├── student.js            # Scanner logic & API requests
├── style.css             # (Optional) Custom styling

````

---

## 🛠️ Setup Instructions

### 1️⃣ Clone the Repository
Open a terminal and run:
```bash
git clone https://github.com/<your-username>/qr-attendance.git
cd qr-attendance/backend
````

### 2️⃣ Install Dependencies

```bash
npm install
```

### 3️⃣ Create a `.env` File (optional)

If you want to configure a custom port or DB path:

```
PORT=4000
DB_PATH=attendance.db
```

### 4️⃣ Run the Server

```bash
node index.js
```

You should see:

```
Server running on http://localhost:4000
Database connected
```

### 5️⃣ Open Frontend

Now open the frontend file in a browser:

```
qr-attendance/frontend/index.html
```

✅ You should be able to:

* Enter your student ID
* Scan QR codes
* Get success/error messages in real-time

---

## 💾 Database Notes

The database (`attendance.db`) is **automatically created** in `/backend` the first time you run the server.

If you don’t see the file, check your permissions or re-run:

```bash
node db.js
```

---

## ⚡ Common Issues

| Problem                    | Cause                      | Fix                                       |
| -------------------------- | -------------------------- | ----------------------------------------- |
| `Camera not accessible`    | Browser blocked permission | Allow camera access manually              |
| `invalid_or_expired_token` | QR expired                 | Scan the latest QR again                  |
| `duplicate_entry`          | Same device used again     | Device fingerprint matched                |
| `Error: db_error`          | DB locked or corrupted     | Delete `attendance.db` and restart server |

---

## 🔒 Security Notes

* The system uses **camera fingerprinting** (hashed camera IDs) to identify devices.
* Tokens are short-lived and cannot be reused.
* Teacher dashboards are notified via WebSocket in real time.

---

## 🧑‍💻 Developers

* **Project Lead:** Ali भाई
* **Backend:** Node.js (Express, SQLite3)
* **Frontend:** HTML, CSS, JS, jsQR
* **Security:** Token-based verification + device fingerprinting

---

## 🌱 Future Improvements

* Add login system for teachers/students
* Store camera fingerprints in DB (for analytics)
* Style the UI with Tailwind or Bootstrap
* Deploy using Render / Railway

---

### 🧾 License

MIT License © 2025 — QR Attendance System by Ali भाई 
