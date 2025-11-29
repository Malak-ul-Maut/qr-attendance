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


## 🛠️ Setup Instructions

### 1️⃣ Install Nodejs
Official website: https://nodejs.org/en/download/current
Download and install the 'Windows Installer(.msi)' version listed below 

### 2️⃣ Install Git

```bash
npm install git
```

### 3️⃣ Clone the Repository
Open a terminal and run:
```bash
git clone https://github.com/Malak-ul-Maut/qr-attendance.git
cd qr-attendance/backend
````


### 4️⃣ Run the Server

```bash
node index.js
```

You should see:

```
🚀 Server running at https://<Your_IPv4_Address>:4000
Connected to SQLite database
```

### 5️⃣ Open the website

Now open the frontend website in a browser:

```
https://<Your_IPv4_Address>:4000
```

✅ You should be able to:

* Login via the homepage
* Generate/Scan QR Codes
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

* **Project Lead:** Ahad Ali 
* **Backend:** Node.js (Express, SQLite3)
* **Frontend:** HTML, CSS, JS, jsQR
* **Security:** Token-based verification + device fingerprinting

---

## 🌱 Future Improvements

* Add facial verification system 
* Add attendance analytics
* Deploy using Render / Railway

---

### 🧾 License

MIT License © 2025 — QR Attendance System by Ahad Ali
