// One place that turns server codes and browser errors into words a student can act on.
// Never show the raw code except in the collapsed "Details" line meant for support.

// tone: 'success' (nothing to fix), 'warning' (the student can fix it), 'error' (they cannot)
// keepScanning: true means stay on the QR step and let them try again.
const MESSAGES = {
  invalid_or_expired_token: {
    tone: 'warning',
    title: 'That QR code has expired.',
    text: "Point at the QR on your teacher's screen. It refreshes every few seconds.",
    keepScanning: true,
  },
  not_a_class_qr: {
    tone: 'warning',
    title: "This isn't a class attendance QR.",
    text: "Point at the QR on your teacher's screen.",
    keepScanning: true,
  },
  session_not_found: {
    tone: 'warning',
    title: 'This class is not open.',
    text: 'Ask your teacher to start attendance again.',
    keepScanning: true,
  },
  session_ended: {
    tone: 'error',
    title: 'Attendance for this class has closed.',
    text: 'Ask your teacher to mark you present.',
  },
  wrong_method: {
    tone: 'warning',
    title: 'This class uses the classroom camera.',
    text: 'Stay seated. You do not need to scan a QR code.',
  },
  not_on_roster: {
    tone: 'warning',
    title: ({ subject }) =>
      subject
        ? `You're not on the list for ${subject}.`
        : "You're not on the list for this class.",
    text: 'Check that you are in the right class. If you should be, tell your teacher.',
  },
  account_inactive: {
    tone: 'error',
    title: 'Your account is inactive.',
    text: 'Contact the admin office.',
  },
  already_marked: {
    tone: 'success',
    title: ({ subject }) =>
      subject
        ? `You're already marked present for ${subject}.`
        : "You're already marked present.",
    text: 'Nothing more to do.',
  },
  duplicate_device_entry: {
    tone: 'warning',
    title: 'This phone was already used to mark another student in this class.',
    text: 'Use your own phone. If you share a device, ask your teacher to mark you.',
  },
  face_not_enrolled: {
    tone: 'warning',
    title: 'Add your face photos to use QR attendance.',
    text: 'Take your photos in your Profile, then come back here.',
  },
  face_not_approved: {
    tone: 'warning',
    title: 'Your face photos are waiting for approval.',
    text: 'Ask your teacher to mark you present for now.',
  },
  database_error: {
    tone: 'error',
    title: "We couldn't save this. Nothing was recorded.",
    text: 'Try again. If it keeps happening, tell your teacher.',
    retryable: true,
  },
  server_error: {
    tone: 'error',
    title: "We couldn't save this. Nothing was recorded.",
    text: 'Try again. If it keeps happening, tell your teacher.',
    retryable: true,
  },
  network: {
    tone: 'error',
    title: 'No connection to the server.',
    text: 'Check your Wi-Fi or mobile data, then try again.',
    retryable: true,
  },
  camera_denied: {
    tone: 'warning',
    title: 'Camera access is blocked.',
    text: 'Allow the camera for this site in your browser settings, then try again.',
  },
  camera_missing: {
    tone: 'error',
    title: 'No camera found on this device.',
    text: 'Use a phone with a camera, or ask your teacher to mark you.',
  },
  camera_busy: {
    tone: 'warning',
    title: 'The camera is being used by another app.',
    text: 'Close other apps or tabs that use the camera, then try again.',
  },
  camera_insecure: {
    tone: 'error',
    title: 'The camera needs a secure (https) connection.',
    text: 'Open this page using the https address, or tell your teacher.',
  },
  camera_unknown: {
    tone: 'warning',
    title: 'Could not start the camera.',
    text: 'Close the page, open it again and allow the camera.',
  },
  face_engine: {
    tone: 'warning',
    title: "Couldn't get the face check ready.",
    text: 'Check your connection and try again.',
    retryable: true,
  },
  qr_unsupported: {
    tone: 'error',
    title: "This browser can't scan QR codes yet.",
    text: 'Open this page in Chrome, or ask your teacher to mark you.',
  },
  unknown: {
    tone: 'error',
    title: 'Something went wrong.',
    text: 'Try again. If it keeps happening, tell your teacher.',
    retryable: true,
  },
};

// Accepts a server code, or a response object from postJson ({ error, subject, ... }).
export function describeError(codeOrResponse) {
  const response =
    typeof codeOrResponse === 'string'
      ? { error: codeOrResponse }
      : codeOrResponse || {};
  const code = response.error || 'unknown';
  const entry = MESSAGES[code] || MESSAGES.unknown;
  const pick = value => (typeof value === 'function' ? value(response) : value);
  return {
    code,
    tone: entry.tone,
    title: pick(entry.title),
    text: pick(entry.text),
    keepScanning: Boolean(entry.keepScanning),
    retryable: Boolean(entry.retryable),
  };
}

// getUserMedia failures: each cause gets its own instruction.
export function cameraErrorCode(error) {
  if (typeof window !== 'undefined' && window.isSecureContext === false)
    return 'camera_insecure';
  if (error?.code === 'stalled' || error?.code === 'no_picture') return 'camera_busy';
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'camera_denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'camera_missing';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'camera_busy';
    default:
      return error?.code === 'no_camera' ? 'camera_missing' : 'camera_unknown';
  }
}

// Class tokens are 24 hex characters (12 random bytes). Anything else is some other QR code.
export const looksLikeClassToken = value => /^[0-9a-f]{24}$/.test(value);
