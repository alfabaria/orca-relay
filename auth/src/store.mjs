import { DatabaseSync } from 'node:sqlite'
import { randomToken } from './crypto.mjs'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS families_user ON families(user_id);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_by TEXT
);
CREATE INDEX IF NOT EXISTS refresh_family ON refresh_tokens(family_id);
`

/** Times are Unix milliseconds. Only token hashes are stored, never token values. */
export function openStore(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)

  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    users: db.prepare('SELECT * FROM users ORDER BY created_at'),
    insertUser: db.prepare(
      'INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    ),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    setDisabled: db.prepare('UPDATE users SET disabled = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insertFamily: db.prepare('INSERT INTO families (id, user_id, created_at) VALUES (?, ?, ?)'),
    family: db.prepare('SELECT * FROM families WHERE id = ?'),
    revokeFamily: db.prepare('UPDATE families SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    revokeUserFamilies: db.prepare(
      'UPDATE families SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ),
    insertRefresh: db.prepare(
      'INSERT INTO refresh_tokens (hash, family_id, expires_at) VALUES (?, ?, ?)'
    ),
    refresh: db.prepare('SELECT * FROM refresh_tokens WHERE hash = ?'),
    markUsed: db.prepare(
      'UPDATE refresh_tokens SET used_at = COALESCE(used_at, ?), replaced_by = ? WHERE hash = ?'
    ),
    deleteRefresh: db.prepare('DELETE FROM refresh_tokens WHERE hash = ?'),
    activeSessions: db.prepare(
      'SELECT COUNT(*) AS n FROM families WHERE user_id = ? AND revoked_at IS NULL'
    ),
    purgeTokens: db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?'),
    purgeFamilies: db.prepare(
      'DELETE FROM families WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR NOT EXISTS (SELECT 1 FROM refresh_tokens t WHERE t.family_id = families.id)'
    )
  }

  return {
    close: () => db.close(),
    userById: (id) => q.userById.get(id) ?? null,
    userByEmail: (email) => q.userByEmail.get(email) ?? null,
    users: () => q.users.all(),
    createUser({ email, displayName, passwordHash, now }) {
      const id = randomToken(12)
      q.insertUser.run(id, email, displayName ?? null, passwordHash, now)
      return q.userById.get(id)
    },
    setPassword: (id, hash) => q.setPassword.run(hash, id),
    setDisabled: (id, disabled) => q.setDisabled.run(disabled ? 1 : 0, id),
    deleteUser: (id) => q.deleteUser.run(id),
    createFamily(userId, now) {
      const id = randomToken(12)
      q.insertFamily.run(id, userId, now)
      return id
    },
    family: (id) => q.family.get(id) ?? null,
    revokeFamily: (id, now) => q.revokeFamily.run(now, id),
    revokeUserSessions: (userId, now) => Number(q.revokeUserFamilies.run(now, userId).changes),
    activeSessions: (userId) => q.activeSessions.get(userId).n,
    insertRefresh: (hash, familyId, expiresAt) => q.insertRefresh.run(hash, familyId, expiresAt),
    refresh: (hash) => q.refresh.get(hash) ?? null,
    markRefreshUsed: (hash, now, replacedBy) => q.markUsed.run(now, replacedBy, hash),
    deleteRefresh: (hash) => q.deleteRefresh.run(hash),
    /** Drops expired tokens, then revoked or token-less families. */
    purge(now, keepRevokedMs) {
      q.purgeTokens.run(now)
      q.purgeFamilies.run(now - keepRevokedMs)
    }
  }
}
