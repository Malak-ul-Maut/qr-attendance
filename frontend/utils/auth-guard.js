checkAuthAndRedirect();

function checkAuthAndRedirect() {
  const userData = localStorage.getItem('user');
  if (!userData) return (window.location.href = '/homepage.html');
}
