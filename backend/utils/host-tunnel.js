import ngrok from '@ngrok/ngrok';

export default async function hostTunnel(url) {
  const listener = await ngrok.forward({
    addr: url,
    authtoken: '3KJ9pzq9ZWNt08Y0dxNOmX297Gl_6rL7YasMtsBePqFmotL2r',
    verify_upstream_tls: false,
  });
  console.log(`Tunnel established at: ${listener.url()}`);
}
