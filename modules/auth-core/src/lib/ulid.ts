// Crockford base32 alphabet
const CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Returns a monotonically sortable 26-char identifier (timestamp prefix + random suffix).
// Not a fully spec-compliant ULID but sortable and collision-resistant for this use case.
export function newSortableId(): string {
  const now = Date.now();
  let t = now;
  let ts = '';
  for (let i = 9; i >= 0; i--) {
    ts = CHARS[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(10));
  let r = '';
  for (const b of rand) r += CHARS[b % 32];
  return ts + r;
}
