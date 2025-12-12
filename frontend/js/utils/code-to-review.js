// This is the unused code from faculty.js

const finalizeModal= document.getElementById('finalizeModal');
const finalizeList= document.getElementById('finalizeList');
const finalizeSubmitBtn = document.getElementById('finalizeSubmitBtn');


const addManuallyBtn = document.querySelector('#add-manually-btn');

addManuallyBtn.addEventListener('click', async() => {
  if(!sessionId) return alert('No active session');
  try {
    const response = await postData('/api/session/end', { sessionId });
    if (!response.ok) alert('Failed to end session:' + (response.error || 'unknown'));

    openFinalizeModal(response.records || []);

  } catch (err) {
    console.error('End session error:', err);
    alert('Error ending session');
    }
})

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
    clearAttendanceUI();

  } catch (err) {
    console.error('Finalize error:', err);
    alert('Error finalizing attendance');
  }
});

function openFinalizeModal(records) {
  finalizeList.innerHTML = '';
  if (!records || records.length ===0) {
    finalizeList.innerHTML = '(No attendance records for this session)';
    finalizeModal.style.display= 'flex';
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
  finalizeModal.style.display= 'flex';
}

function cutStudentName(studentId) {
  const students = studentList.querySelectorAll('span[data-id]');
  const keepStudentIds = [];
  students.forEach(student => { 
    if (student.dataset.id === `${String(studentId)}`) {
      span.classList.add('removed');
    }
  });
  console.log(students);
  
}


{/* <section id="finalizeModal">
  <div id="finalizeContent">
    <p>Review Attendance</p>
    <div id="finalizeList"></div>
    <div class="finalize-buttons">
      <button id="finalizeSubmitBtn">Submit</button>
      <button id="finalizeCancelBtn" class="white-btn">Cancel</button>
    </div>
  </div>
</section> */}

// End session
app.post('/api/session/end', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !sessions[sessionId]) return res.status(400).json({ ok: false, error: 'invalid_session' });

    // Fetch attendance rows for that session (for teacher review)
    db.all(
        `SELECT id, studentId, courseId, timestamp, removed FROM attendance WHERE sessionId = ?`, 
        [sessionId],
        (err, rows) => {
            if (err) {
                console.error('DB Error (fetching attendance on end):', err);
                return res.status(500).json({ ok:false, error:'db_error' });
            }
            
            return res.json({ ok:true, sessionId, records: rows });
        }
    );
});



// #finalizeModal {
//   display: none; /* Dynamically changed to 'flex' by JS */
//   position: fixed;
//   inset: 0;
//   background-color: rgba(0,0,0,0.3);
//   justify-content: center;
//   align-items: center;
//   z-index: 999;
// }
// #finalizeContent {
//   background-image: linear-gradient(to bottom, var(--highlight), var(--bg) );
//   padding: 2rem;
//   border-radius: 16px;
//   width: 324px;
//   text-align: left;
//   box-shadow: 0px 4px 4px #00000030, 0px 12px 12px #00000015;
// }
// #finalizeContent p {
//   font-size: 1.5rem;
//   font-weight: 700;
//   opacity: 0.8;
//   margin: 0;
//   margin-bottom: 1rem;
// }
// .finalize-buttons {
//   margin-top: 16px;
//   display: flex;
//   justify-content: space-around;
// }
// #finalizeSubmitBtn {
//   background-color: #238636;
//   color: #fff;
// }