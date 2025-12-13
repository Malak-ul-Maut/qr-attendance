import QrScanner from './utils/qr-scanner/qr-scanner.min.js';

const video = document.querySelector('#video');
const scanResult = document.querySelector('#scan-result');
const scannerSection = document.querySelector('#scanner-section');
const mainSection = document.querySelector('main');

let studentName = document.querySelector('.user-name b').textContent = getCurrentUser().name;
let studentId = getCurrentUser().username;



// ------------ Event handlers ---------------
const markAttendanceCard = document.querySelector('#markAttendanceCard');

markAttendanceCard.addEventListener('click', async () => {
  scannerSection.style.display = 'block';
  closeScanBtn.style.display = 'block';
  mainSection.style.display = 'none';
  
  try{  // Access camera
    let currentStream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: 'environment' } 
    });
    video.srcObject = currentStream;
    enableZoom(currentStream);
    scanQRCode(studentId, video);

  } catch (err) {
    alert("Unable to access camera. Make sure you allow permission.");
    return console.error("Camera error:", err);
  }
});


const closeScanBtn = document.querySelector('#closeScanBtn');

closeScanBtn.addEventListener('click', () => {
    scannerSection.style.display = 'none';
    closeScanBtn.style.display = 'none';
    scanResult.textContent = '';
    mainSection.style.display = 'flex';
});



//---------- Functions --------------

async function getCameraId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter(d => d.kind === 'videoinput');

  if (videoInputs.length === 0) return null;

  const preferred = videoInputs.find(d => d.label.toLowerCase().includes('back')) || videoInputs[0];
  return preferred.deviceId;
}


async function scanQRCode(studentId, video) {
  const cameraFingerprint = await getCameraId();
  
  const qrScanner = new QrScanner(video, result => {
    if (navigator.vibrate) navigator.vibrate(40);
    scanResult.textContent = 'Submitting attendance...';
    sendAttendance(studentId, result.data, cameraFingerprint);
    qrScanner.stop();

  }, { returnDetailedScanResult: true });

  await qrScanner.start();
  await video.play();
}


async function sendAttendance(studentId, token, cameraFingerprint) {
  try {
    const response = await postData('/api/session/verify', {studentId, studentName, token, cameraFingerprint });

    if (response.ok) {
      scanResult.textContent = "✔ Attendance marked successfully!";
      scanResult.style.color = '#2e9c17ff';
    } else {
      scanResult.textContent = `⚠︎ Verification failed !!! (${response.error || 'unknown'})`;
      scanResult.style.color = '#b81616';
    }
    
  } catch (err) {
    console.error('Send attendance error:', err);
    scanResult.textContent = 'Error contacting server. Check connection.';
  } 
}


function enableZoom(currentStream) {
  const [track] = currentStream.getVideoTracks();
  const capabilities = track.getCapabilities();
  const settings = currentStream.getVideoTracks()[0].getSettings();
  const zoomSlider = document.querySelector('#zoom-slider');
  const zoomMinus = document.querySelector('.slider-icon.left');
  const zoomPlus = document.querySelector('.slider-icon.right');

  if (!capabilities.zoom || !capabilities.focusMode) return console.warn("Auto-focus/Zoom not supported");

  zoomSlider.style.display = 'block';
  zoomSlider.min = capabilities.zoom.min;
  zoomSlider.max = capabilities.zoom.max;
  zoomSlider.step = capabilities.zoom.step || 0.1;
  zoomSlider.value = settings.zoom || capabilities.zoom.min;

  zoomSlider.addEventListener('input', async (ev) => { 
    // Update slider track color and apply zoom on input (will replace it with progress/meter html element)
    const el = ev.target;
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 1;
    const val = parseFloat(el.value);
    const pct = ((val - min) / (max - min)) * 100;
    el.style.background = `linear-gradient(to right, #0b4db3 0%, #0b4db3 ${pct}%, #d0d7e2 ${pct}%, #d0d7e2 100%)`; // 
    const zoom = parseFloat(el.value);
    const track = currentStream.getVideoTracks()[0];
    track.applyConstraints({ advanced: [{ zoom }, { focusMode: "continuous" }] });
  });


  // Slider icon click handlers (step slider and dispatch input event)
  const iconStep = parseFloat(zoomSlider.step)*10 || 1;
  zoomMinus.addEventListener('click', () => {
    const iconMin = parseFloat(zoomSlider.min) || 0;
    let v = parseFloat(zoomSlider.value) - iconStep;
    if (v < iconMin) v = iconMin;
    zoomSlider.value = v;
    zoomSlider.dispatchEvent(new Event('input'));
  });

  zoomPlus.addEventListener('click', () => {
    const iconMax = parseFloat(zoomSlider.max) || (parseFloat(zoomSlider.value) + iconStep);
    let v = parseFloat(zoomSlider.value) + iconStep;
    if (v > iconMax) v = iconMax;
    zoomSlider.value = v;
    zoomSlider.dispatchEvent(new Event('input'));
  });
}