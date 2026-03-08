import QrScanner from '../utils/qr-scanner/qr-scanner.min.js';
import postData from '../utils/fetch.js';
import { getCurrentUser, logout } from '../utils/storage.js';

import {
  loadDescriptors,
  saveDescriptors,
} from '../utils/cache-descriptors.js';

// Pre-download and cache all models from manifest
await cacheModelsFromManifest('/utils/models/models-manifest.json');

// Load models
Promise.all([
  faceapi.nets.tinyFaceDetector.loadFromUri('/utils/models'),
  faceapi.nets.faceLandmark68Net.loadFromUri('/utils/models'),
  faceapi.nets.faceRecognitionNet.loadFromUri('/utils/models'),
]).then(() => console.log('models loaded'));

let studentId = getCurrentUser().username;
let studentName = (document.querySelector('.user-name b').textContent =
  getCurrentUser().name);

let descriptor = await loadDescriptors(studentId);

if (!descriptor) {
  const res = await fetch(`/api/students/descriptors?id=${studentId}`);
  const data = await res.json();
  await saveDescriptors(studentId, JSON.parse(data));
  console.log('cached face descriptors');
  descriptor = await loadDescriptors(studentId);
}

const video = document.querySelector('#video');
const canvas = document.querySelector('#overlay');
const scanResult = document.querySelector('#scan-result');
const scannerSection = document.querySelector('#scanner-section');
const mainSection = document.querySelector('main');

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

let isProcessing = false;
async function scanQRCode(studentId, video) {
  const cameraFingerprint = await getCameraId();

  const qrScanner = new QrScanner(
    video,
    async result => {
      if (isProcessing) return;

      isProcessing = true;

      if (navigator.vibrate) navigator.vibrate(40);
      scanResult.textContent = 'Verifying QR Code...';
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
    isFaceScanned: false,
  });

  if (response.ok) {
    scanResult.textContent = 'Scanning face...';
    qrScanner.stop();
    stopCamera(video);
    switchCamera(token, cameraFingerprint);
  } else {
    scanResult.textContent = `⚠︎ Verification failed !!! (${response.error})`;
    scanResult.style.color = '#b81616';
    isProcessing = false;
  }
}

async function switchCamera(token, cameraFingerprint) {
  let currentStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
  });
  video.srcObject = currentStream;
  video.onloadedmetadata = () => {
    video.play();
    startFaceVerification(token, cameraFingerprint);
  };
}

const inputSize = 128;
const scoreThreshold = 0.5;
const REQUIRED_STREAK = 4;
let matchStreak = 0;
let distance;

async function startFaceVerification(token, cameraFingerprint) {
  const result = await faceapi
    .detectSingleFace(
      video,
      new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold }),
    )
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!result) return requestAnimationFrame(startFaceVerification);

  displayOverlay(result);

  if (matchStreak < REQUIRED_STREAK) {
    matchStreak = distance < 0.45 ? matchStreak + 1 : 0;
    return requestAnimationFrame(startFaceVerification);
  }

  scanResult.textContent = 'Smile kijiye...';

  if (!isSmiling(result.landmarks))
    return requestAnimationFrame(startFaceVerification);

  if (navigator.vibrate) navigator.vibrate(40);
  stopCamera(video);
  scanResult.textContent = 'Submitting attendance...';

  const response = await postData('/api/attendance/verify', {
    studentId,
    studentName,
    token,
    cameraFingerprint,
    isFaceScanned: true,
  });

  if (response.ok) {
    if (navigator.vibrate) navigator.vibrate(60);
    scanResult.textContent = 'Attendance marked successfully!';
    scanResult.style.color = '#2e9c17ff';
  } else {
    scanResult.textContent = `⚠︎ Verification failed !!! (${response.error})`;
    scanResult.style.color = '#b81616';
  }
  return;
}

function isSmiling(landmarks) {
  const mouth = landmarks.getMouth();
  const jaw = landmarks.getJawOutline();

  const mouthWidth = Math.hypot(
    mouth[0].x - mouth[6].x,
    mouth[0].y - mouth[6].y,
  );
  const faceWidth = Math.hypot(jaw[0].x - jaw[16].x, jaw[0].y - jaw[16].y);

  return mouthWidth / faceWidth > 0.42 && distance < 0.45;
}

function stopCamera(video) {
  const stream = video.srcObject;
  if (!stream) return;

  stream.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}

function displayOverlay(result) {
  const dims = faceapi.matchDimensions(canvas, video, true);
  const resizedResult = faceapi.resizeResults(result, dims);

  distance = faceapi.euclideanDistance(resizedResult.descriptor, descriptor);

  const label =
    distance < 0.45
      ? `${studentName} (${distance.toFixed(2)})`
      : `Unknown (${distance.toFixed(2)})`;

  const box = resizedResult.detection.box;

  new faceapi.draw.DrawBox(box, {
    label: label,
  }).draw(canvas);
}

async function getCameraId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter(d => d.kind === 'videoinput');
  const preferred =
    videoInputs.find(d => d.label.toLowerCase().includes('back')) ||
    videoInputs[0];

  return preferred.deviceId;
}

function enableZoom(currentStream) {
  const zoomSlider = document.querySelector('#zoom-slider');
  const zoomMinus = document.querySelector('.slider-icon.left');
  const zoomPlus = document.querySelector('.slider-icon.right');

  const track = currentStream.getVideoTracks()[0];
  const capabilities = track.getCapabilities();
  zoomSlider.max = capabilities.zoom.max;
  if (!capabilities.zoom) return console.warn('Zoom not supported');

  zoomMinus.addEventListener('click', () => {
    zoomSlider.value = parseFloat(zoomSlider.value) - 1;
    zoomSlider.dispatchEvent(new Event('input'));
  });

  zoomPlus.addEventListener('click', () => {
    zoomSlider.value = parseFloat(zoomSlider.value) + 1;
    zoomSlider.dispatchEvent(new Event('input'));
  });

  zoomSlider.addEventListener('input', event => {
    const percent =
      ((zoomSlider.value - zoomSlider.min) /
        (zoomSlider.max - zoomSlider.min)) *
      100;
    zoomSlider.style.setProperty('--fill', `${percent}%`); // Update slider fill
    const zoom = parseFloat(event.target.value);
    track.applyConstraints({ advanced: [{ zoom }] });
  });
}
