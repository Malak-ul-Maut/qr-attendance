import QrScanner from '../utils/qr-scanner/qr-scanner.min.js';
import postData from '../utils/fetch-url.js';
import { getCurrentUser, logout } from '../utils/local-storage.js';

const video = document.querySelector('#video');
const scanResult = document.querySelector('#scan-result');
const scannerSection = document.querySelector('#scanner-section');
const mainSection = document.querySelector('main');

let studentName = (document.querySelector('.user-name b').textContent =
  getCurrentUser().name);
let studentId = getCurrentUser().username;

const logoutBtn = document.querySelector('.logout-btn');
logoutBtn.addEventListener('click', () => logout());

// ------------ Event handlers ---------------
const markAttendanceCard = document.querySelector('#markAttendanceCard');

markAttendanceCard.addEventListener('click', async () => {
  scannerSection.style.display = 'block';
  closeScanBtn.style.display = 'block';
  mainSection.style.display = 'none';

  try {
    // Access camera
    let currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    video.srcObject = currentStream;
    enableZoom(currentStream);
    scanQRCode(studentId, video);
  } catch (err) {
    return alert('Unable to access camera:', err);
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
  const preferred =
    videoInputs.find(d => d.label.toLowerCase().includes('back')) ||
    videoInputs[0];

  return preferred.deviceId;
}

async function scanQRCode(studentId, video) {
  const cameraFingerprint = await getCameraId();

  const qrScanner = new QrScanner(
    video,
    result => {
      if (navigator.vibrate) navigator.vibrate(40);
      scanResult.textContent = 'Submitting attendance...';
      sendAttendance(studentId, result.data, cameraFingerprint);
      qrScanner.stop();
    },
    { returnDetailedScanResult: true },
  );

  await qrScanner.start();
  await video.play();
}

async function sendAttendance(studentId, token, cameraFingerprint) {
  const response = await postData('/api/attendance/verify', {
    studentId,
    studentName,
    token,
    cameraFingerprint,
  });

  if (response.ok) {
    scanResult.textContent = '✔ Attendance marked successfully!';
    scanResult.style.color = '#2e9c17ff';
  } else {
    scanResult.textContent = `⚠︎ Verification failed !!! (${response.error})`;
    scanResult.style.color = '#b81616';
  }
}

function enableZoom(currentStream) {
  const zoomSlider = document.querySelector('#zoom-slider');
  const zoomMinus = document.querySelector('.slider-icon.left');
  const zoomPlus = document.querySelector('.slider-icon.right');

  const track = currentStream.getVideoTracks()[0];
  const capabilities = track.getCapabilities();
  zoomSlider.max = capabilities.zoom.max;
  if (!capabilities.zoom) return console.warn('Zoom not supported');

  if (capabilities.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  }

  zoomSlider.addEventListener('input', event => {
    const percent =
      ((zoomSlider.value - zoomSlider.min) /
        (zoomSlider.max - zoomSlider.min)) *
      100;
    zoomSlider.style.setProperty('--fill', `${percent}%`); // Update slider fill
    const zoom = parseFloat(event.target.value);
    track.applyConstraints({ advanced: [{ zoom }] });
  });

  zoomMinus.addEventListener('click', () => {
    zoomSlider.value = parseFloat(zoomSlider.value) - 1;
    zoomSlider.dispatchEvent(new Event('input'));
  });

  zoomPlus.addEventListener('click', () => {
    zoomSlider.value = parseFloat(zoomSlider.value) + 1;
    zoomSlider.dispatchEvent(new Event('input'));
  });
}
