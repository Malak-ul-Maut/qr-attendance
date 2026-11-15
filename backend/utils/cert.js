import forge from 'node-forge';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function createLocalHttpsOptions(serverIp) {
  const baseDir = process.env.LOCALAPPDATA || os.tmpdir();
  const caCertPath = path.join(baseDir, 'qr-attendance-ca.crt');
  const caKeyPath = path.join(baseDir, 'qr-attendance-ca.key');

  let caCert, caKey;

  if (fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)) {
    caCert = forge.pki.certificateFromPem(fs.readFileSync(caCertPath, 'utf8'));
    caKey = forge.pki.privateKeyFromPem(fs.readFileSync(caKeyPath, 'utf8'));
  } else {
    // 1. Generate Root CA
    const caKeys = forge.pki.rsa.generateKeyPair(2048);
    caCert = forge.pki.createCertificate();
    caCert.publicKey = caKeys.publicKey;
    caCert.serialNumber = '01';
    caCert.validity.notBefore = new Date();
    caCert.validity.notAfter = new Date();
    caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);

    const caAttrs = [{ name: 'commonName', value: 'QR Attendance Local Dev CA' }];
    caCert.setSubject(caAttrs);
    caCert.setIssuer(caAttrs);
    caCert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ]);
    caCert.sign(caKeys.privateKey, forge.md.sha256.create());
    caKey = caKeys.privateKey;

    const caPem = forge.pki.certificateToPem(caCert);
    fs.writeFileSync(caCertPath, caPem);
    fs.writeFileSync(caKeyPath, forge.pki.privateKeyToPem(caKey));

    if (process.platform === 'win32') {
      execFileSync('certutil', ['-user', '-addstore', 'Root', caCertPath], {
        stdio: 'inherit',
      });
    }
  }

  // 2. Generate Leaf Certificate with proper DNS (type 2) & IP (type 7) SANs
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + 365);

  cert.setSubject([{ name: 'commonName', value: serverIp || 'localhost' }]);
  cert.setIssuer(caCert.subject.attributes);

  const altNames = [
    { type: 2, value: 'localhost' }, // DNS
    { type: 7, ip: '127.0.0.1' },    // IPv4
    { type: 7, ip: '::1' },          // IPv6
  ];
  if (serverIp) {
    altNames.push({ type: 7, ip: serverIp }); // Proper IP SAN for 10.77.169.200
  }

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}
