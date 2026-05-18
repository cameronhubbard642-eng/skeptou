export interface Env {
  PHERO_DB: D1Database;
  ENERGEIA_BASE_URL: string;
  ARISTEIA_BASE_URL: string;
  SHARE_COOKIE_TTL_DAYS: string;
  ENERGEIA_SERVICE_TOKEN: string;
  ARISTEIA_SERVICE_TOKEN: string;
  COOKIE_SIGNING_KEY: string;
  HMAC_SECRET: string;
  AUTH_DOMAIN?: string;
  COOKIE_NAME?: string;
}

export interface ShareRow {
  slug: string;
  source_module: 'energeia' | 'aristeia';
  source_slug: string;
  source_version: string | null;
  label: string | null;
  recipient_email: string | null;
  expires_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
  revoked_at: string | null;
  metadata: string;
}

export interface CreateShareBody {
  source_module: 'energeia' | 'aristeia';
  source_slug: string;
  slug?: string;
  label?: string;
  recipient_email?: string;
  expires_at?: string | null;
  snapshot_mode?: boolean;
}
