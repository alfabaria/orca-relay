// In-memory sign-in throttling, per client address and per account.
//   - Per address: 10 failures in 15 minutes blocks that address until the window ends.
//   - Per account: after 5 failures each further attempt waits 2^(failures-5) seconds
//     (capped at 15 minutes) from the last failure. Delaying instead of locking means an
//     attacker cannot permanently lock a user out.
// Success clears the account counter, not the address counter.

const WINDOW_MS = 15 * 60 * 1000
const IP_MAX_FAILURES = 10
const ACCOUNT_FREE_FAILURES = 5
const MAX_ENTRIES = 10_000

export class LoginThrottle {
  #ips = new Map()
  #accounts = new Map()
  #now

  constructor(now = Date.now) {
    this.#now = now
  }

  /** Returns 0 when the attempt may proceed, else the milliseconds to wait. */
  check(ip, account) {
    const now = this.#now()
    const ipEntry = this.#live(this.#ips, ip, now)
    if (ipEntry && ipEntry.count >= IP_MAX_FAILURES) return ipEntry.first + WINDOW_MS - now
    const acct = this.#live(this.#accounts, account, now)
    if (acct && acct.count > ACCOUNT_FREE_FAILURES) {
      const delay = Math.min(2 ** (acct.count - ACCOUNT_FREE_FAILURES) * 1000, WINDOW_MS)
      return Math.max(0, acct.last + delay - now)
    }
    return 0
  }

  failure(ip, account) {
    const now = this.#now()
    for (const [map, key] of [
      [this.#ips, ip],
      [this.#accounts, account]
    ]) {
      const entry = this.#live(map, key, now)
      if (entry) {
        entry.count += 1
        entry.last = now
      } else {
        if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value)
        map.set(key, { count: 1, first: now, last: now })
      }
    }
  }

  success(account) {
    this.#accounts.delete(account)
  }

  #live(map, key, now) {
    const entry = map.get(key)
    if (entry && now - entry.first >= WINDOW_MS) {
      map.delete(key)
      return undefined
    }
    return entry
  }
}
