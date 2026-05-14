export interface SessionInfo {
  sub: string;  // email
  rol: string;  // "user" | "admin"
  iat: number;
  exp: number;
  jti: string;
}

export interface AuthClientConfig {
  hmacSecret: string;          // same HMAC_SECRET as the auth Worker
  cookieName: string;          // "__skeptou_session" | "__glossolalia_session"
  authBaseUrl: string;         // "https://auth.skeptou.com"
  refreshThresholdDays?: number; // default 15
}

// Internal payload shape — mirrors the auth Worker's SessionPayload
export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  rol: string;
  jti: string;
}
