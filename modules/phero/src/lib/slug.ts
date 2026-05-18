const RESERVED_SLUGS = new Set([
  'api', 'share', 'manage', 'admin', 'static', 'assets',
  'health', 'robots', 'favicon', 'sitemap', 'login', 'logout',
]);

export function generateRandomSlug(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  // Result: 22-char base64url string encoding 128 bits of CSPRNG output
}

export function validateCustomSlug(slug: string): { valid: boolean; error?: string } {
  if (slug.length < 4 || slug.length > 64) {
    return { valid: false, error: 'slug must be 4–64 characters' };
  }
  if (!/^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/.test(slug)) {
    return {
      valid: false,
      error: 'slug must be lowercase alphanumeric with hyphens; must start and end with alphanumeric',
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { valid: false, error: `'${slug}' is a reserved slug` };
  }
  return { valid: true };
}
