# Architecture

## Attendance flow

```mermaid
flowchart TD
    Faculty[Faculty browser] -->|Start session| API[Node.js HTTPS server<br/>Express API]
    API -->|Create session and attendance rows| DB[(SQLite)]
    API -->|QR token| Faculty

    Student[Student browser] -->|Scan QR| API
    API -->|Validate token and session eligibility| Student
    Student -->|Check face locally in browser| Student
    Student -->|Submit verified mark| API
    API -->|Record present and method| DB
    API -->|Socket.io attendance update| Faculty
    API -->|Refresh notification| Student

    Faculty -->|Manual changes and submit| API
    API -->|Finalize attendance| DB

    CCTV[Optional Python CCTV service] -->|Recognition results for faculty review| Faculty
    Faculty -->|Confirm CCTV results| API
```

The Node.js server serves the frontend and API, stores session and attendance data in SQLite, and sends live updates over Socket.io. QR face checks run on the student's device; the server records the mark after the browser submits it. The optional CCTV service is separate from the QR flow, and its recognition results are reviewed by faculty before the session is finalized.
