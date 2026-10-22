import postData from '../utils/fetch.js';
import { storeUser } from '../utils/storage.js';
import { showToast } from './ui.js';

// Read the role from the page address, e.g. login-page.html?role=faculty
const roleFromUrl = new URLSearchParams(window.location.search).get('role');
const allowedRoles = ['admin', 'student', 'faculty'];

// The line shown beside the form on wide screens: what this role does in the system.
const ROLE_COPY = {
  student: {
    headline: 'Scan the class QR. Verify your face. You’re marked.',
    sub: 'Your attendance and the 75% line, always up to date.',
  },
  faculty: {
    headline: 'Start a session in two taps.',
    sub: 'Show the QR code or use the classroom camera, and watch the roster fill live.',
  },
  admin: {
    headline: 'Every term, timetable and record in one place.',
    sub: 'Set up classes, check face photos and review attendance.',
  },
};

if (allowedRoles.includes(roleFromUrl)) {
  setUpLoginForm(roleFromUrl);
} else {
  // Unknown or missing role: send the visitor back to pick one
  window.location.replace('homepage.html');
}

function setUpLoginForm(role) {
  const roleLabel = role[0].toUpperCase() + role.slice(1); // 'faculty' -> 'Faculty'

  const heading = document.querySelector('.signInMsg');
  const loginForm = document.querySelector('#loginForm');
  const usernameInput = document.querySelector('#username');
  const passwordInput = document.querySelector('#password');
  const togglePasswordBtn = document.querySelector('#togglePassword');
  const forgotPasswordBtn = document.querySelector('#forgotPassword');
  const loginBtn = document.querySelector('#loginBtn');
  const errorMessage = document.querySelector('#login-msg');

  heading.textContent = `Sign in as ${roleLabel}`;
  const product = window.BRAND?.product?.name || 'Smart Attendance Marker';
  document.title = `Sign in as ${roleLabel} | ${product}`;

  // Role copy and illustration (hidden on phones by the stylesheet)
  const copy = ROLE_COPY[role];
  document.querySelector('[data-role-headline]').textContent = copy.headline;
  document.querySelector('[data-role-sub]').textContent = copy.sub;
  // (SVG elements have no .hidden property, so the attribute is removed directly)
  document.querySelector(`[data-art="${role}"]`).removeAttribute('hidden');

  // ---------- Show / hide password ----------
  const eyeOn = togglePasswordBtn.querySelector('.eye-on');
  const eyeOff = togglePasswordBtn.querySelector('.eye-off');
  togglePasswordBtn.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    eyeOn.toggleAttribute('hidden', show); // the open eye means "tap to show"
    eyeOff.toggleAttribute('hidden', !show); // the crossed eye means "tap to hide"
    togglePasswordBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    togglePasswordBtn.setAttribute('aria-pressed', String(show));
  });

  // ---------- Forgot password ----------
  // There is no online reset yet, so tell the user what to do instead
  forgotPasswordBtn.addEventListener('click', () => {
    showToast('Ask your administrator to reset your password.');
  });

  // ---------- Why was I sent here? (e.g. the admin session expired) ----------
  const notice = sessionStorage.getItem('loginNotice');
  if (notice) {
    sessionStorage.removeItem('loginNotice');
    errorMessage.textContent = notice;
    errorMessage.hidden = false;
  }

  // ---------- Helpers ----------
  function showError(message, inputToFocus) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    if (inputToFocus) {
      inputToFocus.setAttribute('aria-invalid', 'true');
      inputToFocus.focus();
    }
  }

  function clearError() {
    errorMessage.hidden = true;
    usernameInput.removeAttribute('aria-invalid');
    passwordInput.removeAttribute('aria-invalid');
  }

  function setLoading(isLoading) {
    loginBtn.setAttribute('aria-busy', String(isLoading)); // shows the spinner
    loginBtn.disabled = isLoading; // stops double submits
  }

  // ---------- Submit (works for the button and the Enter key) ----------
  loginForm.addEventListener('submit', async event => {
    event.preventDefault(); // stop the browser from reloading the page
    clearError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username) return showError('Enter your username.', usernameInput);
    if (!password) return showError('Enter your password.', passwordInput);

    setLoading(true);
    try {
      // Send credentials to the backend for verification
      const response = await postData('/api/auth/login', {
        username,
        password,
        role,
      });

      if (!response.ok) {
        return showError(
          'Username or password is incorrect. Check them and try again.',
          passwordInput,
        );
      }

      storeUser(response);
      window.location.href = `${role}.html`;
    } catch (error) {
      // fetch itself failed, for example the server is unreachable
      showError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  });
}
