url = 'https://192.168.1.15:4000';

loginBtn.addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const msg = document.getElementById('login-msg');

    try {
        const res = await fetch(`${url}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }) 
        });

        const data = await res.json();
        
        if (data.ok && data.loginId === 'S1') {
          window.location.href = `${url}/student.html`;
          }
        else if (data.ok && data.loginId === 'T1') {
          window.location.href = `${url}/teacher.html`;
        } else {
            msg.textContent = 'Login failed';
        }

    } catch (err) {
        console.error('Login error:', err);
        msg.textContent = 'Error contacting server';
    }
});


