// User administration. Run inside the container:
//   docker compose exec auth node admin.mjs <command>
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { hashPassword } from './src/crypto.mjs'
import { openStore } from './src/store.mjs'

const USAGE = `usage: node admin.mjs <command>

  user add <email> [--name <display name>] [--generate]
  user passwd <email> [--generate]
  user list
  user disable <email>      block sign-in and end every session
  user enable <email>
  user revoke <email>       end every session, keep the account
  user remove <email>       delete the account and its sessions

Passwords are read from the terminal (hidden), or from the first line of stdin when piped.
--generate creates a random password and prints it once.`

const MIN_PASSWORD = 12
const day = (ms) => new Date(ms).toISOString().slice(0, 10)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function prompt(label) {
  return new Promise((resolve) => {
    const muted = new Writable({ write: (_chunk, _enc, done) => done() })
    const rl = createInterface({ input: process.stdin, output: process.stdin.isTTY ? muted : undefined, terminal: Boolean(process.stdin.isTTY) })
    if (process.stdin.isTTY) process.stdout.write(label)
    rl.question('', (answer) => {
      if (process.stdin.isTTY) process.stdout.write('\n')
      rl.close()
      resolve(answer)
    })
  })
}

async function readPassword(flags) {
  if (flags.generate) return { password: randomBytes(15).toString('base64url'), generated: true }
  const password = await prompt('Password: ')
  if (process.stdin.isTTY && (await prompt('Repeat password: ')) !== password) fail('Passwords do not match.')
  return { password, generated: false }
}

function parse(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--generate') flags.generate = true
    else if (argv[i] === '--name') flags.name = argv[++i]
    else positional.push(argv[i])
  }
  return { positional, flags }
}

const { positional, flags } = parse(process.argv.slice(2))
const [group, command, rawEmail] = positional
if (group !== 'user' || !command) fail(USAGE)

const store = openStore(join(process.env.AUTH_DATA_DIR || './data', 'auth.sqlite'))
const email = rawEmail?.trim().toLowerCase()

function existing() {
  if (!email) fail(USAGE)
  return store.userByEmail(email) ?? fail(`No such user: ${email}`)
}

async function newPassword() {
  const { password, generated } = await readPassword(flags)
  if (password.length < MIN_PASSWORD) fail(`Password must be at least ${MIN_PASSWORD} characters.`)
  return { hash: await hashPassword(password), password, generated }
}

if (command === 'list') {
  for (const user of store.users()) {
    const sessions = store.activeSessions(user.id)
    console.log(`${user.email}\t${user.disabled ? 'disabled' : 'active'}\tsessions=${sessions}\tcreated=${day(user.created_at)}`)
  }
} else if (command === 'add') {
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) fail('A valid email is required.')
  if (store.userByEmail(email)) fail(`User already exists: ${email}`)
  const { hash, password, generated } = await newPassword()
  store.createUser({ email, displayName: flags.name, passwordHash: hash, now: Date.now() })
  console.log(`Added ${email}`)
  if (generated) console.log(`Password (shown once): ${password}`)
} else if (command === 'passwd') {
  const user = existing()
  const { hash, password, generated } = await newPassword()
  store.setPassword(user.id, hash)
  store.revokeUserSessions(user.id, Date.now())
  console.log(`Password changed for ${email}; existing sessions ended.`)
  if (generated) console.log(`Password (shown once): ${password}`)
} else if (command === 'disable') {
  const user = existing()
  store.setDisabled(user.id, true)
  store.revokeUserSessions(user.id, Date.now())
  console.log(`Disabled ${email}; sessions ended. Relay access stops within 15 minutes.`)
} else if (command === 'enable') {
  store.setDisabled(existing().id, false)
  console.log(`Enabled ${email}`)
} else if (command === 'revoke') {
  const ended = store.revokeUserSessions(existing().id, Date.now())
  console.log(`Ended ${ended} session(s) for ${email}. Relay access stops within 15 minutes.`)
} else if (command === 'remove') {
  store.deleteUser(existing().id)
  console.log(`Removed ${email}`)
} else {
  fail(USAGE)
}
store.close()
