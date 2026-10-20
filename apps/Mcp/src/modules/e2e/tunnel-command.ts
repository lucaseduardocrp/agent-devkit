/** Origin of a loopback URL on the user's computer, the only kind of target a tunnel may expose. */
export function localOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a local URL such as http://localhost:5173.');
  }
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('The tunnel target must be an HTTP loopback URL without credentials or query.');
  }
  return url.origin;
}

export function quickTunnelCommand(value: string): string {
  const origin = localOrigin(value);
  return `cloudflared tunnel --url ${origin} --http-host-header ${new URL(origin).host}`;
}
