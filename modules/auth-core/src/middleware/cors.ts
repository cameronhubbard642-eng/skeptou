// Returns permissive CORS headers only for origins within the deployment's cookie domain.
// cookieDomain is e.g. ".skeptou.com"; origin is e.g. "https://phronesis.skeptou.com".
export function corsHeaders(
  request: Request,
  cookieDomain: string,
): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  if (!origin || !isSameDeploymentOrigin(origin, cookieDomain)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function isSameDeploymentOrigin(origin: string, cookieDomain: string): boolean {
  const domain = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  try {
    const { hostname } = new URL(origin);
    return hostname === domain || hostname.endsWith('.' + domain);
  } catch {
    return false;
  }
}
