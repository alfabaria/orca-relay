import { createHash, randomBytes, scrypt, sign, timingSafeEqual, verify } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

// scrypt: N=2^15, r=8, p=1 uses 32 MiB per hash. maxmem leaves headroom above that.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }

export const b64u = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

export const sha256b64u = (value) => createHash('sha256').update(value).digest('base64url')

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

export async function verifyPassword(stored, password) {
  const parts = String(stored).split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, hash] = parts
  const expected = Buffer.from(hash, 'base64')
  const derived = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem
  })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

export function signJwt(privateKey, kid, claims) {
  const body = `${b64u({ alg: 'ES256', typ: 'JWT', kid })}.${b64u(claims)}`
  const signature = sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${body}.${signature.toString('base64url')}`
}

/** Returns the claims of a validly signed, unexpired token, else null. */
export function verifyJwt(publicKey, token, nowSeconds) {
  const [header, payload, signature] = String(token ?? '').split('.')
  if (!signature) return null
  try {
    const ok = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    )
    if (!ok) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url'))
    return typeof claims.exp === 'number' && claims.exp > nowSeconds ? claims : null
  } catch {
    return null
  }
}
