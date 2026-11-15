import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createApp } from '../src/app.mjs'
import { hashPassword, signJwt, verifyJwt } from '../src/crypto.mjs'
import { openStore } from '../src/store.mjs'

const ISSUER = 'https://auth.example.com'
const PASSWORD = 'correct horse battery'
const REDIRECT = 'http://127.0.0.1:53211/auth/callback'
const b64u = (buf) => Buffer.from(buf).toString('base64url')

let ctx

async function start(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-auth-'))
  const store = openStore(join(dir, 'auth.sqlite'))
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const clock = { t: 1_800_000_000_000 }
  const { server } = createApp({ store, privateKey, issuer: ISSUER, now: () => clock.t, trustProxy: true, ...options })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const hash = await hashPassword(PASSWORD)
  const users = {}
  for (const email of ['alice@example.com', 'bob@example.com']) {
    users[email] = store.createUser({ email, displayName: email.split('@')[0], passwordHash: hash, now: clock.t })
  }
  const publicKey = createPublicKey(privateKey)
  return { dir, store, server, base, clock, users, publicKey, privateKey }
}

function pkce() {
  const verifier = b64u(randomBytes(32))
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()), state: b64u(randomBytes(16)) }
}

async function login(email, password, { ip = '203.0.113.7', redirect = REDIRECT, ...p } = pkce()) {
  const body = new URLSearchParams({
    client_id: 'orca-desktop',
    response_type: 'code',
    redirect_uri: redirect,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    email,
    password
  })
  const res = await fetch(`${ctx.base}/v1/desktop/auth/authorize`, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: { 'x-forwarded-for': `198.51.100.1, ${ip}` }
  })
  return { res, p }
}

const post = (path, body, token) =>
  fetch(`${ctx.base}/v1/desktop/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })

async function signIn(email = 'alice@example.com', ip) {
  const { res, p } = await login(email, PASSWORD, { ...pkce(), ip })
  assert.equal(res.status, 302)
  const location = new URL(res.headers.get('location'))
  assert.equal(location.searchParams.get('state'), p.state)
  const exchange = await post('session', {
    code: location.searchParams.get('code'),
    codeVerifier: p.verifier,
    redirectUri: REDIRECT,
    state: p.state,
    nonce: 'n',
    localProfileId: 'local'
  })
  assert.equal(exchange.status, 200)
  return exchange.json()
}

beforeEach(async () => {
  ctx = await start()
})
afterEach(async () => {
  await new Promise((resolve) => ctx.server.close(resolve))
  ctx.server.closeAllConnections?.()
  ctx.store.close()
  rmSync(ctx.dir, { recursive: true, force: true })
})

describe('sign-in', () => {
  it('returns a session the desktop accepts, then a relay token the relay accepts', async () => {
    const session = await signIn()
    assert.equal(session.cloud.email, 'alice@example.com')
    assert.equal(session.cloud.userId, ctx.users['alice@example.com'].id)
    assert.equal(session.capabilities.flags['relay.use'], true)
    assert.ok(session.expiresAt > ctx.clock.t)

    const hostKey = randomBytes(32)
    const relayHostId = createHash('sha256').update(hostKey).digest('base64url').slice(0, 16)
    const res = await post('relay-token', { relayHostId, hostPublicKeyB64: hostKey.toString('base64') }, session.accessToken)
    assert.equal(res.status, 200)
    const { relayToken, expiresAt } = await res.json()
    assert.ok(expiresAt > ctx.clock.t)

    // The claims cloud/apps/relay/src/authentication/relay-token-verifier.ts requires.
    const claims = verifyJwt(ctx.publicKey, relayToken, ctx.clock.t / 1000)
    assert.equal(claims.iss, ISSUER)
    assert.equal(claims.aud, 'orca-relay')
    assert.equal(claims.purpose, 'host-control')
    assert.equal(claims.relayHostId, relayHostId)
    assert.equal(claims.sub, ctx.users['alice@example.com'].id)
    assert.equal(claims.prof, claims.sub)
  })

  it('gives each person a distinct relay identity', async () => {
    const [a, b] = [await signIn('alice@example.com'), await signIn('bob@example.com')]
    const hostKey = randomBytes(32)
    const relayHostId = createHash('sha256').update(hostKey).digest('base64url').slice(0, 16)
    const subs = []
    for (const s of [a, b]) {
      const { relayToken } = await (
        await post('relay-token', { relayHostId, hostPublicKeyB64: hostKey.toString('base64') }, s.accessToken)
      ).json()
      subs.push(verifyJwt(ctx.publicKey, relayToken, ctx.clock.t / 1000).sub)
    }
    assert.notEqual(subs[0], subs[1])
  })

  it('rejects a relay token request whose host id is not derived from the key', async () => {
    const session = await signIn()
    const res = await post(
      'relay-token',
      { relayHostId: 'AAAAAAAAAAAAAAAA', hostPublicKeyB64: randomBytes(32).toString('base64') },
      session.accessToken
    )
    assert.equal(res.status, 400)
  })

  it('does not let an access token pass as a relay token', async () => {
    const session = await signIn()
    const claims = verifyJwt(ctx.publicKey, session.accessToken, ctx.clock.t / 1000)
    assert.equal(claims.aud, undefined)
    assert.notEqual(claims.purpose, 'host-control')
  })

  it('answers wrong password and unknown account identically and issues no code', async () => {
    const wrong = await login('alice@example.com', 'not the password')
    const unknown = await login('nobody@example.com', PASSWORD)
    for (const { res } of [wrong, unknown]) {
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('location'), null)
    }
    // The page echoes the submitted email and PKCE values, so compare the verdict, not the bytes.
    const message = (html) => /<p>([^<]*)<\/p>/.exec(html)?.[1]
    assert.equal(message(await wrong.res.text()), 'Wrong email or password.')
    assert.equal(message(await unknown.res.text()), 'Wrong email or password.')
  })

  it('refuses a callback that is not the desktop loopback listener', async () => {
    for (const redirect of ['https://evil.example/cb', 'http://127.0.0.1.evil.example:80/auth/callback', 'http://localhost:5000/auth/callback']) {
      const { res } = await login('alice@example.com', PASSWORD, { ...pkce(), redirect })
      assert.equal(res.status, 400)
    }
  })

  it('binds a code to its PKCE verifier and spends it once', async () => {
    const { res, p } = await login('alice@example.com', PASSWORD)
    const code = new URL(res.headers.get('location')).searchParams.get('code')
    const exchange = (verifier) =>
      post('session', { code, codeVerifier: verifier, redirectUri: REDIRECT, state: p.state, nonce: 'n' })
    assert.equal((await exchange(b64u(randomBytes(32)))).status, 400)
    // The failed attempt spent the code, so even the right verifier is refused now.
    assert.equal((await exchange(p.verifier)).status, 400)
  })

  it('throttles an address after repeated failures and a hammered account with growing delays', async () => {
    for (let i = 0; i < 10; i += 1) assert.equal((await login(`nobody${i}@example.com`, 'x', { ...pkce(), ip: '192.0.2.9' })).res.status, 401)
    const blocked = await login('alice@example.com', PASSWORD, { ...pkce(), ip: '192.0.2.9' })
    assert.equal(blocked.res.status, 429)
    assert.ok(Number(blocked.res.headers.get('retry-after')) > 0)

    // A different address can still sign in, until that account has failed repeatedly.
    for (let i = 0; i < 6; i += 1) await login('bob@example.com', 'wrong', { ...pkce(), ip: `192.0.2.${20 + i}` })
    const delayed = await login('bob@example.com', PASSWORD, { ...pkce(), ip: '192.0.2.99' })
    assert.equal(delayed.res.status, 429)
    ctx.clock.t += 60_000
    assert.equal((await login('bob@example.com', PASSWORD, { ...pkce(), ip: '192.0.2.99' })).res.status, 302)
  })

  it('does not trust client-supplied forwarding entries for throttling', async () => {
    // The proxy appends the real peer last; spoofed leading entries must not dodge the limit.
    for (let i = 0; i < 10; i += 1) {
      const { res } = await login(`nobody${i}@example.com`, 'x', { ...pkce(), ip: '192.0.2.50' })
      assert.equal(res.status, 401)
    }
    const spoofed = await fetch(`${ctx.base}/v1/desktop/auth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'x-forwarded-for': '203.0.113.200, 192.0.2.50' },
      body: new URLSearchParams({
        response_type: 'code', redirect_uri: REDIRECT, code_challenge: pkce().challenge,
        code_challenge_method: 'S256', state: 's', email: 'alice@example.com', password: PASSWORD
      })
    })
    assert.equal(spoofed.status, 429)
  })
})

describe('refresh tokens', () => {
  const refresh = (token) => post('refresh', { refreshToken: token })

  it('rotates on every refresh', async () => {
    const s = await signIn()
    const r1 = await (await refresh(s.refreshToken)).json()
    assert.notEqual(r1.refreshToken, s.refreshToken)
    assert.equal((await refresh(r1.refreshToken)).status, 200)
  })

  it('lets the desktop retry a lost reply, then retires the token it never saw', async () => {
    const s = await signIn()
    const lost = await (await refresh(s.refreshToken)).json() // reply "lost"
    ctx.clock.t += 20_000
    const retry = await refresh(s.refreshToken)
    assert.equal(retry.status, 200)
    assert.equal((await refresh(lost.refreshToken)).status, 401)
    assert.equal((await refresh((await retry.json()).refreshToken)).status, 200)
  })

  it('ends the whole sign-in when a spent token is replayed after the grace window', async () => {
    const s = await signIn()
    const next = await (await refresh(s.refreshToken)).json()
    ctx.clock.t += 61_000
    assert.equal((await refresh(s.refreshToken)).status, 401)
    assert.equal((await refresh(next.refreshToken)).status, 401)
    assert.equal((await post('capabilities', {}, next.accessToken)).status, 401)
  })

  it('rejects expired refresh tokens', async () => {
    const s = await signIn()
    ctx.clock.t += 91 * 24 * 60 * 60 * 1000
    assert.equal((await refresh(s.refreshToken)).status, 401)
  })

  it('logout ends that sign-in only', async () => {
    const a = await signIn('alice@example.com')
    const a2 = await signIn('alice@example.com')
    assert.equal((await post('logout', { refreshToken: a.refreshToken }, a.accessToken)).status, 200)
    assert.equal((await refresh(a.refreshToken)).status, 401)
    assert.equal((await post('capabilities', {}, a.accessToken)).status, 401)
    assert.equal((await post('capabilities', {}, a2.accessToken)).status, 200)
  })

  it('refuses profile calls carrying another sign-in refresh token', async () => {
    const a = await signIn('alice@example.com')
    const b = await signIn('bob@example.com')
    assert.equal((await post('profile', { refreshToken: b.refreshToken }, a.accessToken)).status, 401)
  })
})

describe('legacy tokens', () => {
  it('answers 401, not 500, to a validly signed access token without a session id', async () => {
    // A previous deployment that shared the signing key issued tokens like this.
    const { privateKey } = ctx
    const legacy = signJwt(privateKey, 'k', {
      iss: ISSUER, sub: 'owner', typ: 'access', iat: ctx.clock.t / 1000, exp: ctx.clock.t / 1000 + 3600
    })
    for (const path of ['capabilities', 'org', 'relay-token']) {
      assert.equal((await post(path, {}, legacy)).status, 401, path)
    }
  })
})

describe('malformed input', () => {
  it('answers 4xx, never 500, to missing or non-string fields on every endpoint', async () => {
    const session = await signIn()
    const junk = [{}, { code: 123, codeVerifier: {}, redirectUri: [], state: 1 }, { refreshToken: 123 },
      { refreshToken: { a: 1 } }, { refreshToken: null }, { relayHostId: 5, hostPublicKeyB64: [] }, []]
    for (const path of ['session', 'refresh', 'logout', 'capabilities', 'org', 'profile', 'relay-token', 'nope']) {
      for (const body of junk) {
        for (const token of [undefined, session.accessToken, 'garbage']) {
          const res = await post(path, body, token)
          assert.ok(res.status >= 200 && res.status < 500, `${path} ${JSON.stringify(body)} -> ${res.status}`)
          await res.arrayBuffer()
        }
      }
    }
    const notJson = await fetch(`${ctx.base}/v1/desktop/auth/refresh`, { method: 'POST', body: '{nope' })
    assert.equal(notJson.status, 400)
  })

  it('answers 400, never 500, to a sign-in form with missing or repeated fields', async () => {
    const base = { response_type: 'code', redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', state: 's' }
    for (const extra of [{}, { email: 'alice@example.com' }, { password: 'x' }, { email: '', password: '' }]) {
      const res = await fetch(`${ctx.base}/v1/desktop/auth/authorize`, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...base, ...extra })
      })
      assert.ok(res.status < 500, JSON.stringify(extra) + ' -> ' + res.status)
      await res.arrayBuffer()
    }
  })
})

describe('administration effects', () => {
  it('stops an existing session the moment the user is disabled', async () => {
    const s = await signIn()
    assert.equal((await post('capabilities', {}, s.accessToken)).status, 200)
    ctx.store.setDisabled(ctx.users['alice@example.com'].id, true)
    assert.equal((await post('capabilities', {}, s.accessToken)).status, 401)
    assert.equal((await post('refresh', { refreshToken: s.refreshToken })).status, 401)
    assert.equal((await login('alice@example.com', PASSWORD)).res.status, 401)
  })

  it('revokes every session of one user and leaves others', async () => {
    const a1 = await signIn('alice@example.com')
    const a2 = await signIn('alice@example.com')
    const b = await signIn('bob@example.com')
    assert.equal(ctx.store.revokeUserSessions(ctx.users['alice@example.com'].id, ctx.clock.t), 2)
    for (const s of [a1, a2]) assert.equal((await post('capabilities', {}, s.accessToken)).status, 401)
    assert.equal((await post('capabilities', {}, b.accessToken)).status, 200)
  })
})
