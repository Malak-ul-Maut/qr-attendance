const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');
const serverIp = getServerIpAddress();

const attrs = [{ name: 'commonName', value: `${serverIp}` }]; // your local IP
const pems = selfsigned.generate(attrs, {
  days: 365,
  keySize: 2048,
  algorithm: 'sha256',
});

const certDir = path.join(__dirname);
fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
fs.writeFileSync(path.join(certDir, 'key.pem'), pems.private);

console.log('✅ Certificate generated successfully: cert.pem and key.pem');


function getServerIpAddress() {
  const networkInterfaces = os.networkInterfaces();
  for (const interfaceName in networkInterfaces) {
    const addresses = networkInterfaces[interfaceName];
    for (const address of addresses) {
      // Filter for IPv4 addresses that are not internal (loopback)
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return null; 
}