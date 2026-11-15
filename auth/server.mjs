import { createPrivateKey } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './src/app.mjs'
import { openStore } from './src/store.mjs'

function env(name, fallback) {
  const value = process.env[name]?.trim() || fallback
  if (value === undefined) {
    console.error(`[orca-auth] ${name} is required`)
    process.exit(1)
  }
  return value
}

const issuer = env('AUTH_ISSUER')
if (!/^https:\/\/[^/]+$/.test(issuer) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(issuer)) {
  console.error('[orca-auth] AUTH_ISSUER must be an https origin without a path')
  process.exit(1)
}

const dataDir = env('AUTH_DATA_DIR', './data')
mkdirSync(dataDir, { recursive: true })
const store = openStore(join(dataDir, 'auth.sqlite'))

const { server, kid, purge } = createApp({
  store,
  privateKey: createPrivateKey(env('AUTH_SIGNING_KEY').replace(/\\n/g, '\n')),
  issuer,
  clientId: env('AUTH_CLIENT_ID', 'orca-desktop'),
  orgName: env('AUTH_ORG_NAME', 'Orca Relay'),
  trustProxy: env('AUTH_TRUST_PROXY', '0') === '1',
  // Event name and fields only. Passwords and tokens never reach a log line.
  log: (event, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }))
})

const port = Number(env('PORT', '8080'))
server.listen(port, '::', () => {
  console.log(`[orca-auth] listening on ${port}, issuer ${issuer}, kid ${kid}, users ${store.users().length}`)
  if (store.users().length === 0) {
    console.warn('[orca-auth] no users yet: run `node admin.mjs user add <email>` inside this container')
  }
})

purge()
const purgeTimer = setInterval(purge, 60 * 60 * 1000)
purgeTimer.unref()

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      store.close()
      process.exit(0)
    })
    server.closeAllConnections()
  })
}
