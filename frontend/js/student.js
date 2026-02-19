import QrScanner from '../utils/qr-scanner/qr-scanner.min.js';
import postData from '../utils/fetch.js';
import { getCurrentUser, logout } from '../utils/storage.js';

import {
  loadDescriptors,
  saveDescriptors,
} from '../utils/cache-descriptors.js';

// Pre-download and cache all models from manifest
await cacheModelsFromManifest('/utils/models/models-manifest.json');

// Load models - they will now be served from IndexedDB cache via interceptors
Promise.all([
  faceapi.nets.tinyFaceDetector.loadFromUri('/utils/models'),
  faceapi.nets.faceLandmark68Net.loadFromUri('/utils/models'),
  faceapi.nets.faceRecognitionNet.loadFromUri('/utils/models'),
]).then(() => console.log('models loaded'));

let studentId = getCurrentUser().username;

let descriptors = await loadDescriptors(studentId);

if (!descriptors) {
  const res = await fetch(`/api/students/descriptors?id=${studentId}`);
  const data = await res.json();
  await saveDescriptors(studentId, JSON.parse(data));
  console.log('cached face descriptors');
  descriptors = await loadDescriptors(studentId);
}

const labeled = [
  new faceapi.LabeledFaceDescriptors(
    studentId,
    descriptors.map(x => new Float32Array(x)),
  ),
];

let faceMatcher = new faceapi.FaceMatcher(labeled);

const video = document.querySelector('#video');
const canvas = document.querySelector('#overlay');
const scanResult = document.querySelector('#scan-result');
const scannerSection = document.querySelector('#scanner-section');
const mainSection = document.querySelector('main');

let studentName = (document.querySelector('.user-name b').textContent =
  getCurrentUser().name);

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

let isProcessing = false;
async function scanQRCode(studentId, video) {
  const cameraFingerprint = await getCameraId();

  const qrScanner = new QrScanner(
    video,
    async result => {
      if (isProcessing) return;

      isProcessing = true;

      if (navigator.vibrate) navigator.vibrate(40);
      scanResult.textContent = 'Submitting attendance...';
      await sendAttendance(
        studentId,
        result.data,
        cameraFingerprint,
        qrScanner,
      );
    },
    { returnDetailedScanResult: true },
  );

  await qrScanner.start();
  await video.play();
}

async function sendAttendance(studentId, token, cameraFingerprint, qrScanner) {
  const response = await postData('/api/attendance/verify', {
    studentId,
    studentName,
    token,
    cameraFingerprint,
  });

  if (response.ok) {
    scanResult.textContent = '✔ Attendance marked successfully!';
    scanResult.style.color = '#2e9c17ff';
    qrScanner.stop();
    stopCamera(video);
    switchCamera();
  } else {
    scanResult.textContent = `⚠︎ Verification failed !!! (${response.error})`;
    scanResult.style.color = '#b81616';
    isProcessing = false;
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

async function switchCamera() {
  let currentStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
  });
  video.srcObject = currentStream;
  video.onloadedmetadata = () => {
    video.play();
    startFaceVerification();
  };
}

let matchStreak = 0;
let bestMatchDistances = [];
const REQUIRED_STREAK = 20; // ~1 sec (8 × 120ms)

async function startFaceVerification() {
  let inputSize = 128;
  let scoreThreshold = 0.5;

  const result = await faceapi
    .detectSingleFace(
      video,
      new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold }),
    )
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (result) {
    const dims = faceapi.matchDimensions(canvas, video, true);
    const resizedResult = faceapi.resizeResults(result, dims);
    const bestMatch = faceMatcher.findBestMatch(resizedResult.descriptor);
    const box = resizedResult.detection.box;
    new faceapi.draw.DrawBox(box, {
      label: bestMatch.toString(),
    }).draw(canvas);

    console.log('Distance: ', bestMatch.distance, 'Streak: ', matchStreak);
    if (bestMatch.distance < 0.45) {
      matchStreak++;
      bestMatchDistances.push(bestMatch.distance);
    } else {
      matchStreak = 0;
      bestMatchDistances = [];
    }
  }

  if (matchStreak >= REQUIRED_STREAK) {
    // clearInterval(interval);
    if (navigator.vibrate) navigator.vibrate(60);
    let avgDistance = 0;
    bestMatchDistances.forEach(distance => (avgDistance += distance));
    alert('Face verified');
    console.log(avgDistance / bestMatchDistances.length);
  }

  requestAnimationFrame(startFaceVerification);
}

function stopCamera(video) {
  const stream = video.srcObject;
  if (!stream) return;

  stream.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}
