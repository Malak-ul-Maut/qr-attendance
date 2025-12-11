const loginBtn = document.getElementById('loginBtn');
const endBtn = document.getElementById('endSessionBtn');

const timerDisplay = document.getElementById('timer');
const studentList = document.getElementById('studentList');
const studentCount = document.getElementById('studentCount');

const finalizeModal= document.getElementById('finalizeModal');
const finalizeList= document.getElementById('finalizeList');
const finalizeSubmitBtn = document.getElementById('finalizeSubmitBtn');


let qrTimer = null;
let sessionId = null;

// Display user and subject name
const userName = document.querySelector('.user-name b');
userName.textContent = getCurrentUser().name || 'Teacher';

const subjectName = document.querySelector('#sub-name');
subjectName.textContent = getCurrentUser().subName;


 // --------------- Socket initialization -------------
 initializeSocket();

 function initializeSocket() {
  const socket = io(location.origin);

  socket.on('connect', () => {
    socket.emit('register_teacher');
  });

  socket.on('attendance_update', data => {
    if (sessionId && data.sessionId !== sessionId) {
      console.log('Ignoring attendance for another session:', data.sessionId);
      return;
    }
    const li = document.createElement('li');
    li.textContent = `${data.studentId} (${data.time})`;
    studentList.appendChild(li);
    li.scrollIntoView();
    studentCount.textContent = `Present: ${studentList.children.length}`;
  });

  // socket.on('session_finalized', (payload) => {
  //   if(payload.sessionId === sessionId) alert('Session finalized by teacher.');
  // });
}


// ------------- Event handlers ---------------

// Start session
const startBtn = document.querySelector('#startSessionBtn');

startBtn.addEventListener('click', async (event) => {
  const courseId = document.querySelector('#courseId').value;
  const teacherId = getCurrentUser().username;

  try {
    const response = await postData('/api/session/start', { courseId, teacherId });
    sessionId = response.sessionId;

    document.getElementById('beforeStart').style.display = 'none';
    document.getElementById('afterStart').style.display = 'flex';

    renderQR(response);

    const afterStart = document.querySelector('#afterStart');
    const canvas = document.querySelector('canvas');
    const liveSection = document.querySelector('.live-section');
    const toggleFullScreenBtn = document.querySelector('.toggle-fullscreen-btn');
    toggleFullScreenBtn.addEventListener('click', ()=> {
      toggleFullScreen(afterStart, canvas, liveSection);
    });

    // Schedule token refresh
    if (qrTimer) clearInterval(qrTimer);
    qrTimer = setInterval(async () => {
      try{
        const tokenData = await postData('/api/session/token', { sessionId });
        if (!tokenData.ok) return console.warn('Token refresh failed:', tokenData);
        renderQR(tokenData); 

      } catch (e) {
        console.error('Token refresh error:', e);
      }
    }, 500);   
        
  } catch (err) {
    console.error('Start session error:', err);
    alert('Failed to start session');
  }
});


// End session and open review modal
endBtn.addEventListener('click', async () => {
  if(!sessionId) return alert('No active session');
  try {
    const response = await postData('/api/session/end', { sessionId });
    if (!response.ok) alert('Failed to end session:' + (response.error || 'unknown'));

    openFinalizeModal(response.records || []);

  } catch (err) {
      console.error('End session error:', err);
      alert('Error ending session');
    }
});


const finalizeCancelBtn = document.getElementById('finalizeCancelBtn');
finalizeCancelBtn.addEventListener('click', ()=> finalizeModal.style.display = 'none');


finalizeSubmitBtn.addEventListener('click', async ()=> {
  const cbs = finalizeList.querySelectorAll('input[type=checkbox]');
  const keep = [];
  cbs.forEach(cb => { if (cb.checked) keep.push(cb.dataset.studentId); });

  try {
    const response = await postData('/api/session/finalize', { sessionId, keepStudentIds: keep });

    if (!response.ok) {
      console.error('Finalize returned error:', data);
      alert('Finalize failed: ' + (data.error || 'unknown'));
    }
    finalizeModal.style.display = 'none';
    
    // clear local UI
    studentCount.textContent = "Present: 0";
    studentList.textContent = '';
    const afterStart = document.getElementById('afterStart');
    const beforeStart = document.getElementById('beforeStart');
    afterStart.style.display = 'none';
    beforeStart.style.display = 'flex';
    sessionId = null;
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }

  } catch (err) {
    console.error('Finalize error:', err);
    alert('Error finalizing attendance');
  }
});



// ------------- Functions ---------------

function renderQR(data) {
  const canvas = document.querySelector('canvas');
  const options = {
    width: canvas.clientWidth,
    height: canvas.clientWidth,
    margin: 2
  }

  QRCode.toCanvas(canvas, data.token, options, err => {
    if (err) return console.error(err);
  });
}

function openFinalizeModal(records) {
  finalizeList.innerHTML = '';
  if (!records || records.length ===0) {
    finalizeList.innerHTML = '(No attendance records for this session)';
    return;
  } 

  records.forEach(r => {
    const div = document.createElement('div');
    div.className = 'student-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.studentId = r.studentId;
    cb.dataset.rowid = r.id;
    const txt = document.createElement('span');

    const localTime = new Date(r.timestamp + 'Z').toLocaleTimeString();
    txt.textContent = ` ${r.studentId} (${localTime})`;
    txt.scrollIntoView();
    div.appendChild(cb);
    div.appendChild(txt);
    finalizeList.appendChild(div);
  });
}
finalizeModal.style.display= 'flex';


function toggleFullScreen(afterStart, canvas, liveSection) {
  if (!document.fullscreenElement) {
    afterStart.classList.add('afterStart-fs');
    canvas.classList.add('canvas-fs');
    liveSection.classList.add('live-section-fs');
    afterStart.requestFullscreen();
  } else {
    afterStart.classList.remove('afterStart-fs');
    canvas.classList.remove('canvas-fs');
    liveSection.classList.remove('live-section-fs');
    document.exitFullscreen();
  }
}