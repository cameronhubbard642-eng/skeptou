/**
 * _shared/validate.js — request-body validation for O&P write handlers.
 *
 * Per specs/op-d1-migration.md rev 3 §IV.6, §XII.5. Unknown fields are
 * stripped (not rejected) so specialist calls keep working as the schema
 * evolves. Enum and FK checks live in op-write.js.
 */

/**
 * Validates a create body against { required, optional }. Returns
 * { ok: true, data } with only allowlisted fields kept, or { ok: false, error }.
 */
export function validateBody(body, schema) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  for (const field of schema.required) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return { ok: false, error: `Missing required field: ${field}` };
    }
  }
  const allowed = new Set([...schema.required, ...(schema.optional || [])]);
  const data = {};
  for (const key of Object.keys(body)) {
    if (allowed.has(key) && body[key] !== undefined) data[key] = body[key];
  }
  return { ok: true, data };
}

/** Returns an object with only the allowlisted fields present in body. */
export function filterAllowedFields(body, allowed) {
  const out = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
  const set = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (set.has(key) && body[key] !== undefined) out[key] = body[key];
  }
  return out;
}
