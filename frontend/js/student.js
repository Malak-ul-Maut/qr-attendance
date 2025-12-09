import QrScanner from './utils/qr-scanner/qr-scanner.min.js';

const markAttendanceCard = document.getElementById('markAttendanceCard');
const closeScanBtn = document.getElementById('closeScanBtn');
const video = document.getElementById('video');
const scanResult = document.getElementById('scan-result');
const scannerSection = document.getElementById('scanner-section');
const mainSection = document.querySelector('main');

let studentId = document.querySelector('.user-name b').textContent = getCurrentUser().name;



// ------------ Event handlers ---------------

markAttendanceCard.addEventListener('click', async () => {
  scannerSection.style.display = 'block';
  closeScanBtn.style.display = 'block';
  mainSection.style.display = 'none';
  
  // Access camera
  try{
    let currentStream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: 'environment' } 
    });
    video.srcObject = currentStream;
    enableZoom(currentStream);
    scanQRCode(studentId, video);

  } catch (err) {
    console.error("Camera error:", err);
    alert("Unable to access camera. Make sure you allow permission.");
  }
});


closeScanBtn.addEventListener('click', () => {
    scannerSection.style.display = 'none';
    closeScanBtn.style.display = 'none';
    scanResult.textContent = '';
    mainSection.style.display = 'flex';
});


// Slider icon click handlers (step slider and dispatch input event)
try {
    const zoomMinus = document.querySelector('.slider-icon.left');
    const zoomPlus = document.querySelector('.slider-icon.right');
    const zoomControlGlobal = document.getElementById('zoom-slider');

    if (zoomMinus && zoomPlus && zoomControlGlobal) {
        const step = parseFloat(zoomControlGlobal.step)*10 || 1;
        zoomMinus.addEventListener('click', () => {
            const min = parseFloat(zoomControlGlobal.min) || 0;
            let v = parseFloat(zoomControlGlobal.value) - step;
            if (v < min) v = min;
            zoomControlGlobal.value = v;
            zoomControlGlobal.dispatchEvent(new Event('input'));
        });

        zoomPlus.addEventListener('click', () => {
            const max = parseFloat(zoomControlGlobal.max) || (parseFloat(zoomControlGlobal.value) + step);
            let v = parseFloat(zoomControlGlobal.value) + step;
            if (v > max) v = max;
            zoomControlGlobal.value = v;
            zoomControlGlobal.dispatchEvent(new Event('input'));
        });
    }
} catch (e) {
    console.warn('Slider icon handlers could not be attached:', e);
}



//---------- Functions --------------

async function getCameraId() {
   try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');

    if (videoInputs.length === 0) return null;

    const preferred = videoInputs.find(d => d.label.toLowerCase().includes('back')) || videoInputs[0];
    const camerId = preferred.deviceId;
    return camerId;
    
   } catch (err) {
    console.error("Error enumerating media devices:", err);
    return null;
   }
}


async function enableZoom(currentStream) {
  const [track] = currentStream.getVideoTracks();
  const capabilities = track.getCapabilities();
  const settings = currentStream.getVideoTracks()[0].getSettings();

  if (!capabilities.zoom) console.warn("Zoom not supported by this device/camera");

  const zoomControl = document.getElementById('zoom-slider');
  zoomControl.style.display = 'block';
  zoomControl.min = capabilities.zoom.min;
  zoomControl.max = capabilities.zoom.max;
  zoomControl.step = capabilities.zoom.step || 0.1;
  zoomControl.value = settings.zoom || capabilities.zoom.min;

  zoomControl.addEventListener('input', async (ev) => {
    // Update slider track color and apply zoom on input
    const el = ev.target;
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 1;
    const val = parseFloat(el.value);
    const pct = ((val - min) / (max - min)) * 100;
    el.style.background = `linear-gradient(to right, #0b4db3 0%, #0b4db3 ${pct}%, #d0d7e2 ${pct}%, #d0d7e2 100%)`;
    const zoom = parseFloat(el.value);
    const track = currentStream.getVideoTracks()[0];
    track.applyConstraints({ advanced: [{ zoom }] });
  });
}


async function scanQRCode(studentId, video) {
  const cameraId = await getCameraId();
  const qrScanner = new QrScanner(video, result => {
    if (navigator.vibrate) navigator.vibrate(40);
    scanResult.textContent = 'Submitting attendance...';
    sendAttendance(studentId, result.data, cameraId);
    qrScanner.stop();
  }, {
    onDecodeError: error => console.warn(error),
    returnDetailedScanResult: true
  });

  const track = video.srcObject.getVideoTracks()[0];
  const capabilities = track.getCapabilities();
  if (capabilities.focusMode) {
    track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
  }

  await qrScanner.start();
  await video.play();
}


async function sendAttendance(studentId, token, cameraId) {
  try {
    const res = await fetch('/api/session/verify', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({studentId, token, cameraFingerprint: cameraId })
    });

    const text = await res.text();
    let data;
    try { 
      data = JSON.parse(text); 
    } catch (e) {
      console.error('Non-JSON response from server:', text);
      scanResult.textContent = 'Server error (non-JSON). See console.';
      scanInProgress = false;
      return;
    }

    if (data.ok) {
      scanResult.textContent = "✔ Attendance marked successfully!";
      scanResult.style.color = '#2e9c17ff'
    } else {
      scanResult.textContent = `⚠︎ Verification failed !!! (${data.error || 'unknown'})`;
      scanResult.style.color = '#b81616';
      console.log("Verification failed: ", data.error );
    }
  } catch (err) {
    console.error('Send attendance error:', err);
    scanResult.textContent = 'Error contacting server. Check connection.';
  } 
}