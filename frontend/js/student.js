import QrScanner from '../utils/qr-scanner/qr-scanner.min.js';
import postData from '../utils/fetch.js';
import { getCurrentUser, logout } from '../utils/storage.js';

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
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri('/utils/models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('/utils/models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('/utils/models'),
    faceapi.nets.ssdMobilenetv1.loadFromUri('/utils/models'),
  ]);

  const res = await fetch(`/api/students/descriptors?id=${studentId}`);
  const data = await res.json();

  const labeled = [
    new faceapi.LabeledFaceDescriptors(
      studentId,
      JSON.parse(data).map(x => new Float32Array(x)),
    ),
  ];

  let faceMatcher = new faceapi.FaceMatcher(labeled);

  let currentStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
  });
  video.srcObject = currentStream;
  video.style.transform = 'scaleX(-1)';

  await video.play();
  startFaceVerification(faceMatcher);
}

async function startFaceVerification(faceMatcher) {
  let matchStreak = 0;
  const REQUIRED_STREAK = 8; // ~1 sec (8 × 120ms)

  const canvas = faceapi.createCanvasFromMedia(video);
  video.after(canvas);

  const displaySize = { width: video.videoWidth, height: video.videoHeight };
  faceapi.matchDimensions(canvas, displaySize);
  canvas.width = displaySize.width;
  canvas.height = displaySize.height;

  const interval = setInterval(async () => {
    let inputSize = 128;
    let scoreThreshold = 0.5;

    const detection = await faceapi
      .detectSingleFace(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold }),
      )
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      matchStreak = 0;
      return;
    }

    const resizedDetection = faceapi.resizeResults(detection, displaySize);

    canvas
      .getContext('2d', { willReadFrequently: true })
      .clearRect(0, 0, canvas.width, canvas.height);

    const bestMatch = faceMatcher.findBestMatch(resizedDetection.descriptor);
    const box = resizedDetection.detection.box;

    new faceapi.draw.DrawBox(box, {
      label: bestMatch.toString(),
    }).draw(canvas);

    if (bestMatch.distance < 0.45) {
      matchStreak++;
    } else {
      matchStreak = 0;
    }

    console.log('distance:', bestMatch.distance, 'streak:', matchStreak);

    if (matchStreak >= REQUIRED_STREAK) {
      // clearInterval(interval);
      if (navigator.vibrate) navigator.vibrate(60);
      alert('Face verified :)');

      // await finalizeAttendance(); // change to my sendAttednance method
      // stopCamera(video);
    }
  }, 120);
}

function stopCamera(video) {
  const stream = video.srcObject;
  if (!stream) return;

  stream.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}
