// generate-cert.js
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const attrs = [{ name: 'commonName', value: '10.138.132.200' }]; // your local IP
const pems = selfsigned.generate(attrs, {
  days: 365,
  keySize: 2048,
  algorithm: 'sha256',
});

const certDir = path.join(__dirname);
fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
fs.writeFileSync(path.join(certDir, 'key.pem'), pems.private);

console.log('✅ Certificate generated successfully: cert.pem and key.pem');
