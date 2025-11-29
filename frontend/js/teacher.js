const loginBtn = document.getElementById('loginBtn');
const startBtn = document.getElementById('startSessionBtn');
const endBtn = document.getElementById('endSessionBtn');

const timerDisplay = document.getElementById('timer');
const studentList = document.getElementById('studentList');
const studentCount = document.getElementById('studentCount');

const finalizeModal= document.getElementById('finalizeModal');
const finalizeList= document.getElementById('finalizeList');
const finalizeSubmitBtn = document.getElementById('finalizeSubmitBtn');
const finalizeCancelBtn = document.getElementById('finalizeCancelBtn');
const qrContainer = document.getElementById('qrCode');
const subjectName = document.getElementById('sub-name');

if (!window.__API_BASE) {
    window.__API_BASE = (location.protocol && location.protocol.startsWith('http') ? location.origin : 'https://192.168.1.16:4000');
}
const url = window.__API_BASE;

let refreshTimer = null;
let currentSessionId = null;
let socket = null;

// Display user name
document.querySelector('.user-name b').textContent = getCurrentUser().name || 'Teacher';
subjectName.textContent = getCurrentUser().subName;



 // --------------- Socket initialization -------------
 function initSocket() {
    socket = io(url);

    socket.on('connect', () => {
        socket.emit('register_teacher');
    });

    socket.on('attendance_update', data => {
        if (currentSessionId && data.sessionId !== currentSessionId) {
            console.log('Ignoring attendance for another session:', data.sessionId);
            return;
        }
        const li = document.createElement('li');
        li.textContent = `${data.studentId} (${data.time})`;
        studentList.appendChild(li);
        li.scrollIntoView();
        studentCount.textContent = `Present: ${studentList.children.length}`;
    });

    socket.on('session_finalized', (payload) => {
        if(payload.sessionId === currentSessionId) alert('Session finalized by teacher.');
    });
}

initSocket();



// ------------- Event handlers ---------------

// Start session
startBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    const courseId = document.getElementById('courseId').value;
    if (!courseId) return alert('Select Course ID');

    try {
        // Attach the logged-in teacher's username as teacherId when available
        let teacherIdToSend = 'T1';
        try {
            const user = (typeof getCurrentUser === 'function') ? getCurrentUser() : null;
            if (user && user.role === 'faculty') {
                teacherIdToSend = user.username || user.loginId || teacherIdToSend;
            }
        } catch (e) {
            // fallback to T1 if anything goes wrong
        }

        const res = await fetch(`${url}/api/session/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseId, teacherId: teacherIdToSend })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'start_failed');
        currentSessionId = data.sessionId;
        document.getElementById('beforeStart').style.display = 'none';
        document.getElementById('afterStart').style.display = 'flex';

        renderQR(data);

        // Schedule token refresh
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(async () => {
            try{
                const r = await fetch(`${url}/api/session/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentSessionId })
                });
                const tokenData = await r.json();
                if (!tokenData.ok) {
                    console.warn('Token refresh failed:', tokenData);
                    return;
                }

                renderQR(tokenData); 
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
        const res = await fetch(`${url}/api/session/end`, {
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

finalizeCancelBtn.addEventListener('click', ()=> finalizeModal.style.display = 'none');

finalizeSubmitBtn.addEventListener('click', async ()=> {
    const cbs = finalizeList.querySelectorAll('input[type=checkbox]');
    const keep = [];
    cbs.forEach(cb => { if (cb.checked) keep.push(cb.dataset.studentId); });

    try {
        const res = await fetch(`${url}/api/session/finalize`, {
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
        studentCount.textContent = "Present: 0";
        studentList.textContent = '';
        const afterStart = document.getElementById('afterStart');
        const beforeStart = document.getElementById('beforeStart');
        afterStart.style.display = 'none';
        beforeStart.style.display = 'flex';
        currentSessionId = null;
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    } catch (err) {
        console.error('Finalize error:', err);
        alert('Error finalizing attendance');
    }
});



// ------------- Functions ---------------

function renderQR(data) {
    const parentQr = qrContainer.parentElement;
    const desiredWidth = parentQr.offsetWidth * 0.9;

    qrContainer.innerHTML = '';
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, data.token, { width: desiredWidth, height: desiredWidth }, err => {
        if (err) return console.error(err);
        qrContainer.appendChild(canvas);
    });
}

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
            txt.scrollIntoView();
            div.appendChild(cb);
            div.appendChild(txt);
            finalizeList.appendChild(div);
        });
    }
    finalizeModal.style.display= 'flex';
}