const DB_NAME = 'face-db';
const STORE = 'descriptors';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDescriptors(key, data) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(data, key);
  return tx.complete;
}

export async function loadDescriptors(key) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).get(key);

  return new Promise(resolve => {
    req.onsuccess = () => resolve(req.result || null);
  });
}
