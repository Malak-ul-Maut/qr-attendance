import ngrok from '@ngrok/ngrok';

export default async function hostTunnel(url) {
  const listener = await ngrok.forward({
    addr: url,
    authtoken: process.env.NGROK_AUTHTOKEN, // set it in your environment, never in source
    verify_upstream_tls: false,
  });
  console.log(`Tunnel established at: ${listener.url()}`);
}
