checkAuthAndRedirect();

function checkAuthAndRedirect() {
  const userData = localStorage.getItem('user');
  if (!userData) return (window.location.href = '/homepage.html');
}

function getCurrentUser() {
  const userData = localStorage.getItem('user');
  return userData ? JSON.parse(userData) : null;
}

function logout() {
  localStorage.removeItem('user');
  window.location.href = '/homepage.html';
}

async function postData(url, dataObject) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dataObject),
    });
    return response.json();
  } catch (error) {
    console.error('POST request error:', error);
  }
}
