import postData from '../utils/fetch.js';
import { storeUser } from '../utils/storage.js';

// Display user role
const searchQuery = window.location.search; // '?role=faculty'
const role = searchQuery.slice(6);

const allowedRoles = ['admin', 'student', 'faculty'];
if (!allowedRoles.includes(role)) window.location.href = 'homepage.html';

const signInMsg = document.querySelector('.signInMsg');
signInMsg.textContent = 'Sign in as ' + role[0].toUpperCase() + role.slice(1);

// 'Enter' key triggers 'Login' button
const passwordBox = document.querySelector('#password');
passwordBox.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    loginBtn.click();
  }
});

// Show password feature
const viewPasswordIcon = document.querySelector('.view-password-icon');
viewPasswordIcon.addEventListener('click', () => {
  if (passwordBox.type === 'password') {
    passwordBox.type = 'text';
  } else {
    passwordBox.type = 'password';
  }
});

// ------------ Login button event handler ---------------
const loginBtn = document.querySelector('#loginBtn');

loginBtn.addEventListener('click', async () => {
  const username = document.querySelector('#username').value.trim();
  const password = document.querySelector('#password').value.trim();
  const msg = document.querySelector('#login-msg');

  if (!username || !password)
    return (msg.textContent = 'Please enter both username and password');

  // Send credentials to backend for verification
  const response = await postData('/api/auth/login', {
    username,
    password,
    role,
  });

  if (!response.ok)
    return (msg.textContent = 'Login failed. Check your credentials.');

  storeUser(response);
  window.location.href = `${role}.html`;
});
