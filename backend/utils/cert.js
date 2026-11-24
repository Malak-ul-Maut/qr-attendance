import forge from 'node-forge';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Where the local certificate authority (CA) is kept between runs. It has to be a folder that survives a
// reboot, otherwise a new CA is made on every start and a browser that trusted the old one rejects the new one.
//   Windows  %LOCALAPPDATA%                         (unchanged from earlier versions, so an already trusted CA keeps working)
//   macOS    ~/Library/Application Support/qr-attendance
//   Linux    $XDG_DATA_HOME/qr-attendance, else ~/.local/share/qr-attendance
// QR_ATTENDANCE_CERT_DIR overrides all of these.
export function certificateDirectory() {
  if (process.env.QR_ATTENDANCE_CERT_DIR) return path.resolve(process.env.QR_ATTENDANCE_CERT_DIR);
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'qr-attendance');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'qr-attendance');
}

// Windows can add the CA to the current user's trusted roots by itself. macOS and Linux need administrator rights,
// so we print the commands instead of running them. This is only needed to remove the browser warning on the
// computer that runs the server. Phones on the network will still show a warning once.
function trustAdvice(caCertPath) {
  const q = JSON.stringify(caCertPath);
  return [
    '',
    `A new local certificate authority was created: ${caCertPath}`,
    'Your browser will warn about the connection until you trust it. This is optional and affects only this computer:',
    process.platform === 'darwin'
      ? `  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${q}`
      : `  Debian/Ubuntu:  sudo cp ${q} /usr/local/share/ca-certificates/qr-attendance-ca.crt && sudo update-ca-certificates\n` +
        `  Chrome/Chromium (per user):  certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n qr-attendance -i ${q}\n` +
        '  Firefox: Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import',
    '',
  ].join('\n');
}

export function createLocalHttpsOptions(serverIp) {
  const baseDir = certificateDirectory();
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
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

    // The CA key can sign certificates for any site, so only its owner may read it.
    fs.writeFileSync(caCertPath, forge.pki.certificateToPem(caCert));
    fs.writeFileSync(caKeyPath, forge.pki.privateKeyToPem(caKey), { mode: 0o600 });

    if (process.platform === 'win32') {
      try {
        execFileSync('certutil', ['-user', '-addstore', 'Root', caCertPath], { stdio: 'inherit' });
      } catch (err) {
        // Declining the Windows prompt must not stop the server; the browser will just show its warning.
        console.warn(`Could not add the certificate to Windows' trusted roots (${err.message}).`);
        console.warn(`You can add it yourself later: certutil -user -addstore Root "${caCertPath}"`);
      }
    } else {
      console.log(trustAdvice(caCertPath));
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
    altNames.push({ type: 7, ip: serverIp }); // the address phones on the network use, e.g. 192.168.1.20
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
