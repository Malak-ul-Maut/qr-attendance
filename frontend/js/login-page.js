// Display user role
const params = new URLSearchParams(window.location.search);
const role = params.get("role") || "student";

const signInMsg = document.querySelector('.signInMsg');
signInMsg.textContent = "Sign in as " + role.charAt(0).toUpperCase() + role.slice(1);



// ------------ Login button event handler ---------------
const loginBtn = document.querySelector('#loginBtn');

loginBtn.addEventListener('click', async () => {
  const username = document.querySelector('#username').value.trim();
  const password = document.querySelector('#password').value.trim();
  const msg = document.querySelector('#login-msg');

  if(!username || !password) {
    msg.textContent = "Please enter both username and password";
    return;
  }

  try {
    // Send credentials to backend for verification
    const res = await fetch(`/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }) 
    });

    const data = await res.json();
    
    if (!data.ok) {
      msg.textContent = 'Login failed. Check your credentials.';
      return;
    }

    storeUser(data); // Save user login status in localStorage
    redirectUser(data); // redirect user to their respective web-page

  } catch (err) {
    console.error('Login error:', err);
    msg.textContent = 'Error contacting server';
  }
});


// --------- Functions -------------

function redirectUser(data) {
  if (data.role === 'student') {
    window.location.href = `student.html`;
  } else if (data.role === 'faculty') {
    window.location.href = `faculty.html`;
  } else {
    window.location.href = `admin.html`;
  }
}

function storeUser(data) {
  localStorage.setItem('user', JSON.stringify({
    role: data.role,
    username: data.username,
    name: data.name,
    subName: data.subName
  }));
}


// Show password feature
const viewPasswordIcon = document.querySelector('.view-password-icon');
viewPasswordIcon.addEventListener('click', () => {
  passwordBox.type = passwordBox.type === 'password' ? 'text' : 'password';
});

// Click login button when pressing 'Enter' key
const passwordBox = document.querySelector('#password');
passwordBox.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    loginBtn.click();
  }
})