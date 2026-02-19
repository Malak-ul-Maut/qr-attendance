const video = document.getElementById('video');

Promise.all([
  faceapi.nets.tinyFaceDetector.loadFromUri('/utils/models'),
  faceapi.nets.faceLandmark68Net.loadFromUri('/utils/models'),
  faceapi.nets.faceRecognitionNet.loadFromUri('/utils/models'),
  faceapi.nets.ssdMobilenetv1.loadFromUri('/utils/models'),
])
  .then(() => alert('Models loaded.'))
  .then(startWebcam);

async function startWebcam() {
  const labeledFaceDescriptors = await getLabeledFaceDescriptions();
  faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors);

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
  });
  video.srcObject = stream;
  video.addEventListener('loadedmetadata', () => {
    video.play();
  });
}

video.addEventListener('playing', () => {
  const canvas = faceapi.createCanvasFromMedia(video);
  document.body.append(canvas);

  const displaySize = { width: video.width - 100, height: video.height };
  faceapi.matchDimensions(canvas, displaySize);

  let inputSize = 128;
  let scoreThreshold = 0.5;

  setInterval(async () => {
    const detections = await faceapi
      .detectAllFaces(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();
    const resizedDetections = faceapi.resizeResults(detections, displaySize);

    canvas
      .getContext('2d', { willReadFrequently: true })
      .clearRect(0, 0, canvas.width, canvas.height);

    resizedDetections.forEach(d => {
      const result = faceMatcher.findBestMatch(d.descriptor);
      const box = d.detection.box;

      new faceapi.draw.DrawBox(box, {
        label: result.toString(),
      }).draw(canvas);
    });
  }, 100);
});

function getLabeledFaceDescriptions() {
  const labels = ['manish', 'ahad', 'mishthi', 'deepanshi', 'tara'];

  return Promise.all(
    labels.map(async label => {
      const descriptions = [];

      for (let i = 1; i <= 1; i++) {
        const image = await faceapi.fetchImage(
          `/utils/labels/${label}/${i}.jpg`,
        );
        const detections = await faceapi
          .detectSingleFace(image)
          .withFaceLandmarks()
          .withFaceDescriptor();
        if (!detections) {
          console.warn(`No face detected in ${label}/${i}.jpg`);
          alert(`No face detected in ${label}/${i}.jpg`);
          continue;
        }
        descriptions.push(detections.descriptor);
        console.log(`Loaded ${label}/${i}.jpg`);
      }
      return new faceapi.LabeledFaceDescriptors(label, descriptions);
    }),
  );
}
