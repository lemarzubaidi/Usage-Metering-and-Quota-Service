import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// An API key looks like:  sk_<43 random url-safe characters>   (256 bits of randomness)
// We show it to the caller ONCE and store only its SHA-256 hash.
//
// Why SHA-256 and not bcrypt? bcrypt is slow on purpose to protect LOW-entropy secrets (passwords).
// Our keys are 256 random bits, so brute force is impossible anyway, and a plain deterministic hash
// lets us look the account up with an indexed equality search:  WHERE api_key_hash = $1.
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `sk_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 8) };
}

// Constant-time comparison (used for the admin key, which lives in an environment variable,
// not in the database). Hashing both sides first makes the two buffers the same length.
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

// "Authorization: Bearer <key>"  ->  <key>, or null if the header is missing/malformed.
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}
