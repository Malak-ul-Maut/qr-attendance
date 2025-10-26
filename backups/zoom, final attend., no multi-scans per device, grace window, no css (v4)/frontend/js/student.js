const startScanBtn = document.getElementById('startScanBtn');
const video = document.getElementById('video');
const scanResult = document.getElementById('scan-result');
let scanning = false;
let scanInProgress = false;


//---------- Functions --------------

// Hash function (SHA-256)
async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// Get stable camera device ID (hashed)
async function getHashedCameraId() {
   try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');
    if (videoInputs.length === 0) return null;

    const preferred = videoInputs.find(d => d.label.toLowerCase().includes('back')) || videoInputs[0];
    const camerId = preferred.deviceId;

    return await hashString(camerId);
   } catch (err) {
    console.error("Error enumerating media devices:", err);
    return null;
   }
}


startScanBtn.addEventListener('click', async () => {
    const studentId = document.getElementById('studentId').value;
    if (!studentId) return alert('Please enter your Student ID.');

    document.getElementById('student-section').style.display = 'none';
    document.getElementById('scanner-section').style.display = 'block';
    
    // Access camera
    try{
        let stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'environment' } 
        });
        video.srcObject = stream;
        await video.play();

        // Try to enable zoom if supported
        const [track] = stream.getVideoTracks();
        const capabilities = track.getCapabilities();
        const settings = stream.getVideoTracks()[0].getSettings();

        if (capabilities.zoom) {
            const zoomControl = document.createElement("input");
            zoomControl.type = "range";
            zoomControl.min = capabilities.zoom.min;
            zoomControl.max = capabilities.zoom.max;
            zoomControl.step = capabilities.zoom.step || 0.1;
            zoomControl.value = settings.zoom || capabilities.zoom.min;
            
            Object.assign(zoomControl.style, {
                display: "flex",
                marginTop: "10px",
                marginLeft: "auto",
                marginRight: "auto",
                zIndex: "999",
                accentColor: "#00bfff",
                height: "25px",
            });
            video.insertAdjacentElement("afterend", zoomControl);

            zoomControl.addEventListener('input', async () => {
                const zoom = parseFloat(zoomControl.value);
                const track = stream.getVideoTracks()[0];
                await track.applyConstraints({ advanced: [{ zoom }] });
            });
        } else {
            console.warn("Zoom not supported by this device/camera");
        }

        scanning = true;
        const hashedCameraId = await getHashedCameraId();
        scanQRCode(studentId, video, stream, hashedCameraId);
    } catch (err) {
        console.error("Camera error:", err);
        alert("Unable to access camera. Make sure you allow permission.");
    }
});

async function scanQRCode(studentId, video, stream, hashedCameraId) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: 'true'});

    const interval = setInterval(() => {
        if (!scanning) return;
        if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
        
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);

        if(code && !scanInProgress) {
            scanning = false;
            scanInProgress = true;
            stream.getTracks().forEach(track => track.stop());
            scanResult.textContent = "QR detected. Submitting attendance...";
            clearInterval(interval);
            sendAttendance(studentId, code.data, hashedCameraId);
        }
    }, 300);
}


// Send Attendance
async function sendAttendance(studentId, token, hashedCameraId) {
    try {
        const res = await fetch('http://192.168.1.9:4000/api/session/verify', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ studentId, token, cameraFingerprint: hashedCameraId })
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
            scanResult.textContent = "Attendance marked successfully!";
        } else {
            scanResult.textContent = `Verification failed: ${data.error || 'unknown'}`;
            console.log("Verification failed: ", data.error );
        }
    } catch (err) {
        console.error('Send attendance error:', err);
        scanResult.textContent = 'Error contacting server. Check connection.';
    } finally {
        // allow retry if needed
        scanInProgress = false;
    }
}