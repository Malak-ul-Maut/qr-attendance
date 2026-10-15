// Puts the local server on the internet. Pick the provider with the TUNNEL environment variable:
//   TUNNEL=ngrok        (default) needs NGROK_AUTHTOKEN. NGROK_DOMAIN=your-name.ngrok-free.app keeps the same address
//                       every time (the free plan includes one domain; see your ngrok dashboard > Domains)
//   TUNNEL=cloudflared  Cloudflare quick tunnel: no account, no domain. Needs the cloudflared program installed.
//   TUNNEL=zrok         needs the zrok program installed and `zrok enable <token>` run once. ZROK_BIN=zrok2 for zrok v2.
//                       ZROK_RESERVED=myname keeps the same address (https://myname.share.zrok.io): create it once with
//                       zrok reserve public https://localhost:4000 --backend-mode proxy --insecure --unique-name myname
//   TUNNEL=none         no tunnel (LAN only)
import { spawn } from 'node:child_process';

const PATTERNS = {
  cloudflared: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  zrok: /https:\/\/[a-z0-9-]+\.[a-z0-9.-]*zrok\.io/i,
};

// Starts a helper program and resolves with the public address it prints.
// If the helper stays running but never prints an address, `assumed` (when given) is used after 4 s.
function runHelper(command, args, pattern, label, assumed) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () =>
        assumed
          ? finish(resolve, assumed)
          : finish(
              reject,
              new Error(`${label} did not print a public address within 30 s`),
            ),
      assumed ? 4000 : 30000,
    );
    const onData = chunk => {
      const match = String(chunk).match(pattern);
      if (match) finish(resolve, match[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', error =>
      finish(
        reject,
        new Error(
          `Could not start "${command}": ${error.message}. Is ${label} installed and on your PATH?`,
        ),
      ),
    );
    child.on('exit', code =>
      finish(reject, new Error(`${label} exited early (code ${code})`)),
    );
    const stop = () => child.kill();
    process.on('exit', stop);
    process.on('SIGINT', () => {
      stop();
      process.exit(0);
    });
  });
}

export default async function hostTunnel(url) {
  const provider = (process.env.TUNNEL || 'ngrok').toLowerCase();
  try {
    if (provider === 'none')
      return console.log(
        'No tunnel (TUNNEL=none). Reachable on the local network only.',
      );

    if (provider === 'cloudflared') {
      const address = await runHelper(
        process.env.CLOUDFLARED_BIN || 'cloudflared',
        ['tunnel', '--no-autoupdate', '--no-tls-verify', '--url', url],
        PATTERNS.cloudflared,
        'cloudflared',
      );
      return console.log(`Tunnel established at: ${address}`);
    }

    if (provider === 'zrok' && process.env.ZROK_RESERVED) {
      const name = process.env.ZROK_RESERVED;
      const address = await runHelper(
        process.env.ZROK_BIN || 'zrok',
        [
          'share',
          'reserved',
          name,
          '--headless',
          ...(process.env.ZROK_SHARE_ARGS
            ? process.env.ZROK_SHARE_ARGS.split(' ')
            : ['--insecure']),
        ],
        PATTERNS.zrok,
        'zrok',
        `https://${name}.share.zrok.io`,
      );
      return console.log(`Tunnel established at: ${address}`);
    }

    if (provider === 'zrok') {
      const address = await runHelper(
        process.env.ZROK_BIN || 'zrok',
        [
          'share',
          'public',
          '--headless',
          '--insecure',
          '--backend-mode',
          'proxy',
          url,
        ],
        PATTERNS.zrok,
        'zrok',
      );
      return console.log(`Tunnel established at: ${address}`);
    }

    // ngrok is loaded only when chosen, so the other providers work without it installed
    const ngrok = (await import('@ngrok/ngrok')).default;
    const listener = await ngrok.forward({
      addr: url,
      authtoken: process.env.NGROK_AUTHTOKEN, // set it in your environment, never in source
      verify_upstream_tls: false,
    });
    console.log(`Tunnel established at: ${listener.url()}`);
  } catch (error) {
    // The server keeps running on the local network even if the tunnel fails
    console.error(`Tunnel (${provider}) failed: ${error.message}`);
  }
}
