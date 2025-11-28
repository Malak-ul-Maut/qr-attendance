// Auth Guard: Protects pages from unauthorized access
// Usage: Added this script to the <head> of protected pages (student.html, teacher.html, admin.html)

function checkAuthAndRedirect() {
    const authData = sessionStorage.getItem('auth');
    
    if (!authData) {
        // No auth data - redirect to homepage
        window.location.href = '/homepage.html';
        return;
    }

    try {
        const user = JSON.parse(authData);
        
        // Verify user has required properties
        if (!user.role || !user.loginId) {
            sessionStorage.removeItem('auth');
            window.location.href = '/homepage.html';
            return;
        }

        return user;
    } catch (e) {
        // Corrupted auth data
        sessionStorage.removeItem('auth');
        window.location.href = '/homepage.html';
    }
}

// Get current logged-in user (returns null if not logged in)
function getCurrentUser() {
    try {
        const authData = sessionStorage.getItem('auth');
        return authData ? JSON.parse(authData) : null;
    } catch (e) {
        return null;
    }
}

// Logout user
function logout() {
    sessionStorage.removeItem('auth');
    window.location.href = '/homepage.html';
}

