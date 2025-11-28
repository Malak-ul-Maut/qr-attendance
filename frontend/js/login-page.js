if (!window.__API_BASE) {
    window.__API_BASE = (location.protocol && location.protocol.startsWith('http') ? location.origin : 'https://192.168.1.110:4000');
}
const url = window.__API_BASE;
const params = new URLSearchParams(window.location.search);
const role = params.get("role") || "student";
const viewPasswordBtn = document.querySelector('.input-container img');
const passwordBox = document.querySelector('#password');

document.getElementById('login-title').textContent = 
    "Sign in as " + role.charAt(0).toUpperCase() + role.slice(1);

viewPasswordBtn.addEventListener('click', () => {
    passwordBox.type = 'text';
});



loginBtn.addEventListener('click', async () => {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const msg = document.getElementById('login-msg');

    if(!username || !password) {
        msg.textContent = "Please enter both username and password";
        return;
    }

    try {
        const res = await fetch(`${url}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role }) 
        });

        const data = await res.json();
        console.log(data);
        
        if (!data.ok) {
            msg.textContent = 'Login failed. Check your credentials.';
            return;
        }

        // Store auth data in sessionStorage
        sessionStorage.setItem('auth', JSON.stringify({
            role: role,
            name: data.name,
            loginId: data.loginId,
            username: username,
            subName: data.subName
        }));

        if (role === 'student') {
          window.location.href = `${url}/student.html`;
          return;
          }
        if (role === 'faculty') {
          window.location.href = `${url}/teacher.html`;
          return;
        } 
        if (role === 'admin') {
          window.location.href = `${url}/admin.html`;
          return;
        } 
        // if correct credentials but incorrect role
        msg.textContent = 'Incorrect login portal for this account';

    } catch (err) {
        console.error('Login error:', err);
        msg.textContent = 'Error contacting server';
    }
});


