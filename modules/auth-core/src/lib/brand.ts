export function getCookieName(deployment: string): string {
  return `__${deployment}_session`;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export async function hashString(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

// IPv6 truncated to /48 (first 3 groups); IPv4 returned as-is.
export function sanitizeIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  const parts = ip.split(':');
  return parts.slice(0, 3).join(':') + '::/48';
}

export function truncateUa(ua: string | null): string | undefined {
  if (!ua) return undefined;
  return ua.slice(0, 200);
}
