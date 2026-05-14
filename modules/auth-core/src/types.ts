export interface Env {
  AUTH_KV: KVNamespace;
  DEPLOYMENT: string;         // "skeptou" | "glossolalia"
  COOKIE_DOMAIN: string;      // ".skeptou.com" | ".glossolalia.dev"
  BRAND_NAME: string;
  BRAND_URL: string;
  RESEND_FROM: string;
  HMAC_SECRET: string;
  RESEND_API_KEY: string;
  ADMIN_SECRET: string;
  ADMIN_EMAIL?: string;
  PII_MINIMIZE?: string;               // "true" (default) | "false"
  RATE_LIMIT_EMAIL_CAPACITY?: string;  // default "5"
  RATE_LIMIT_IP_CAPACITY?: string;     // default "20"
}

export interface SessionPayload {
  sub: string;  // email (lowercased)
  iat: number;  // issued-at (Unix seconds)
  exp: number;  // absolute expiry (Unix seconds; iat + 90 days)
  rol: string;  // "user" | "admin"
  jti: string;  // 16-byte random nonce (hex)
}

export interface AllowlistEntry {
  email: string;
  added_at: string;
  note?: string;
  active: boolean;
}

export interface MagicTokenEntry {
  email: string;
  created_at: string;
  exp: number;
}

export interface RateLimitBucket {
  tokens: number;
  last_refill: number;
}

export type AuditEvent =
  | 'LOGIN_ATTEMPT_BLOCKED'
  | 'MAGIC_LINK_ISSUED'
  | 'MAGIC_LINK_VERIFIED'
  | 'MAGIC_LINK_EXPIRED'
  | 'SESSION_ISSUED'
  | 'SESSION_RENEWED'
  | 'SESSION_REVOKED'
  | 'SESSION_EXPIRED'
  | 'ADMIN_ALLOWLIST_CREATED'
  | 'ADMIN_ALLOWLIST_UPDATED'
  | 'ADMIN_ALLOWLIST_DELETED'
  | 'RATE_LIMIT_HIT';

export interface AuditEntry {
  id: string;
  ts: string;
  event: AuditEvent;
  sub?: string;
  ip?: string;
  ua?: string;
  deployment: string;
  meta?: Record<string, unknown>;
}
