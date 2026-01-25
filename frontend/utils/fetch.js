export default async function postData(url, dataObject) {
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
