checkAuthAndRedirect();

function checkAuthAndRedirect() {
    const userData = localStorage.getItem('user');
    const user = JSON.parse(userData);
    
    if (!userData) {
        window.location.href = '/homepage.html';
        return;
    }
}

function getCurrentUser() {
    try {
        const userData = localStorage.getItem('user');
        return userData ? JSON.parse(userData) : null;
    } catch (e) {
        return null;
    }
}

function logout() {
    localStorage.removeItem('user');
    window.location.href = '/homepage.html';
}

