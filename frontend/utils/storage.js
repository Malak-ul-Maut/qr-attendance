export function getCurrentUser() {
  const userData = localStorage.getItem('user');
  return userData ? JSON.parse(userData) : null;
}

export function logout() {
  localStorage.removeItem('user');
  window.location.href = '/homepage.html';
}

export function storeUser(data) {
  localStorage.setItem(
    'user',
    JSON.stringify({
      role: data.role,
      username: data.username,
      name: data.name,
      subName: data.subjectName,
    }),
  );
}
