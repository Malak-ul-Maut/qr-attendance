const loginBtn = document.getElementById('loginBtn');
const startBtn = document.getElementById('startSessionBtn');
const endBtn = document.getElementById('endSessionBtn');
const tokenField = document.getElementById('sessionToken');
const qrContainer = document.getElementById('qrCode');
const timerDisplay = document.getElementById('timer');
const studentList = document.getElementById('studentList');
const studentCount = document.getElementById('studentCount');

const finalizeModal= document.getElementById('finalizeModal');
const finalizeList= document.getElementById('finalizeList');
const finalizeSubmitBtn = document.getElementById('finalizeSubmitBtn');
const finalizeCancelBtn = document.getElementById('finalizeCancelBtn');

let teacherLoggedIn = false;
let refreshTimer = null;
let currentSessionId = null;
let socket = null;


// ------------------- Login -------------------
loginBtn.addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const msg = document.getElementById('login-msg');

    try {
        const res = await fetch('http://192.168.1.9:4000/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (data.ok) {
            teacherLoggedIn = true;
            msg.textContent = '';
            document.getElementById('login-section').style.display = 'none';
            document.getElementById('session-section').style.display = 'block';
            initSocket(); // connect after Login
        } else {
            msg.textContent = 'Login failed';
        }
    } catch (err) {
        console.error('Login error:', err);
        msg.textContent = 'Error contacting server';
    }
});


// ------------- Start session ----------------
startBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!teacherLoggedIn) return alert('Login first');

    const courseId = document.getElementById('courseId').value;
    if (!courseId) return alert('Select Course ID');

    try {
        const res = await fetch('http://192.168.1.9:4000/api/session/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseId, teacherId: 'T1' })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'start_failed');
        
        currentSessionId = data.sessionId;
        tokenField.value = data.token;
        endBtn.disabled = false;

        // Render initial QR
        qrContainer.innerHTML = '';
        const canvas = document.createElement('canvas');
        QRCode.toCanvas(canvas, data.token, { width: 200 }, err => {
            if (err) return console.error(err);
            qrContainer.appendChild(canvas);
        });

        // Schedule token refresh
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(async () => {
            try{
                const r = await fetch('http://192.168.1.9:4000/api/session/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentSessionId })
                });
                const tokenData = await r.json();
                if (!tokenData.ok) {
                    console.warn('Token refresh failed:', tokenData);
                    return;
                }
                tokenField.value = tokenData.token;
                // redraw QR with new token
                qrContainer.innerHTML = '';
                const c2 = document.createElement('canvas');
                console.log('Token refresh response:', tokenData);
                QRCode.toCanvas(c2, tokenData.token, { width: 200 }, err => {
                    if (err) return console.error(err);
                    qrContainer.appendChild(c2);
                });   
            } catch (e) {
                console.error('Token refresh error:', e);
            }
        }, 1000);  
        
         
    } catch (err) {
        console.error('Start session error:', err);
        alert('Failed to start session');
    }
});


// End session and open review modal
endBtn.addEventListener('click', async () => {
    if(!currentSessionId) return alert('No active session');
    try {
        const res = await fetch('http://192.168.1.9:4000/api/session/end', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId })
        });
        const data = await res.json();
        if (data.ok) {
            openFinalizeModal(data.records || []);
        } else {
            alert('Failed to end session:' + (data.error || 'unknown'));
        } 
    } catch (err) {
            console.error('End session error:', err);
            alert('Error ending session');
        }
});

function openFinalizeModal(records) {
    finalizeList.innerHTML = '';
    if (!records || records.length ===0) {
        finalizeList.innerHTML = '<p>No attendance records for this session</p';
    } else {
        records.forEach(r => {
            const div = document.createElement('div');
            div.className = 'student-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            cb.dataset.studentId = r.studentId;
            cb.dataset.rowid = r.id;
            const txt = document.createElement('span');
            txt.textContent = ` ${r.studentId} (${r.timestamp})`;
            div.appendChild(cb);
            div.appendChild(txt);
            finalizeList.appendChild(div);
        });
    }
    finalizeModal.style.display= 'flex';
}
finalizeCancelBtn.addEventListener('click', ()=> finalizeModal.style.display = 'none');

finalizeSubmitBtn.addEventListener('click', async ()=> {
    const cbs = finalizeList.querySelectorAll('input[type=checkbox]');
    const keep = [];
    cbs.forEach(cb => { if (cb.checked) keep.push(cb.dataset.studentId); });

    try {
        const res = await fetch('http://192.168.1.9:4000/api/session/finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, keepStudentIds: keep }) 
        });
        const data = await res.json();
        if (!data.ok) {
            console.error('Finalize returned error:', data);
            alert('Finalize failed: ' + (data.error || 'unknown'));
        }
        console.log('Finalized. kept: ' + (data.keptCount || keep.length));
        finalizeModal.style.display = 'none';
        
        // clear local UI
        studentList.innerHTML = '';
        studentCount.textContent = 'Present: 0';
        tokenField.value = '';
        qrContainer.innerHTML = '';
        timerDisplay.textContent = '';
        endBtn.disabled = true;
        currentSessionId = null;
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    } catch (err) {
        console.error('Finalize error:', err);
        alert('Error finalizing attendance');
    }
});


 // --------------- Socket initialization -------------
 function initSocket() {
    socket = io('http://192.168.1.9:4000');
    socket.emit('register_teacher');

    socket.on('attendance_update', data => {
        if (currentSessionId && data.sessionId !== currentSessionId) {
            console.log('Ignoring attendance for another session:', data.sessionId);
            return;
        }
        const li = document.createElement('li');
        li.textContent = `${data.studentId} - ${data.courseId} (${data.time})`;
        studentList.appendChild(li);
        studentCount.textContent = `Present: ${studentList.children.length}`;
    });

    socket.on('session_ended', payload => {
        if (payload.sessionId === currentSessionId) {
            endBtn.disabled = true;
        }
    });

    socket.on('session_finalized', (payload) => {
        if(payload.sessionId === currentSessionId) alert('Session finalized by teacher.');
    });
}
