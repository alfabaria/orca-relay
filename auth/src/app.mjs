// Self-hosted stand-in for Orca Cloud's desktop sign-in, with one account per person.
// Wire contract mirrors stablyai/orca:
//   desktop: src/main/orca-profiles/cloud-auth/profile-cloud-client.ts
//   relay:   cloud/apps/relay/src/authentication/relay-token-verifier.ts
import { createHash, createPublicKey } from 'node:crypto'
import { createServer } from 'node:http'
import { hashPassword, randomToken, sha256b64u, signJwt, verifyJwt, verifyPassword } from './crypto.mjs'
import { LoginThrottle } from './throttle.mjs'

const ACCESS_TTL_S = 60 * 60
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000
const RELAY_TTL_S = 15 * 60
// The desktop retries a refresh whose reply was lost, for up to this long after first use.
const REFRESH_GRACE_MS = 60 * 1000
const CODE_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_CODES = 1000
const MAX_BODY = 64 * 1024
const LOOPBACK_CALLBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\/callback$/
const B64U = /^[A-Za-z0-9_-]+$/
// Browsers also check a form's redirect target against form-action, so the desktop's loopback
// callback must be listed or the sign-in submit is blocked after the password is accepted.
const LOGIN_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:*; frame-ancestors 'none'"

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

class HttpError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

export function createApp({
  store,
  privateKey,
  issuer,
  clientId = 'orca-desktop',
  orgName = 'Orca Relay',
  trustProxy = false,
  now = Date.now,
  log = () => {}
}) {
  const publicKey = createPublicKey(privateKey)
  const jwk = publicKey.export({ format: 'jwk' })
  const kid = sha256b64u(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16)
  const jwks = { keys: [{ ...jwk, kid, alg: 'ES256', use: 'sig' }] }
  const throttle = new LoginThrottle(now)
  const codes = new Map()
  let dummyHash

  const nowS = () => Math.floor(now() / 1000)
  const sign = (claims, ttlS) =>
    signJwt(privateKey, kid, { iss: issuer, iat: nowS(), exp: nowS() + ttlS, jti: randomToken(8), ...claims })

  const org = { orgId: 'default', name: orgName, role: 'Member' }
  const account = (user) => ({
    cloud: {
      cloudProfileId: user.id,
      userId: user.id,
      email: user.email,
      displayName: user.display_name ?? user.email,
      activeOrgId: org.orgId,
      activeOrgName: org.name,
      linkedAt: user.created_at
    },
    organizations: [org],
    // Only relay access: sharing and team features call Orca Cloud APIs this service lacks.
    capabilities: { flags: { 'relay.use': true }, refreshedAt: now() }
  })

  function session(user, familyId, refreshToken) {
    return {
      accessToken: sign({ sub: user.id, typ: 'access', sid: familyId }, ACCESS_TTL_S),
      refreshToken,
      expiresAt: now() + ACCESS_TTL_S * 1000,
      ...account(user)
    }
  }

  function issueRefresh(familyId) {
    const token = randomToken(32)
    store.insertRefresh(sha256b64u(token), familyId, now() + REFRESH_TTL_MS)
    return token
  }

  /** Spends a refresh token and returns its successor, or null if it is not usable. */
  function rotate(refreshToken) {
    const hash = sha256b64u(String(refreshToken ?? ''))
    const row = store.refresh(hash)
    if (!row) return null
    const family = store.family(row.family_id)
    if (!family || family.revoked_at !== null || row.expires_at <= now()) return null
    const user = store.userById(family.user_id)
    if (!user || user.disabled) return null

    if (row.used_at !== null) {
      // Reuse of a spent token. Inside the grace window it is the desktop retrying a lost
      // reply, so supersede the successor it never saw. Later, or if the successor was already
      // spent, treat it as theft and end the whole sign-in.
      const successor = row.replaced_by ? store.refresh(row.replaced_by) : null
      if (now() - row.used_at > REFRESH_GRACE_MS) {
        store.revokeFamily(family.id, now())
        log('refresh_replay_revoked', { user: user.email })
        return null
      }
      if (successor && successor.used_at !== null) return null
      if (successor) store.deleteRefresh(row.replaced_by)
    }
    const next = issueRefresh(family.id)
    store.markRefreshUsed(hash, now(), sha256b64u(next))
    return { user, familyId: family.id, refreshToken: next }
  }

  /** Validates a bearer access token and that its sign-in is still live. */
  function authenticate(req) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const claims = verifyJwt(publicKey, token, nowS())
    // Tokens from an earlier deployment sharing this signing key carry no session id.
    if (!claims || claims.typ !== 'access' || claims.iss !== issuer || typeof claims.sid !== 'string') {
      throw new HttpError(401, 'unauthorized')
    }
    const family = store.family(claims.sid)
    const user = family && family.revoked_at === null ? store.userById(family.user_id) : null
    if (!user || user.disabled || user.id !== claims.sub) throw new HttpError(401, 'unauthorized')
    return { user, familyId: family.id }
  }

  const clientIp = (req) => {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')
      // The reverse proxy appends the real peer last; earlier entries are client-supplied.
      const last = forwarded[forwarded.length - 1].trim()
      if (last) return last
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  async function readBody(req) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > MAX_BODY) throw new HttpError(413, 'body_too_large')
    }
    return raw
  }

  async function readJson(req) {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (body && typeof body === 'object' && !Array.isArray(body)) return body
    } catch (error) {
      if (error instanceof HttpError) throw error
    }
    throw new HttpError(400, 'bad_request')
  }

  function loginPage(params, message) {
    const hidden = [...params]
      .filter(([k]) => k !== 'email' && k !== 'password')
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('')
    const email = esc(params.get('email') ?? '')
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Orca relay sign-in</title>
<style>body{font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
form{display:grid;gap:12px;width:300px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #444;background:#1c1c1c;color:#eee}
button{background:#eee;color:#111;cursor:pointer}p{color:#f77;margin:0}</style>
<form method="post">${hidden}<h2>Orca relay</h2>${message ? `<p>${esc(message)}</p>` : ''}
<input type="email" name="email" placeholder="Email" value="${email}" autocomplete="username" required ${email ? '' : 'autofocus'}>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required ${email ? 'autofocus' : ''}><button>Sign in</button></form>`
  }

  function validateAuthorize(params) {
    const challenge = params.get('code_challenge') ?? ''
    const supplied = params.get('client_id')
    if (
      params.get('response_type') !== 'code' ||
      !LOOPBACK_CALLBACK.test(params.get('redirect_uri') ?? '') ||
      params.get('code_challenge_method') !== 'S256' ||
      !B64U.test(challenge) ||
      challenge.length < 43 ||
      !params.get('state') ||
      (supplied !== null && supplied !== clientId)
    ) {
      throw new HttpError(400, 'invalid_request')
    }
  }

  async function authorize(req, res, url, send) {
    const params = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : url.searchParams
    validateAuthorize(params)
    const html = (status, message) => send(status, loginPage(params, message), 'text/html; charset=utf-8')
    if (req.method !== 'POST') return html(200)

    const email = String(params.get('email') ?? '').trim().toLowerCase()
    const password = String(params.get('password') ?? '')
    params.delete('password')
    const ip = clientIp(req)
    const wait = throttle.check(ip, email)
    if (wait > 0) {
      res.setHeader('retry-after', String(Math.ceil(wait / 1000)))
      return html(429, 'Too many attempts. Try again later.')
    }

    const user = email ? store.userByEmail(email) : null
    // Always run a full hash so unknown accounts and wrong passwords take the same time.
    dummyHash ??= await hashPassword(randomToken(8))
    const valid = await verifyPassword(user?.password_hash ?? dummyHash, password)
    if (!user || user.disabled || !valid) {
      throttle.failure(ip, email)
      log('login_failed', { email, ip })
      return html(401, 'Wrong email or password.')
    }
    throttle.success(email)

    for (const [code, entry] of codes) if (entry.exp <= now()) codes.delete(code)
    if (codes.size >= MAX_PENDING_CODES) throw new HttpError(503, 'busy')
    const code = randomToken(32)
    codes.set(code, {
      userId: user.id,
      challenge: params.get('code_challenge'),
      redirect: params.get('redirect_uri'),
      state: params.get('state'),
      nonce: params.get('nonce'),
      exp: now() + CODE_TTL_MS
    })
    log('login_ok', { email, ip })
    const to = new URL(params.get('redirect_uri'))
    to.searchParams.set('code', code)
    to.searchParams.set('state', params.get('state'))
    res.writeHead(302, { location: to.toString() })
    res.end()
  }

  async function api(req, op) {
    const body = await readJson(req)

    if (op === 'session') {
      const entry = codes.get(body.code)
      codes.delete(body.code) // single use, even when the checks below fail
      const challenge = sha256b64u(String(body.codeVerifier ?? ''))
      if (
        !entry ||
        entry.exp <= now() ||
        entry.redirect !== body.redirectUri ||
        entry.challenge !== challenge ||
        (entry.state && entry.state !== body.state) ||
        (entry.nonce && entry.nonce !== body.nonce)
      ) {
        throw new HttpError(400, 'invalid_grant')
      }
      const user = store.userById(entry.userId)
      if (!user || user.disabled) throw new HttpError(400, 'invalid_grant')
      const familyId = store.createFamily(user.id, now())
      return session(user, familyId, issueRefresh(familyId))
    }

    if (op === 'refresh') {
      const next = rotate(body.refreshToken)
      if (!next) throw new HttpError(401, 'invalid_grant')
      return session(next.user, next.familyId, next.refreshToken)
    }

    if (op === 'logout') {
      const row = store.refresh(sha256b64u(String(body.refreshToken ?? '')))
      if (row) store.revokeFamily(row.family_id, now())
      return {}
    }

    const { user, familyId } = authenticate(req)

    if (op === 'capabilities' || op === 'org') return account(user)

    if (op === 'profile') {
      // Proves the long-lived sign-in, so it must be this sign-in's own refresh token.
      const row = store.refresh(sha256b64u(String(body.refreshToken ?? '')))
      if (!row || row.family_id !== familyId) throw new HttpError(401, 'invalid_grant')
      const next = rotate(body.refreshToken)
      if (!next) throw new HttpError(401, 'invalid_grant')
      return session(next.user, next.familyId, next.refreshToken)
    }

    if (op === 'relay-token') {
      const publicKeyBytes = Buffer.from(String(body.hostPublicKeyB64 ?? ''), 'base64')
      const relayHostId = String(body.relayHostId ?? '')
      const derived = createHash('sha256').update(publicKeyBytes).digest('base64url').slice(0, 16)
      if (publicKeyBytes.length !== 32 || derived !== relayHostId) throw new HttpError(400, 'invalid_host')
      return {
        relayToken: sign(
          { sub: user.id, prof: user.id, org: org.orgId, aud: 'orca-relay', purpose: 'host-control', relayHostId },
          RELAY_TTL_S
        ),
        expiresAt: now() + RELAY_TTL_S * 1000
      }
    }

    throw new HttpError(404, 'not_found')
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        ...(type.startsWith('text/html') ? { 'content-security-policy': LOGIN_CSP } : {})
      })
      res.end(type === 'application/json' ? JSON.stringify(body) : body)
    }
    try {
      const path = url.pathname
      if (path === '/health') return send(200, { ok: true })
      if (path === '/.well-known/jwks.json') return send(200, jwks)
      if (path === '/v1/desktop/auth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
        return await authorize(req, res, url, send)
      }
      if (req.method !== 'POST' || !path.startsWith('/v1/desktop/auth/')) throw new HttpError(404, 'not_found')
      return send(200, await api(req, path.slice('/v1/desktop/auth/'.length)))
    } catch (error) {
      if (error instanceof HttpError) {
        return send(
          error.status,
          error.code === 'invalid_request' ? 'Invalid sign-in request.' : { error: error.code },
          error.code === 'invalid_request' ? 'text/plain' : 'application/json'
        )
      }
      log('internal_error', { message: error.message })
      if (!res.headersSent) send(500, { error: 'server_error' })
    }
  })

  return { server, kid, purge: () => store.purge(now(), 7 * 24 * 60 * 60 * 1000) }
}
