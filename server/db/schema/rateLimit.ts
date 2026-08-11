import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// Fixed-window counters, D1-backed (ADR-0009). One row per key; the window
// resets in place when it lapses. Stale rows swept by the scheduled task.
export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(), // e.g. 'login:ip:1.2.3.4', 'login:acct:<id>'
  windowStart: integer('window_start').notNull(), // epoch ms
  count: integer('count').notNull().default(0),
})
