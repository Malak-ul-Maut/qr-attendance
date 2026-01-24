import ngrok from '@ngrok/ngrok';

export default async function hostTunnel(url) {
  const listener = await ngrok.forward({
    addr: url,
    authtoken: process.env.NGROK_AUTH_TOKEN,
    verify_upstream_tls: false,
  });
  console.log(`Tunnel established at: ${listener.url()}`);
}
