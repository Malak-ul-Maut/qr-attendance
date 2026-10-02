import postData from '../utils/fetch.js';
import { storeUser } from '../utils/storage.js';
import { showToast } from './ui.js';

// Read the role from the page address, e.g. login-page.html?role=faculty
const roleFromUrl = new URLSearchParams(window.location.search).get('role');
const allowedRoles = ['admin', 'student', 'faculty'];

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
  document.title = `Sign in as ${roleLabel} | Attendance System`;

  // ---------- Show / hide password ----------
  togglePasswordBtn.addEventListener('click', () => {
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    togglePasswordBtn.textContent = isHidden ? 'Hide' : 'Show';
    togglePasswordBtn.setAttribute('aria-pressed', String(isHidden));
  });

  // ---------- Forgot password ----------
  // There is no online reset yet, so tell the user what to do instead
  forgotPasswordBtn.addEventListener('click', () => {
    showToast('Ask your administrator to reset your password.');
  });

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
