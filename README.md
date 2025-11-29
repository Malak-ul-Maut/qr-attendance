# 🎓 QR Attendance System

The QR Code Attendance System is an efficient, fast and user-friendly tool for tracking attendance using QR codes. It utilizes HTML, CSS, and JavaScript to create a web-based interface for marking attendance. This system is designed to work seamlessly when devices are connected to the Same College Local Network.

The faculty can display the QR Code using classroom projector so that present students can scan and mark their attendance.

---

## Features

- **Automatic IP Fetching** — It fetch your IPv4 address automatically and Generate a QR code based on that IP to enable connections within the classroom.
- **Faculty Panel** — It has a Faculty View Panel that enables the teacher to remove duplicate or proxy attendances based on count.
- **Device Fingerprinting** — Prevents multiple entries from the same camera/device.
- **Auto QR Refresh** — Tokens refresh every few seconds for high security.
- **SQLite Database** — Lightweight and portable for classroom use.
- **Live Teacher Dashboard** — Teachers can view updates instantly.


---

## Prerequisites
Before you begin, ensure you have the following prerequisites installed:

- **Nodejs**: Install the Windows installer(.msi) version from their [official website](https://nodejs.org/en/download/current). 
- **Git**: It can be installed by running the following command in the Command Prompt (after you've installd Nodejs)
```bash
npm install git
```


## 🛠️ Setup Instructions


### 1️⃣ Clone the Repository
Open Command Prompt and run:
```bash
git clone https://github.com/Malak-ul-Maut/qr-attendance.git
cd qr-attendance/backend
````


### 2️⃣ Run the Server

```bash
node index.js
```

You should see:

```
🚀 Server running at https://<Your_IPv4_Address>:4000
Connected to SQLite database
```

### 3️⃣ Open the website

Now open the frontend website in a browser:

```
https://<Your_IPv4_Address>:4000
```


You should be able to:

* Login via the homepage
* Generate/Scan QR Codes
* Get success/error messages in real-time

---

## Database Notes

The database (`attendance.db`) is **automatically created** in `/backend` the first time you run the server.

If you don’t see the file, check your permissions or re-run:

```bash
node db.js
```

---

## Developers

* **Project Lead:** Ahad Ali 
* **Backend:** Node.js (Express, SQLite3)
* **Frontend:** HTML, CSS, JS, jsQR
* **Security:** Token-based verification + device fingerprinting

---

## Future Improvements

* Add facial verification system 
* Add attendance analytics
* Deploy using Render / Railway

---

### 🧾 License

MIT License © 2025 — QR Attendance System by Ahad Ali
